import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, loadConfig, saveEnabled } from "../src/config.ts";
import { checkPrefix } from "../src/guard.ts";
import { computeStats, type LogLine } from "../src/log.ts";
import { classifyOutcome } from "../src/outcome.ts";
import { instructionText, MAX_PREDICTION_CHARS, parsePrediction } from "../src/prompt.ts";
import { estimateCost, payloadOutputCap, planRequest } from "../src/request.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("prefix guard", () => {
	const system = [{ type: "text", text: "prompt", cache_control: { type: "ephemeral" } }];
	const main = {
		model: "m",
		system,
		max_tokens: 128_000,
		thinking: { type: "adaptive" },
		messages: [
			{ role: "user", content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }] },
			{ role: "system", content: [], output_config: { effort: "high" } },
		],
	};
	const prediction = {
		...main,
		system: [{ type: "text", text: "prompt" }],
		max_tokens: 2_048,
		messages: [
			{ role: "user", content: [{ type: "text", text: "hi" }] },
			{ role: "system", content: [], output_config: { effort: "high" } },
			{ role: "assistant", content: [{ type: "text", text: "done" }] },
			{ role: "user", content: [{ type: "text", text: "predict", cache_control: { type: "ephemeral" } }] },
			{ role: "system", content: [], output_config: { effort: "low" } },
		],
	};

	it("accepts a continuation; cache markers and the output cap may differ", () => {
		expect(checkPrefix("anthropic-messages", main, prediction)).toEqual({ ok: true });
	});

	it("rejects a different request setting, a changed message, and a request that does not continue", () => {
		expect(checkPrefix("anthropic-messages", main, { ...prediction, thinking: { type: "disabled" } })).toEqual({
			ok: false,
			reason: '"thinking" differs from the last request',
		});
		expect(checkPrefix("anthropic-messages", main, { ...prediction, tool_choice: { type: "none" } })).toMatchObject({
			ok: false,
		});
		const changed = structuredClone(prediction);
		changed.messages[1] = { role: "system", content: [], output_config: { effort: "low" } };
		expect(checkPrefix("anthropic-messages", main, changed)).toEqual({
			ok: false,
			reason: '"messages[1]" differs from the last request',
		});
		expect(checkPrefix("anthropic-messages", main, main)).toMatchObject({ ok: false });
	});

	it("knows each API's list and refuses an API without a shape", () => {
		const input = { model: "m", reasoning: { effort: "high" }, input: [{ role: "user", content: "hi" }] };
		const next = { ...input, max_output_tokens: 10, input: [...input.input, { role: "user", content: "p" }] };
		expect(checkPrefix("openai-codex-responses", input, next)).toEqual({ ok: true });
		expect(checkPrefix("google-generative-ai", input, next)).toMatchObject({ ok: false });
		expect(checkPrefix("anthropic-messages", undefined, next)).toEqual({
			ok: false,
			reason: "no payload of the last request",
		});
	});
});

describe("request plan", () => {
	const model = (api: string, compat: Record<string, unknown> = {}) =>
		({ api, compat, cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } }) as unknown as Model<Api>;

	it("asks for low effort in the transcript when the model supports it", () => {
		const plan = planRequest(
			model("anthropic-messages", { supportsMidConvoEffort: true, forceAdaptiveThinking: true }),
			"high",
		);
		expect(plan).toEqual({ ok: true, reasoning: "low", maxTokens: 2_048 });
	});

	it("keeps the session's level otherwise, and refuses budget-based thinking", () => {
		expect(planRequest(model("anthropic-messages", { forceAdaptiveThinking: true }), "high")).toEqual({
			ok: true,
			reasoning: "high",
			maxTokens: 8_192,
		});
		expect(planRequest(model("anthropic-messages"), "medium")).toMatchObject({ ok: false });
		expect(planRequest(model("anthropic-messages"), "off")).toEqual({
			ok: true,
			reasoning: undefined,
			maxTokens: 2_048,
		});
		expect(planRequest(model("google-generative-ai"), "off")).toMatchObject({ ok: false });
	});

	it("estimates the cache read, the tail write, and the whole output cap", () => {
		// 114k tokens read at $0.50, 4k tokens written at $6.25, 2,048 output tokens at $25.
		expect(estimateCost(model("anthropic-messages"), 114_000, 16_000, 2_048)).toBeCloseTo(0.057 + 0.025 + 0.0512, 4);
	});

	it("prices the prompt as input when the model has no cache price", () => {
		const uncached = { cost: { input: 10, output: 30, cacheRead: 0, cacheWrite: 0 } } as unknown as Model<Api>;
		// 100k prompt tokens and 100 tail tokens at $10, 2,048 output tokens at $30: above the default $0.40 cap.
		expect(estimateCost(uncached, 100_000, 400, 2_048)).toBeCloseTo(1 + 0.001 + 0.06144, 5);
	});

	it("uses the price tier of the request's size", () => {
		const tiered = {
			cost: {
				input: 1,
				output: 5,
				cacheRead: 0.1,
				cacheWrite: 1.25,
				tiers: [{ inputTokensAbove: 200_000, input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }],
			},
		} as unknown as Model<Api>;
		// 400k tokens: the tier above 200k applies to the whole request.
		expect(estimateCost(tiered, 400_000, 560, 2_048)).toBeCloseTo(0.08 + 0.00035 + 0.02048, 6);
		// 100k tokens: the base rates.
		expect(estimateCost(tiered, 100_000, 560, 2_048)).toBeCloseTo(0.01 + 0.000175 + 0.01024, 6);
	});

	it("makes an unbounded output infinite, unless output is free", () => {
		expect(estimateCost(model("anthropic-messages"), 10_000, 400, Number.POSITIVE_INFINITY)).toBe(
			Number.POSITIVE_INFINITY,
		);
		const free = { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } as unknown as Model<Api>;
		expect(estimateCost(free, 10_000, 400, Number.POSITIVE_INFINITY)).toBe(0);
	});

	it("reads the output cap that each API's payload sends", () => {
		expect(payloadOutputCap("anthropic-messages", { max_tokens: 2_048 })).toBe(2_048);
		expect(payloadOutputCap("openai-completions", { max_completion_tokens: 2_048, max_tokens: 9 })).toBe(2_048);
		expect(payloadOutputCap("openai-responses", { max_output_tokens: 8_192 })).toBe(8_192);
		// No cap, or a cap of a field that this API does not read.
		expect(payloadOutputCap("openai-codex-responses", { input: [] })).toBeUndefined();
		expect(payloadOutputCap("openai-responses", { max_tokens: 2_048 })).toBeUndefined();
		expect(payloadOutputCap("anthropic-messages", { max_tokens: "2048" })).toBeUndefined();
	});
});

describe("prompt", () => {
	it("parses the reply: quotes off, <none> and empty mean no prediction, long replies fail", () => {
		expect(parsePrediction('  "commit and push"  ')).toEqual({ ok: true, text: "commit and push" });
		expect(parsePrediction("<NONE>")).toEqual({ ok: true, text: null });
		expect(parsePrediction("   ")).toEqual({ ok: true, text: null });
		expect(parsePrediction("x".repeat(MAX_PREDICTION_CHARS + 1))).toEqual({ ok: false, reason: "too_long" });
	});

	it("lists examples with the end of the agent's message", () => {
		const text = instructionText([{ after: `${"a".repeat(500)} Open the PR?`, reply: "yes please" }]);
		expect(text).toContain('Open the PR?" they wrote: yes please');
		expect(text).not.toContain("a".repeat(400));
	});
});

describe("outcome", () => {
	it("classifies the next message", () => {
		expect(classifyOutcome("commit and push", "Commit  and push", true)).toEqual({
			outcome: "accepted",
			similarity: 1,
		});
		expect(classifyOutcome("commit and push", "commit and push to main", true).outcome).toBe("edited");
		expect(classifyOutcome("commit and push", "revert it", true).outcome).toBe("missed");
		expect(classifyOutcome("commit and push", "commit and push", false).outcome).toBe("typed");
		expect(classifyOutcome("commit and push", "wait", false).outcome).toBe("missed");
	});
});

describe("config and stats", () => {
	it("uses defaults for missing and invalid keys, and keeps other keys when it writes", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-predict-config-"));
		dirs.push(dir);
		expect(loadConfig(dir)).toEqual({ config: DEFAULT_CONFIG, warnings: [] });
		writeFileSync(join(dir, "pi-predict.json"), JSON.stringify({ examples: 99, display: "line", extra: 1 }));
		const loaded = loadConfig(dir);
		expect(loaded.config).toEqual({ ...DEFAULT_CONFIG, display: "line" });
		expect(loaded.warnings).toEqual(['pi-predict.json: invalid "examples"; using 6']);
		saveEnabled(dir, false);
		expect(JSON.parse(readFileSync(join(dir, "pi-predict.json"), "utf8"))).toEqual({
			examples: 99,
			display: "line",
			extra: 1,
			enabled: false,
		});
	});

	it("sums requests, costs, and outcomes", () => {
		const base = { at: "", day: "2026-10-10", sessionId: "s", cwd: "/", sourceEntryId: "e", model: "m" };
		const lines: LogLine[] = [
			{
				...base,
				kind: "prediction",
				id: "1",
				result: "completed",
				text: "go",
				cost: 0.1,
				cacheReadRatio: 0.9,
				promptTokens: 1,
				examples: 0,
				latencyMs: 4_000,
				display: "line",
			},
			{
				...base,
				kind: "prediction",
				id: "2",
				result: "failed",
				reason: "timeout",
				text: null,
				cost: 0.05,
				promptTokens: 1,
				examples: 0,
				latencyMs: 45_000,
				display: "line",
			},
			{ kind: "outcome", id: "1", at: "", day: "2026-10-10", outcome: "accepted", similarity: 1, shown: true },
		];
		expect(computeStats(lines, 1)).toMatchObject({
			requests: 2,
			completed: 1,
			predicted: 1,
			failed: { timeout: 1 },
			outcomes: { accepted: 1, edited: 0, typed: 0, missed: 0 },
			shown: 1,
			medianLatencyMs: 4_000,
			medianCacheReadRatio: 0.9,
		});
		expect(computeStats(lines, 1).cost).toBeCloseTo(0.15);
	});
});
