/**
 * The session's last request, as it went to the provider (design D1, D4). `context_with_system` gives its messages
 * after every `context` handler; the next `before_provider_request` gives its payload. Only an agent request fires
 * `context_with_system`, so the cache warmer's replays and pi-predict's own requests are never captured.
 *
 * The payload is the one that pi-predict's handler sees. An extension that changes payloads after pi-predict in
 * the load order makes the guard compare with a payload that the provider did not get; see the README,
 * "Limits".
 */

import type { Message, Model } from "@earendil-works/pi-ai";
import * as piAi from "@earendil-works/pi-ai";
import {
	buildSessionProjection,
	type ContextWithSystemEvent,
	convertToLlm,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";

type FitImages = (messages: Message[], limits: Model<any>["inputLimits"]) => { messages: Message[] };

/**
 * Some Pi builds leave old images out of a request that passes the model's `inputLimits`: the agent loop applies
 * pi-ai's `fitImagesToInputLimits` after `convertToLlm`. The prediction applies the same function, so its prefix
 * stays equal to the main request. Stock Pi has no such function, and its agent loop sends every image, so the
 * messages stay as they are.
 */
const fitImages = (piAi as unknown as { fitImagesToInputLimits?: FitImages }).fitImagesToInputLimits;

export interface LastRequest {
	/** The leaf when the request was built: its last message is the request's last message. */
	leafId: string | null;
	messages: ContextWithSystemEvent["messages"];
	payload: unknown;
}

export class RequestCapture {
	private pending: Omit<LastRequest, "payload"> | undefined;
	private last: LastRequest | undefined;

	noteContext(leafId: string | null, messages: ContextWithSystemEvent["messages"]): void {
		this.pending = { leafId, messages };
	}

	/** A payload without a context before it (a cache warm, a compaction) is not the session's request. */
	notePayload(payload: unknown): void {
		if (!this.pending) return;
		this.last = { ...this.pending, payload: structuredClone(payload) };
		this.pending = undefined;
	}

	get lastRequest(): LastRequest | undefined {
		return this.last;
	}

	clear(): void {
		this.pending = undefined;
		this.last = undefined;
	}
}

/**
 * The prediction's messages before its instruction: the last request's messages, then the messages of the entries
 * after its leaf on the current branch (the run's final reply). Undefined when the branch does not continue the
 * last request (a tree move, a compaction, a new context window).
 */
export function continuationMessages(
	entries: SessionEntry[],
	leafId: string | null,
	last: LastRequest,
	model: Model<any>,
): Message[] | undefined {
	if (!last.leafId) return undefined;
	const projection = buildSessionProjection(entries, leafId);
	const index = projection.entries.findIndex((entry) => entry.sourceEntry.id === last.leafId);
	if (index < 0) return undefined;
	const tail = projection.entries.slice(index + 1).flatMap((entry) => entry.messages);
	if (tail.length === 0) return undefined;
	const messages = convertToLlm([...last.messages, ...tail]);
	// The same image limits as the agent loop applies to each request, where the host has them (see `fitImages`).
	return typeof fitImages === "function" ? fitImages(messages, model.inputLimits).messages : messages;
}

/** The id of the last `message` entry on the branch: the key of a prediction (design D6). */
export function lastMessageEntryId(branch: readonly SessionEntry[]): string | undefined {
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry?.type === "message") return entry.id;
	}
	return undefined;
}

/** The last assistant message on the branch, if the branch's last message is one. */
export function finalAssistant(branch: readonly SessionEntry[]) {
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry?.type !== "message") continue;
		return entry.message.role === "assistant" ? entry.message : undefined;
	}
	return undefined;
}

/** The prompt size of the last request, from its reply's usage (input, cache read, and cache write). */
export function lastPromptTokens(branch: readonly SessionEntry[]): number {
	const message = finalAssistant(branch);
	if (!message) return 0;
	const usage = message.usage;
	return usage.input + usage.cacheRead + usage.cacheWrite;
}
