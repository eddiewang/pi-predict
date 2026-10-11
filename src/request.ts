/**
 * One prediction request (plan D1-D4): the session model, the session id, the copy of the last request, then the
 * instruction. The options keep the cached prefix:
 *
 * - Effort (D2). A change to the request's thinking or effort settings invalidates Anthropic's message cache. A
 *   model with `supportsMidConvoEffort` keeps those settings and carries the active effort as a trailing system
 *   message, so the prediction asks for "low". Any other model gets the session's thinking level.
 * - Output cap (D3). Anthropic's budget-based thinking derives `budget_tokens` from `max_tokens`, which keys the
 *   cache, so such a model gets no prediction (the cache warmer's `isReplayable` rule). Otherwise the cap bounds
 *   the price; it is not part of the cached prompt.
 * - No `toolChoice` (D3): a change to it invalidates the message cache. A tool call in the reply is a failure.
 */

import {
	type Api,
	type AssistantMessage,
	calculateCost,
	type Message,
	type Model,
	type Usage,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { checkPrefix, type PrefixCheck, supportsPrefixGuard } from "./guard.ts";
import { parsePrediction } from "./prompt.ts";

/** Output cap when the effort goes in the transcript or the model does not think. */
export const LOW_EFFORT_MAX_TOKENS = 2_048;
/** Output cap when the prediction must keep the session's thinking level. */
export const SESSION_EFFORT_MAX_TOKENS = 8_192;
/** Pi waits this long for a prediction; the owner reads the reply meanwhile. */
export const REQUEST_TIMEOUT_MS = 45_000;

type SessionThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;
/** A request's reasoning level: the session's level without "off". */
type ThinkingLevel = Exclude<SessionThinkingLevel, "off">;

interface ModelCompat {
	supportsMidConvoEffort?: boolean;
	forceAdaptiveThinking?: boolean;
}

export type RequestPlan =
	| { ok: true; reasoning: ThinkingLevel | undefined; maxTokens: number }
	| { ok: false; reason: string };

/** The cache-safe options for this model and thinking level, or why the model gets no prediction. */
export function planRequest(model: Model<Api>, thinkingLevel: SessionThinkingLevel): RequestPlan {
	if (!supportsPrefixGuard(model.api)) return { ok: false, reason: `no prefix check for the "${model.api}" API` };
	const compat = (model.compat ?? {}) as ModelCompat;
	const reasoning = thinkingLevel === "off" ? undefined : thinkingLevel;
	if (compat.supportsMidConvoEffort === true) return { ok: true, reasoning: "low", maxTokens: LOW_EFFORT_MAX_TOKENS };
	if (!reasoning) return { ok: true, reasoning: undefined, maxTokens: LOW_EFFORT_MAX_TOKENS };
	if (model.api === "anthropic-messages" && compat.forceAdaptiveThinking !== true) {
		return { ok: false, reason: "budget-based thinking: a lower output cap changes the cache key" };
	}
	return { ok: true, reasoning, maxTokens: SESSION_EFFORT_MAX_TOKENS };
}

/**
 * The highest expected price in dollars (plan D9a): the last prompt read from the cache, the new tail written to
 * it (or read as input when the model has no write price), and the whole output cap.
 */
export function estimateCost(model: Model<Api>, promptTokens: number, tailChars: number, maxTokens: number): number {
	const tailTokens = Math.ceil(tailChars / 4);
	const writePrice = model.cost.cacheWrite > 0 ? model.cost.cacheWrite : model.cost.input;
	return (promptTokens * model.cost.cacheRead + tailTokens * writePrice + maxTokens * model.cost.output) / 1_000_000;
}

/** The share of the prompt that the provider read from its cache. */
export function cacheReadRatio(usage: Pick<Usage, "input" | "cacheRead" | "cacheWrite">): number {
	const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
	return prompt > 0 ? usage.cacheRead / prompt : 0;
}

export function costOf(model: Model<Api>, message: AssistantMessage): number {
	const reported = message.usage.cost?.total ?? 0;
	return reported > 0 ? reported : calculateCost(model, message.usage).total;
}

export type FailureReason =
	| "prefix_mismatch"
	| "unguarded"
	| "request_failed"
	| "cancelled"
	| "timeout"
	| "length"
	| "tool_call"
	| "too_long";

export type RequestResult =
	| { kind: "completed"; text: string | null; message: AssistantMessage }
	| { kind: "failed"; reason: FailureReason; detail?: string; message?: AssistantMessage };

export interface PredictionRequest {
	ctx: Pick<ExtensionContext, "modelRegistry" | "sessionManager">;
	model: Model<Api>;
	messages: Message[];
	reasoning: ThinkingLevel | undefined;
	maxTokens: number;
	/** The payload of the session's last request (plan D4). */
	mainPayload: unknown;
	signal: AbortSignal;
}

class PrefixMismatch extends Error {}

function textOf(message: AssistantMessage): string {
	return message.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("");
}

export async function requestPrediction(request: PredictionRequest): Promise<RequestResult> {
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	const signal = AbortSignal.any([request.signal, timeout]);
	let check: PrefixCheck | undefined;
	let message: AssistantMessage;
	try {
		message = await request.ctx.modelRegistry
			.streamSimple(
				request.model,
				{ messages: request.messages },
				{
					sessionId: request.ctx.sessionManager.getSessionId(),
					reasoning: request.reasoning,
					maxTokens: request.maxTokens,
					maxRetries: 0,
					signal,
					// The provider awaits this before it sends anything; a throw here sends nothing.
					onPayload: (payload, model) => {
						check = checkPrefix(model.api, request.mainPayload, payload);
						if (!check.ok) throw new PrefixMismatch(check.reason);
						return undefined;
					},
				},
			)
			.result();
	} catch (error) {
		if (check && !check.ok) return { kind: "failed", reason: "prefix_mismatch", detail: check.reason };
		if (request.signal.aborted) return { kind: "failed", reason: "cancelled" };
		if (timeout.aborted) return { kind: "failed", reason: "timeout" };
		return {
			kind: "failed",
			reason: "request_failed",
			detail: error instanceof Error ? error.message : String(error),
		};
	}
	if (check && !check.ok) return { kind: "failed", reason: "prefix_mismatch", detail: check.reason, message };
	if (message.stopReason === "aborted") {
		return { kind: "failed", reason: request.signal.aborted ? "cancelled" : "timeout", message };
	}
	if (message.stopReason === "error") {
		return { kind: "failed", reason: "request_failed", detail: message.errorMessage, message };
	}
	// The guard runs in every provider that the plan supports. A request that reached the provider without it
	// was not checked, so its result is not trusted either.
	if (!check) return { kind: "failed", reason: "unguarded", detail: "the provider gave no payload", message };
	if (message.stopReason === "length") return { kind: "failed", reason: "length", message };
	if (message.stopReason === "toolUse" || message.content.some((part) => part.type === "toolCall")) {
		return { kind: "failed", reason: "tool_call", message };
	}
	const parsed = parsePrediction(textOf(message));
	if (!parsed.ok) return { kind: "failed", reason: parsed.reason, message };
	return { kind: "completed", text: parsed.text, message };
}
