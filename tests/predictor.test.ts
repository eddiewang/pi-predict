import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { WIDGET_KEY } from "../src/display.ts";
import type { OutcomeLine, PredictionLine } from "../src/log.ts";
import { createHarness, type Exchange, gate, type Harness, provider, TAB, textOf } from "./harness.ts";

const LONG = "x".repeat(40_000);
let harness: Harness | undefined;

async function start(options?: Parameters<typeof createHarness>[0]): Promise<Harness> {
	harness = await createHarness(options);
	return harness;
}

afterEach(async () => {
	await harness?.cleanup();
	harness = undefined;
});

function predictions(h: Harness): PredictionLine[] {
	return h.log().filter((line): line is PredictionLine => line.kind === "prediction");
}

function outcomes(h: Harness): OutcomeLine[] {
	return h.log().filter((line): line is OutcomeLine => line.kind === "outcome");
}

describe("prediction after a run", () => {
	it("continues the session's last request, then shows the prediction above the editor", async () => {
		const h = await start();
		const exchanges: Exchange[] = [];
		h.faux.setResponses([
			provider(exchanges, "The tests pass. Shall I commit?"),
			provider(exchanges, "commit and push"),
		]);
		await h.session.prompt("fix the bug");
		const state = await h.waitForState((s) => s.state === "completed");

		expect(state.text).toBe("commit and push");
		const [main, prediction] = exchanges;
		const mainMessages = main?.context.messages ?? [];
		const predictionMessages = prediction?.context.messages ?? [];
		// The prefix is the main request, then the reply, then the instruction.
		expect(predictionMessages.slice(0, mainMessages.length)).toEqual(mainMessages);
		expect(predictionMessages).toHaveLength(mainMessages.length + 2);
		expect(textOf(predictionMessages.at(-2))).toBe("The tests pass. Shall I commit?");
		expect(textOf(predictionMessages.at(-1))).toContain("<next_message_prediction>");
		// The same session id, so the provider's cache of the session serves the prefix.
		expect(prediction?.options?.sessionId).toBe(h.sessionId);
		expect(prediction?.options?.maxTokens).toBe(2_048);
		expect(prediction?.payloadError).toBeUndefined();
		expect(h.terminal.render(WIDGET_KEY)).toEqual(["↳ commit and push  tab"]);

		const [line] = predictions(h);
		expect(line).toMatchObject({ result: "completed", text: "commit and push", sourceEntryId: state.sourceEntryId });
		expect(line?.usage?.cacheRead).toBeGreaterThan(0);
	});

	it("sends nothing when the payload does not continue the last request", async () => {
		// An extension before pi-predict adds a field to the session's payloads only; a prediction request lacks it.
		const tagPayload = (pi: ExtensionAPI) => {
			pi.on("before_provider_request", (event) => ({ ...(event.payload as object), metadata: { tag: 1 } }));
		};
		const h = await start({ before: [tagPayload] });
		const exchanges: Exchange[] = [];
		h.faux.setResponses([provider(exchanges, "Done."), provider(exchanges, "thanks")]);
		await h.session.prompt("hi");
		await h.waitForState((s) => s.state === "failed");

		expect(exchanges[1]?.payloadError).toBeInstanceOf(Error);
		expect(predictions(h)[0]).toMatchObject({ result: "failed", reason: "prefix_mismatch" });
		expect(h.terminal.render(WIDGET_KEY)).toEqual([]);
	});

	it("drops a prediction that arrives after the owner sent a message", async () => {
		const h = await start();
		const exchanges: Exchange[] = [];
		const late = gate();
		let entered!: () => void;
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		h.faux.setResponses([
			provider(exchanges, "First reply."),
			provider(exchanges, "too late", { until: late.opened, entered }),
			provider(exchanges, "Second reply."),
			provider(exchanges, "<none>"),
		]);
		await h.session.prompt("one");
		await started;
		const first = h.states.find((s) => s.state === "running");
		await h.session.prompt("two");
		late.open();
		await h.waitForState((s) => s.state === "completed" && s.sourceEntryId !== first?.sourceEntryId);

		const seen = h.states.filter((s) => s.sourceEntryId === first?.sourceEntryId).map((s) => s.state);
		expect(seen).toEqual(["running", "cleared"]);
		expect(predictions(h)[0]).toMatchObject({ result: "failed", reason: "cancelled" });
		// "<none>": no prediction, nothing above the editor.
		expect(h.terminal.render(WIDGET_KEY)).toEqual([]);
	});

	it("Tab puts the prediction in an empty editor; sending it records 'accepted'", async () => {
		const h = await start();
		const exchanges: Exchange[] = [];
		h.faux.setResponses([
			provider(exchanges, "Plan ready."),
			provider(exchanges, "let's do it"),
			provider(exchanges, "Doing it."),
			provider(exchanges, "<none>"),
		]);
		await h.session.prompt("plan it");
		await h.waitForState((s) => s.state === "completed");

		expect(h.terminal.render(WIDGET_KEY)).toEqual(["↳ let's do it  tab"]);
		h.terminal.editor = "l";
		expect(h.terminal.render(WIDGET_KEY)).toEqual([]);
		expect(h.terminal.press(TAB)).toBe(false);
		h.terminal.editor = "";
		expect(h.terminal.press(TAB)).toBe(true);
		expect(h.terminal.editor).toBe("let's do it");

		await h.session.prompt(h.terminal.editor);
		expect(outcomes(h)).toMatchObject([{ outcome: "accepted", similarity: 1, shown: true }]);
	});

	it("records 'missed' when the owner sends something else", async () => {
		const h = await start();
		const exchanges: Exchange[] = [];
		h.faux.setResponses([
			provider(exchanges, "Plan ready."),
			provider(exchanges, "let's do it"),
			provider(exchanges, "Ok."),
			provider(exchanges, "<none>"),
		]);
		await h.session.prompt("plan it");
		await h.waitForState((s) => s.state === "completed");
		h.terminal.render(WIDGET_KEY);
		await h.session.prompt("no, change step 2 first");
		expect(outcomes(h)).toMatchObject([{ outcome: "missed", shown: true }]);
	});
});

describe("skips", () => {
	it("makes no request in print mode", async () => {
		const h = await start({ mode: "print" });
		const exchanges: Exchange[] = [];
		h.faux.setResponses([provider(exchanges, "Done."), provider(exchanges, "unused")]);
		await h.session.prompt("hi");
		await h.settle();
		expect(exchanges).toHaveLength(1);
		expect(h.states).toEqual([]);
	});

	it("makes no request for a subagent's session", async () => {
		const key = Symbol.for("pi-subagents:session-status.v1");
		const globals = globalThis as Record<symbol, unknown>;
		const h = await start();
		globals[key] = { read: (id: string) => (id === h.sessionId ? { sessionKind: "child" } : undefined) };
		try {
			const exchanges: Exchange[] = [];
			h.faux.setResponses([provider(exchanges, "Done."), provider(exchanges, "unused")]);
			await h.session.prompt("hi");
			await h.settle();
			expect(exchanges).toHaveLength(1);
		} finally {
			delete globals[key];
		}
	});

	it("makes no request while the owner has a draft", async () => {
		const h = await start();
		const exchanges: Exchange[] = [];
		h.faux.setResponses([provider(exchanges, "Done."), provider(exchanges, "unused")]);
		h.terminal.editor = "already typing";
		await h.session.prompt("hi");
		await h.settle();
		expect(exchanges).toHaveLength(1);
	});

	it("keeps to the price cap and the daily budget", async () => {
		const h = await start();
		mkdirSync(h.agentDir, { recursive: true });
		const exchanges: Exchange[] = [];
		h.faux.setResponses([provider(exchanges, "Done."), provider(exchanges, "Again.")]);
		// 2,048 output tokens at $25 per million alone are above $0.05.
		writeFileSync(join(h.agentDir, "pi-predict.json"), JSON.stringify({ maxCostPerPrediction: 0.05 }));
		await h.session.extensionRunner.emit({ type: "session_start", reason: "reload" });
		await h.session.prompt("hi");
		await h.settle();
		expect(exchanges).toHaveLength(1);
		expect(await h.command("/predict")).toContain("is above the $0.05 cap");

		writeFileSync(join(h.agentDir, "pi-predict.json"), JSON.stringify({ dailyBudget: 0 }));
		await h.session.extensionRunner.emit({ type: "session_start", reason: "reload" });
		await h.session.prompt("again");
		await h.settle();
		expect(exchanges).toHaveLength(2);
		expect(await h.command("/predict")).toContain("the daily budget is used");
	});
});

describe("cache guard", () => {
	it("pauses the session after two predictions that did not read the cache", async () => {
		const h = await start();
		const exchanges: Exchange[] = [];
		const steps = [];
		const gates = [gate(), gate()];
		const entered: Array<() => void> = [];
		const starts = gates.map(
			() =>
				new Promise<void>((resolve) => {
					entered.push(resolve);
				}),
		);
		for (let round = 0; round < 2; round++) {
			steps.push(
				provider(exchanges, `Reply ${round}.`),
				provider(exchanges, `guess ${round}`, { until: gates[round]?.opened, entered: entered[round] }),
				provider(exchanges, "unrelated"),
			);
		}
		steps.push(provider(exchanges, "Reply 2."), provider(exchanges, "unused"));
		h.faux.setResponses(steps);

		for (let round = 0; round < 2; round++) {
			const from = h.states.length;
			await h.session.prompt(`${LONG} ${round}`);
			await starts[round];
			// Another request of the same session replaces the provider's cached prompt before the prediction answers.
			await h.modelRuntime
				.streamSimple(
					h.faux.getModel(),
					{ messages: [{ role: "user", content: [{ type: "text", text: "unrelated" }], timestamp: 1 }] },
					{ sessionId: h.sessionId },
				)
				.result();
			gates[round]?.open();
			await h.waitForState((s) => s.state === "completed", from);
		}
		expect(predictions(h).map((line) => (line.cacheReadRatio ?? 1) < 0.8)).toEqual([true, true]);
		expect(h.terminal.notes.some((note) => note.message.startsWith("pi-predict paused"))).toBe(true);

		await h.session.prompt("third");
		await h.settle();
		expect(exchanges).toHaveLength(7);
		expect(await h.command("/predict")).toContain("is paused");
		expect(await h.command("/predict resume")).toBe("pi-predict resumed.");
	});
});

describe("API", () => {
	it("publishes each state on pi.events and through the reader", async () => {
		const seen: unknown[] = [];
		const listen = (pi: ExtensionAPI) => {
			pi.events.on("predict:updated.v1", (data) => seen.push(data));
		};
		const h = await start({ before: [listen] });
		const exchanges: Exchange[] = [];
		h.faux.setResponses([provider(exchanges, "Done."), provider(exchanges, "ship it")]);
		await h.session.prompt("hi");
		const state = await h.waitForState((s) => s.state === "completed");
		expect(seen).toMatchObject([
			{ state: "running", text: null },
			{ state: "completed", text: "ship it" },
		]);
		const { api } = await import("./harness.ts");
		expect(api().current(h.sessionId)).toEqual(state);
	});
});
