/**
 * How the owner's next message relates to the prediction (plan step 7). Texts are compared after trimming,
 * collapsing whitespace, and lower-casing; similarity is one minus the edit distance over the longer length.
 */

import type { Outcome } from "./log.ts";

/** An edit within this similarity still counts as the prediction, changed. */
export const EDITED_SIMILARITY = 0.6;
/** Longer texts are compared on their first characters only; the prediction itself is at most 600. */
const MAX_COMPARED_CHARS = 1_000;

export function normalize(text: string): string {
	return text.replace(/\s+/g, " ").trim().toLowerCase().slice(0, MAX_COMPARED_CHARS);
}

export function similarity(a: string, b: string): number {
	const left = normalize(a);
	const right = normalize(b);
	if (left === right) return 1;
	if (left.length === 0 || right.length === 0) return 0;
	let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
	for (let i = 1; i <= left.length; i++) {
		const current = [i];
		for (let j = 1; j <= right.length; j++) {
			const cost = left[i - 1] === right[j - 1] ? 0 : 1;
			current[j] = Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, (previous[j - 1] ?? 0) + cost);
		}
		previous = current;
	}
	return 1 - (previous[right.length] ?? 0) / Math.max(left.length, right.length);
}

/**
 * - accepted: the owner took the prediction with the key and sent it unchanged.
 * - edited: took it with the key, changed it, and it stayed similar.
 * - typed: wrote the same text without the key.
 * - missed: anything else.
 */
export function classifyOutcome(
	prediction: string,
	sent: string,
	acceptedByKey: boolean,
): { outcome: Outcome; similarity: number } {
	const score = similarity(prediction, sent);
	if (acceptedByKey) {
		if (score === 1) return { outcome: "accepted", similarity: score };
		return { outcome: score >= EDITED_SIMILARITY ? "edited" : "missed", similarity: score };
	}
	return { outcome: score === 1 ? "typed" : "missed", similarity: score };
}
