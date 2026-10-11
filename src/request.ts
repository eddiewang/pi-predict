/**
 * One prediction request (design D1-D4): the session model, the session id, the copy of the last request, then the
 * instruction. The options keep the cached prefix:
 *
 * - Effort (D2). A change to the request's thinking or effort settings invalidates Anthropic's message cache. A
 *   model with `supportsMidConvoEffort` keeps those settings and carries the active effort as a trailing system
 *   message, so the prediction asks for "low". Any other model gets the session's thinking level.
 * - Output cap (D3). Anthropic's budget-based thinking derives `budget_tokens` from `max_tokens`, which keys the
 *   cache, so such a model gets no prediction (the cache warmer's `isReplayable` rule). Otherwise the cap bounds
 *   the price; it is not part of the cached prompt. A provider can send another cap or none, so the price check
 *   runs again in `onPayload` with the cap of the payload itself (D9a).
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
/** Pi waits this long for a prediction; the user reads the reply meanwhile. */
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

interface Rates {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

/** Request-wide price tiers (pi-ai 1.x): the tier with the highest threshold below the request's input applies. */
type Tier = Rates & { inputTokensAbove: number };

function ratesFor(model: Model<Api>, inputTokens: number): Rates {
	let rates: Rates = model.cost;
	let threshold = -1;
	for (const tier of (model.cost as { tiers?: Tier[] }).tiers ?? []) {
		if (inputTokens > tier.inputTokensAbove && tier.inputTokensAbove > threshold) {
			rates = tier;
			threshold = tier.inputTokensAbove;
		}
	}
	return rates;
}

/**
 * The highest expected price in dollars (design D9a): the last prompt read from the cache, the new tail written to
 * it, and the whole output cap, at the price tier of the request's size. A model without a cache-read price pays
 * the input price for the prompt, and one without a cache-write price pays it for the tail. An unbounded output
 * (`Infinity`) makes the estimate infinite, unless output is free.
 */
export function estimateCost(model: Model<Api>, promptTokens: number, tailChars: number, maxTokens: number): number {
	const tailTokens = Math.ceil(tailChars / 4);
	const rates = ratesFor(model, promptTokens + tailTokens);
	const readPrice = rates.cacheRead > 0 ? rates.cacheRead : rates.input;
	const writePrice = rates.cacheWrite > 0 ? rates.cacheWrite : rates.input;
	const output = rates.output > 0 ? maxTokens * rates.output : 0;
	return (promptTokens * readPrice + tailTokens * writePrice + output) / 1_000_000;
}

/** The payload field that caps the output, for each API that the prefix guard knows. */
const OUTPUT_CAP_FIELDS: Readonly<Record<string, readonly string[]>> = {
	"anthropic-messages": ["max_tokens"],
	"openai-completions": ["max_completion_tokens", "max_tokens"],
	"openai-responses": ["max_output_tokens"],
	"openai-codex-responses": ["max_output_tokens"],
	"azure-openai-responses": ["max_output_tokens"],
};

/**
 * The output cap that the payload sends, or undefined when it sends none (some APIs and sign-ins omit it, and a
 * model's sampling parameters can replace it).
 */
export function payloadOutputCap(api: string, payload: unknown): number | undefined {
	if (typeof payload !== "object" || payload === null) return undefined;
	for (const field of OUTPUT_CAP_FIELDS[api] ?? []) {
		const value = (payload as Record<string, unknown>)[field];
		if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
	}
	return undefined;
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
	| "refused"
	| "unguarded"
	| "request_failed"
	| "cancelled"
	| "timeout"
	| "length"
	| "tool_call"
	| "too_long";

export type RequestResult = (
	| { kind: "completed"; text: string | null; message: AssistantMessage }
	| { kind: "failed"; reason: FailureReason; detail?: string; message?: AssistantMessage }
) & {
	/** True when the request passed the guard and `admit`, so the provider sent it. */
	sent: boolean;
};

export interface PredictionRequest {
	ctx: Pick<ExtensionContext, "modelRegistry" | "sessionManager">;
	model: Model<Api>;
	messages: Message[];
	reasoning: ThinkingLevel | undefined;
	maxTokens: number;
	/** The payload of the session's last request (design D4). */
	mainPayload: unknown;
	/**
	 * The last check before the request leaves, with the output cap that the payload sends (undefined when it sends
	 * none). Returns why the request must not leave, or undefined.
	 */
	admit: (outputCap: number | undefined) => string | undefined;
	signal: AbortSignal;
}

class PrefixMismatch extends Error {}
class Refused extends Error {}

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
	let refusal: string | undefined;
	let sent = false;
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
						refusal = request.admit(payloadOutputCap(model.api, payload));
						if (refusal) throw new Refused(refusal);
						sent = true;
						return undefined;
					},
				},
			)
			.result();
	} catch (error) {
		if (check && !check.ok) return { kind: "failed", reason: "prefix_mismatch", detail: check.reason, sent };
		if (refusal) return { kind: "failed", reason: "refused", detail: refusal, sent };
		if (request.signal.aborted) return { kind: "failed", reason: "cancelled", sent };
		if (timeout.aborted) return { kind: "failed", reason: "timeout", sent };
		return {
			kind: "failed",
			reason: "request_failed",
			detail: error instanceof Error ? error.message : String(error),
			sent,
		};
	}
	if (check && !check.ok) return { kind: "failed", reason: "prefix_mismatch", detail: check.reason, message, sent };
	if (refusal) return { kind: "failed", reason: "refused", detail: refusal, message, sent };
	if (message.stopReason === "aborted") {
		return { kind: "failed", reason: request.signal.aborted ? "cancelled" : "timeout", message, sent };
	}
	if (message.stopReason === "error") {
		return { kind: "failed", reason: "request_failed", detail: message.errorMessage, message, sent };
	}
	// The guard runs in every provider that the plan supports. A request that reached the provider without it
	// was not checked, so its result is not trusted either.
	if (!check) return { kind: "failed", reason: "unguarded", detail: "the provider gave no payload", message, sent };
	if (message.stopReason === "length") return { kind: "failed", reason: "length", message, sent };
	if (message.stopReason === "toolUse" || message.content.some((part) => part.type === "toolCall")) {
		return { kind: "failed", reason: "tool_call", message, sent };
	}
	const parsed = parsePrediction(textOf(message));
	if (!parsed.ok) return { kind: "failed", reason: parsed.reason, message, sent };
	return { kind: "completed", text: parsed.text, message, sent };
}
