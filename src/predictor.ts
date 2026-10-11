/**
 * One live session's predictions (design, "Prediction lifecycle"). When a run settles, the predictor checks the skip
 * rules (D5), sends one guarded request (D1-D4), and publishes the result while the branch still ends at the same
 * message (D6). A new message, a tree move, a compaction, a new context window, a model change, and the session's
 * end cancel it. The next message the user sends gives the outcome.
 */

import { randomUUID } from "node:crypto";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ContextWithSystemEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type PredictionState, type PredictionStateKind, publishState } from "./api.ts";
import {
	continuationMessages,
	finalAssistant,
	lastMessageEntryId,
	lastPromptTokens,
	RequestCapture,
} from "./capture.ts";
import type { PredictConfig } from "./config.ts";
import { LineDisplay, type PredictionDisplay } from "./display.ts";
import type { HistorySource } from "./history.ts";
import { appendLog, localDay, type PredictionLine, spentToday } from "./log.ts";
import { classifyOutcome } from "./outcome.ts";
import { instructionMessage, instructionText } from "./prompt.ts";
import { cacheReadRatio, costOf, estimateCost, planRequest, type RequestResult, requestPrediction } from "./request.ts";

/** Two predictions in a row below the configured cache-read share pause the session (design D9c). */
export const LOW_CACHE_READS_TO_PAUSE = 2;
/** Smaller prompts are not checked: providers do not cache them, and they cost little. */
export const MIN_CHECKED_PROMPT_TOKENS = 8_192;

const SUBAGENT_STATUS_KEY = Symbol.for("pi-subagents:session-status.v1");

/** True when pi-subagents reports this session as one of its children: no person reads its replies. */
function isSubagentChild(sessionId: string): boolean {
	const status = (globalThis as Record<symbol, unknown>)[SUBAGENT_STATUS_KEY] as
		| { read?: (id: string) => { sessionKind?: string } | undefined }
		| undefined;
	try {
		return status?.read?.(sessionId)?.sessionKind === "child";
	} catch {
		return false;
	}
}

export interface PredictorOptions {
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	agentDir: string;
	config: PredictConfig;
	/** The user's earlier replies (design D7, D8). */
	history?: HistorySource;
}

interface Running {
	id: string;
	sourceEntryId: string;
	controller: AbortController;
}

interface Shown {
	id: string;
	sourceEntryId: string;
	text: string;
}

function replyText(message: { content: ReadonlyArray<{ type: string; text?: string }> }): string {
	return message.content
		.filter((part) => part.type === "text")
		.map((part) => part.text ?? "")
		.join("\n");
}

export class SessionPredictor {
	readonly sessionId: string;
	private readonly capture = new RequestCapture();
	private readonly display: PredictionDisplay | undefined;
	private running: Running | undefined;
	private current: Shown | undefined;
	private lowCacheReads = 0;
	private paused = false;
	private disposed = false;
	private lastSkip: string | undefined;
	private readonly options: PredictorOptions;

	constructor(options: PredictorOptions) {
		this.options = options;
		const { ctx } = options;
		this.sessionId = ctx.sessionManager.getSessionId();
		if (ctx.mode === "tui" && ctx.hasUI) this.display = new LineDisplay(ctx.ui, () => ctx.isIdle());
	}

	get config(): PredictConfig {
		return this.options.config;
	}

	noteContext(leafId: string | null, messages: ContextWithSystemEvent["messages"]): void {
		this.capture.noteContext(leafId, messages);
	}

	notePayload(payload: unknown): void {
		this.capture.notePayload(payload);
	}

	/** Why a prediction cannot start now, or undefined. `force` (`/predict now`) ignores a draft in the editor. */
	private skipReason(ctx: ExtensionContext, force: boolean): string | undefined {
		if (!this.config.enabled) return "predictions are off";
		if (this.paused) return "paused: predictions did not read the session's cache (/predict resume)";
		if (ctx.mode !== "tui" && ctx.mode !== "rpc") return `no predictions in ${ctx.mode} mode`;
		if (isSubagentChild(this.sessionId)) return "a subagent's session";
		if (!ctx.isIdle() || ctx.hasPendingMessages()) return "Pi is busy";
		if (!force && ctx.mode === "tui" && ctx.ui.getEditorText().trim() !== "") return "the draft is not empty";
		return undefined;
	}

	/** Start a prediction for the settled run. Resolves with the skip reason, or undefined once it ran. */
	async predict(ctx: ExtensionContext, force = false): Promise<string | undefined> {
		const skip = this.skipReason(ctx, force) ?? (await this.run(ctx));
		if (skip) this.lastSkip = skip;
		return skip;
	}

	private async run(ctx: ExtensionContext): Promise<string | undefined> {
		const branch = ctx.sessionManager.getBranch();
		const final = finalAssistant(branch);
		if (!final) return "the branch does not end with a reply";
		if (final.stopReason === "error" || final.stopReason === "aborted") {
			return this.predictFromHistory(ctx, final.stopReason, branch);
		}
		if (final.stopReason !== "stop") return `the run ended with "${final.stopReason}"`;
		const model = ctx.model as Model<Api> | undefined;
		if (!model) return "no model";
		const plan = planRequest(model, this.options.pi.getThinkingLevel());
		if (!plan.ok) return plan.reason;
		const last = this.capture.lastRequest;
		if (!last) return "no request of this session to continue";
		const continuation = continuationMessages(
			ctx.sessionManager.getEntries(),
			ctx.sessionManager.getLeafId(),
			last,
			model,
		);
		if (!continuation) return "the branch does not continue the last request";
		const sourceEntryId = lastMessageEntryId(branch);
		if (!sourceEntryId) return "no message on the branch";

		const after = replyText(final);
		const used =
			this.options.history?.examples({
				cwd: ctx.cwd,
				after,
				scope: this.config.history,
				limit: this.config.examples,
			}) ?? [];
		const instruction = instructionMessage(used);
		const promptTokens = lastPromptTokens(branch);
		const estimate = estimateCost(model, promptTokens, after.length + instructionText(used).length, plan.maxTokens);
		if (estimate > this.config.maxCostPerPrediction) {
			return `estimated $${estimate.toFixed(2)} is above the $${this.config.maxCostPerPrediction.toFixed(2)} cap`;
		}
		const today = localDay();
		const spent = spentToday(this.options.agentDir, today);
		if (spent + estimate > this.config.dailyBudget) {
			return `the daily budget is used ($${spent.toFixed(2)} of $${this.config.dailyBudget.toFixed(2)})`;
		}

		this.cancel();
		const running: Running = { id: randomUUID(), sourceEntryId, controller: new AbortController() };
		this.running = running;
		this.publish("running", sourceEntryId, null);
		const started = Date.now();
		const result = await requestPrediction({
			ctx,
			model,
			messages: [...continuation, instruction],
			reasoning: plan.reasoning,
			maxTokens: plan.maxTokens,
			mainPayload: last.payload,
			signal: running.controller.signal,
		});
		this.finish(ctx, running, result, {
			model,
			today,
			promptTokens,
			examples: used.length,
			latencyMs: Date.now() - started,
		});
		return undefined;
	}

	/**
	 * After a run that ended in an error or an abort, the usual reply comes from history, with no model call (design
	 * D7): a request after a provider error is likely to fail too, and most such replies are the same words.
	 */
	private predictFromHistory(
		ctx: ExtensionContext,
		stop: string,
		branch: ReturnType<ExtensionContext["sessionManager"]["getBranch"]>,
	): string | undefined {
		const text =
			this.config.history === "off"
				? undefined
				: this.options.history?.replyAfterStop({ cwd: ctx.cwd, stop, scope: this.config.history });
		if (!text) return `the run ended with "${stop}" and no reply to that is usual`;
		const sourceEntryId = lastMessageEntryId(branch);
		if (!sourceEntryId) return "no message on the branch";
		this.cancel();
		const id = randomUUID();
		const now = new Date();
		try {
			appendLog(this.options.agentDir, {
				kind: "prediction",
				id,
				at: now.toISOString(),
				day: localDay(now),
				sessionId: this.sessionId,
				cwd: ctx.cwd,
				sourceEntryId,
				model: "history",
				result: "completed",
				text,
				cost: 0,
				promptTokens: 0,
				examples: 0,
				latencyMs: 0,
				display: this.display?.kind ?? "none",
			});
		} catch {
			// See `finish`.
		}
		this.current = { id, sourceEntryId, text };
		this.display?.show(text);
		this.publish("completed", sourceEntryId, text);
		return undefined;
	}

	private finish(
		ctx: ExtensionContext,
		running: Running,
		result: RequestResult,
		facts: { model: Model<Api>; today: string; promptTokens: number; examples: number; latencyMs: number },
	): void {
		const message = result.message;
		const usage = message?.usage;
		const ratio = usage ? cacheReadRatio(usage) : undefined;
		const line: PredictionLine = {
			kind: "prediction",
			id: running.id,
			at: new Date().toISOString(),
			day: facts.today,
			sessionId: this.sessionId,
			cwd: ctx.cwd,
			sourceEntryId: running.sourceEntryId,
			model: `${facts.model.provider}/${facts.model.id}`,
			result: result.kind,
			...(result.kind === "failed"
				? { reason: result.reason, ...(result.detail ? { detail: result.detail } : {}) }
				: {}),
			text: result.kind === "completed" ? result.text : null,
			...(usage
				? {
						usage: {
							input: usage.input,
							output: usage.output,
							cacheRead: usage.cacheRead,
							cacheWrite: usage.cacheWrite,
						},
					}
				: {}),
			cost: message ? costOf(facts.model, message) : 0,
			...(ratio === undefined ? {} : { cacheReadRatio: ratio }),
			promptTokens: facts.promptTokens,
			examples: facts.examples,
			latencyMs: facts.latencyMs,
			display: this.display?.kind ?? "none",
		};
		try {
			appendLog(this.options.agentDir, line);
		} catch {
			// The log is for stats; a full disk must not break the session.
		}
		if (usage) this.checkCacheRead(ctx, usage);

		if (this.running !== running) return; // Cancelled or replaced; the cancel published "cleared".
		this.running = undefined;
		if (this.disposed || lastMessageEntryId(ctx.sessionManager.getBranch()) !== running.sourceEntryId) {
			this.publish("cleared", running.sourceEntryId, null);
			return;
		}
		if (result.kind === "failed") {
			this.publish("failed", running.sourceEntryId, null);
			return;
		}
		if (result.text !== null) {
			this.current = { id: running.id, sourceEntryId: running.sourceEntryId, text: result.text };
			this.display?.show(result.text);
		}
		this.publish("completed", running.sourceEntryId, result.text);
	}

	private checkCacheRead(
		ctx: ExtensionContext,
		usage: { input: number; cacheRead: number; cacheWrite: number },
	): void {
		if (usage.input + usage.cacheRead + usage.cacheWrite < MIN_CHECKED_PROMPT_TOKENS) return;
		if (cacheReadRatio(usage) >= this.config.minCacheReadRatio) {
			this.lowCacheReads = 0;
			return;
		}
		this.lowCacheReads++;
		if (this.lowCacheReads < LOW_CACHE_READS_TO_PAUSE || this.paused) return;
		this.paused = true;
		if (ctx.hasUI) {
			ctx.ui.notify(
				`pi-predict paused: ${LOW_CACHE_READS_TO_PAUSE} predictions in a row read less than ${Math.round(this.config.minCacheReadRatio * 100)}% of their prompt from the cache. /predict resume`,
				"warning",
			);
		}
	}

	/** The user sent a message: record the outcome of the shown prediction, then drop it. */
	onInput(text: string): void {
		const current = this.current;
		if (current) {
			const { outcome, similarity } = classifyOutcome(current.text, text, this.display?.acceptedByKey ?? false);
			try {
				const now = new Date();
				appendLog(this.options.agentDir, {
					kind: "outcome",
					id: current.id,
					at: now.toISOString(),
					day: localDay(now),
					outcome,
					similarity: Math.round(similarity * 1000) / 1000,
					shown: this.display?.shown ?? false,
				});
			} catch {
				// See `finish`.
			}
		}
		this.cancel();
	}

	onPromptOpen(open: boolean): void {
		this.display?.setPromptOpen(open);
	}

	/** Drop the running or shown prediction. */
	cancel(): void {
		const sourceEntryId = this.running?.sourceEntryId ?? this.current?.sourceEntryId;
		this.running?.controller.abort();
		this.running = undefined;
		this.current = undefined;
		this.display?.clear();
		if (sourceEntryId) this.publish("cleared", sourceEntryId, null);
	}

	/** The context changed under the captured request (tree move, compaction, new window, model change). */
	reset(): void {
		this.capture.clear();
		this.cancel();
	}

	resume(): void {
		this.paused = false;
		this.lowCacheReads = 0;
	}

	status(): string {
		const state = !this.config.enabled ? "off" : this.paused ? "paused" : "on";
		const spent = spentToday(this.options.agentDir);
		const lines = [
			`pi-predict is ${state}. Today: $${spent.toFixed(2)} of $${this.config.dailyBudget.toFixed(2)}.`,
			`Display: ${this.display?.kind ?? "none (no terminal)"}.`,
		];
		if (this.current) lines.push(`Prediction: ${this.current.text}`);
		else if (this.running) lines.push("A prediction is running.");
		if (this.lastSkip) lines.push(`Last skip: ${this.lastSkip}.`);
		return lines.join("\n");
	}

	dispose(): void {
		if (this.disposed) return;
		this.cancel();
		this.disposed = true;
		this.display?.dispose();
	}

	private publish(state: PredictionStateKind, sourceEntryId: string, text: string | null): void {
		const value: PredictionState = { sessionId: this.sessionId, sourceEntryId, state, text, at: Date.now() };
		publishState(value, (channel, data) => this.options.pi.events.emit(channel, data));
	}
}
