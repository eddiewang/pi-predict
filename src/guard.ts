/**
 * The prefix guard (plan D4). A prediction must reuse the provider's cache of the session's last request, because
 * a cache miss costs the whole prompt again ($0.70-2.30 on the owner's sessions). So before the prediction request
 * leaves (in `onPayload`), its payload is compared with the payload of the session's last request:
 *
 * - every top-level field is equal, except the message list and the fields that only bound the output;
 * - the last request's messages are a prefix of the prediction's messages.
 *
 * `cache_control` markers are ignored: a provider moves its breakpoint to the new last message, and a cache read
 * matches the prefix, not the marker. A payload shape that this guard does not know gets no prediction.
 */

interface PayloadShape {
	/** The field that holds the conversation. */
	list: string;
	/** Fields that may differ: they bound or route the output, not the cached prompt. */
	ignore: readonly string[];
}

const RESPONSES: PayloadShape = {
	list: "input",
	ignore: ["max_output_tokens", "stream", "previous_response_id"],
};

const SHAPES: Readonly<Record<string, PayloadShape>> = {
	"anthropic-messages": { list: "messages", ignore: ["max_tokens", "stream"] },
	"openai-responses": RESPONSES,
	"openai-codex-responses": RESPONSES,
	"azure-openai-responses": RESPONSES,
	"openai-completions": {
		list: "messages",
		ignore: ["max_tokens", "max_completion_tokens", "stream", "stream_options"],
	},
};

export function supportsPrefixGuard(api: string): boolean {
	return Object.hasOwn(SHAPES, api);
}

export type PrefixCheck = { ok: true } | { ok: false; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Deep equality of JSON-like values, without `cache_control` fields and without fields whose value is undefined. */
export function sameIgnoringCacheControl(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (Array.isArray(a) || Array.isArray(b)) {
		if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
		return a.every((item, index) => sameIgnoringCacheControl(item, b[index]));
	}
	if (!isRecord(a) || !isRecord(b)) return false;
	const keys = (value: Record<string, unknown>) =>
		Object.keys(value).filter((key) => key !== "cache_control" && value[key] !== undefined);
	const aKeys = keys(a);
	const bKeys = keys(b);
	if (aKeys.length !== bKeys.length) return false;
	return aKeys.every((key) => Object.hasOwn(b, key) && sameIgnoringCacheControl(a[key], b[key]));
}

export function checkPrefix(api: string, main: unknown, prediction: unknown): PrefixCheck {
	const shape = SHAPES[api];
	if (!shape) return { ok: false, reason: `no prefix check for the "${api}" API` };
	if (!isRecord(main)) return { ok: false, reason: "no payload of the last request" };
	if (!isRecord(prediction)) return { ok: false, reason: "the prediction payload is not an object" };
	const skip = new Set([shape.list, ...shape.ignore]);
	const fields = new Set([...Object.keys(main), ...Object.keys(prediction)]);
	for (const field of fields) {
		if (skip.has(field)) continue;
		if (!sameIgnoringCacheControl(main[field], prediction[field])) {
			return { ok: false, reason: `"${field}" differs from the last request` };
		}
	}
	const mainList = main[shape.list];
	const predictionList = prediction[shape.list];
	if (!Array.isArray(mainList) || !Array.isArray(predictionList)) {
		return { ok: false, reason: `"${shape.list}" is not a list` };
	}
	if (predictionList.length <= mainList.length) {
		return { ok: false, reason: `"${shape.list}" does not continue the last request` };
	}
	const index = mainList.findIndex((item, position) => !sameIgnoringCacheControl(item, predictionList[position]));
	if (index >= 0) return { ok: false, reason: `"${shape.list}[${index}]" differs from the last request` };
	return { ok: true };
}
