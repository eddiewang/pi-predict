/**
 * The instruction that follows the session's context in a prediction request, and the parser of the reply. The
 * instruction is a user message after the cached prefix, so it never changes what the provider cached. Examples of
 * the owner's earlier replies come from the history index (plan D8).
 */

import type { UserMessage } from "@earendil-works/pi-ai";

export const NO_PREDICTION = "<none>";
/** A longer reply is not a message that one key should insert. */
export const MAX_PREDICTION_CHARS = 600;
const MAX_EXAMPLE_CHARS = 300;

export interface ReplyExample {
	/** The end of the agent's message before the reply. */
	after: string;
	reply: string;
}

function oneLine(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `…${flat.slice(flat.length - max + 1)}` : flat;
}

function clip(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function instructionText(examples: readonly ReplyExample[]): string {
	const lines = [
		"<next_message_prediction>",
		"Stop the task for a moment. Do not call tools. Predict the next message that the user will send you in",
		"this conversation, after your last reply.",
		"",
		"Write it as this user writes: the same language, length, tone, and habits. Many of their replies are",
		"short commands.",
	];
	if (examples.length > 0) {
		lines.push("Their replies to similar messages in earlier sessions:", "");
		for (const example of examples) {
			lines.push(
				`- After "${oneLine(example.after, MAX_EXAMPLE_CHARS)}" they wrote: ${clip(example.reply, MAX_EXAMPLE_CHARS)}`,
			);
		}
	}
	lines.push(
		"",
		"Reply with the message only, without quotes. If you cannot predict it with fair confidence, reply with",
		`exactly: ${NO_PREDICTION}`,
		"</next_message_prediction>",
	);
	return lines.join("\n");
}

export function instructionMessage(examples: readonly ReplyExample[], timestamp = Date.now()): UserMessage {
	return { role: "user", content: [{ type: "text", text: instructionText(examples) }], timestamp };
}

export type ParsedPrediction = { ok: true; text: string | null } | { ok: false; reason: "too_long" };

const QUOTES: ReadonlyArray<readonly [string, string]> = [
	['"', '"'],
	["“", "”"],
	["'", "'"],
	["`", "`"],
];

/** The reply's text parts, without a pair of quotes around them. `<none>` or no text gives null. */
export function parsePrediction(text: string): ParsedPrediction {
	let value = text.trim();
	for (const [open, close] of QUOTES) {
		if (value.length >= 2 && value.startsWith(open) && value.endsWith(close)) {
			value = value.slice(open.length, value.length - close.length).trim();
			break;
		}
	}
	if (value.length === 0 || value.toLowerCase() === NO_PREDICTION) return { ok: true, text: null };
	if (value.length > MAX_PREDICTION_CHARS) return { ok: false, reason: "too_long" };
	return { ok: true, text: value };
}
