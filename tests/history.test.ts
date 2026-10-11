import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { HISTORY_FILE, HistoryIndex, readSessionFile } from "../src/history.ts";
import type { PredictionLine } from "../src/log.ts";
import { createHarness, type Exchange, type Harness, provider, textOf } from "./harness.ts";

const NOW = Date.parse("2026-10-10T12:00:00.000Z");
const dirs: string[] = [];
let harness: Harness | undefined;

afterEach(async () => {
	await harness?.cleanup();
	harness = undefined;
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-predict-history-"));
	dirs.push(dir);
	return dir;
}

type Turn = [role: "user" | "assistant", text: string, stopReason?: string];

/** A session file in Pi's format: a header, then message entries. */
function writeSession(path: string, cwd: string, turns: Turn[], day = "2026-10-01"): void {
	mkdirSync(join(path, ".."), { recursive: true });
	let parentId: string | null = null;
	const lines = [JSON.stringify({ type: "session", version: 3, id: "s", timestamp: `${day}T00:00:00.000Z`, cwd })];
	turns.forEach(([role, text, stopReason], index) => {
		const id = `e${index}`;
		const message =
			role === "user"
				? { role, content: [{ type: "text", text }], timestamp: 1 }
				: { role, content: [{ type: "text", text }], stopReason: stopReason ?? "stop", timestamp: 1 };
		lines.push(
			JSON.stringify({ type: "message", id, parentId, timestamp: `${day}T00:00:0${index % 10}.000Z`, message }),
		);
		lines.push(
			JSON.stringify({
				type: "message",
				id: `${id}t`,
				parentId: id,
				timestamp: "x",
				message: { role: "toolResult", content: [] },
			}),
		);
		parentId = id;
	});
	writeFileSync(path, `${lines.join("\n")}\n`);
}

describe("session files", () => {
	it("pairs each reply with the end of the agent's message before it, without injected or pasted text", async () => {
		const dir = tempDir();
		const file = join(dir, "a.jsonl");
		writeSession(file, "/work/app", [
			["user", "start"],
			["assistant", `${"x".repeat(500)} Shall I open the PR?`],
			["user", "yes please"],
			["assistant", "", "error"],
			["user", "continue"],
			["assistant", "Done."],
			["user", "<skill name='git'>…</skill>"],
			["assistant", "Ok."],
			["user", "y".repeat(2_001)],
		]);
		const read = await readSessionFile(file);
		expect(read?.cwd).toBe("/work/app");
		expect(read?.pairs.map(({ afterStop, reply }) => ({ afterStop, reply }))).toEqual([
			{ afterStop: "stop", reply: "yes please" },
			{ afterStop: "error", reply: "continue" },
		]);
		expect(read?.pairs[0]?.after).toHaveLength(400);
		expect(read?.pairs[0]?.after.endsWith("Shall I open the PR?")).toBe(true);
	});

	it("leaves out sessions of temporary directories", async () => {
		const file = join(tempDir(), "t.jsonl");
		writeSession(file, join(tmpdir(), "scratch"), [
			["assistant", "Hi"],
			["user", "hello"],
		]);
		expect(await readSessionFile(file)).toBeUndefined();
	});
});

describe("history index", () => {
	function fixture() {
		const agentDir = tempDir();
		const sessions = join(agentDir, "sessions");
		const project = join(sessions, "--work-app--", "one.jsonl");
		writeSession(project, "/work/app", [
			["assistant", "All tests pass and the canary passes. Commit now?"],
			["user", "commit and push"],
			["assistant", "The tests pass now. Commit?"],
			["user", "commit and push"],
			["assistant", "The migration plan for the database schema is ready for your review."],
			["user", "looks right, but run the migration on staging first and paste the output here before you go on"],
		]);
		const other = join(sessions, "--work-site--", "two.jsonl");
		writeSession(other, "/work/site", [
			["assistant", "The tests pass on the site. Commit?"],
			["user", "yes"],
			["assistant", "The deploy plan for production is ready for your review."],
			["user", "this is a long reply from another project that must stay in its own project only"],
			["assistant", "", "error"],
			["user", "continue"],
			["assistant", "", "error"],
			["user", "Continue"],
			["assistant", "", "aborted"],
			["user", "continue"],
		]);
		// pi-subagents keeps a child's transcript in a folder named after its parent's file.
		writeSession(join(sessions, "--work-app--", "one", "child.jsonl"), "/work/app", [
			["assistant", "Child work. Commit?"],
			["user", "child prompt from the parent agent"],
		]);
		return { agentDir, project, other };
	}

	it("builds from top-level session files and ranks replies to similar messages", async () => {
		const { agentDir } = fixture();
		const index = new HistoryIndex(agentDir, () => NOW);
		await index.refresh();

		const examples = index.examples({
			cwd: "/work/app",
			after: "Everything passes. Commit the change?",
			scope: "project+short",
			limit: 6,
		});
		// One example per reply, the project's first; the long reply of the other project is not in scope.
		expect(examples.map((example) => example.reply)).toEqual(["commit and push", "yes"]);
		expect(index.examples({ cwd: "/work/app", after: "deploy to production", scope: "project", limit: 6 })).toEqual(
			[],
		);
		// That long reply of another project matches, but only short replies cross projects.
		expect(
			index.examples({ cwd: "/work/app", after: "deploy to production", scope: "project+short", limit: 6 }),
		).toEqual([]);
		expect(
			index
				.examples({ cwd: "/work/app", after: "deploy to production", scope: "all", limit: 6 })
				.map((e) => e.reply),
		).toEqual(["this is a long reply from another project that must stay in its own project only"]);
		expect(index.examples({ cwd: "/work/app", after: "Commit?", scope: "off", limit: 6 })).toEqual([]);
		expect(
			JSON.stringify(index.examples({ cwd: "/work/app", after: "child work commit", scope: "all", limit: 6 })),
		).not.toContain("child prompt");
	});

	it("gives the usual reply after an error only when it occurred three times", async () => {
		const { agentDir } = fixture();
		const index = new HistoryIndex(agentDir, () => NOW);
		await index.refresh();
		expect(index.replyAfterStop({ cwd: "/work/app", stop: "error", scope: "project+short" })).toBeUndefined();
		expect(index.replyAfterStop({ cwd: "/work/app", stop: "error", scope: "all" })).toBeUndefined();
		expect(index.replyAfterStop({ cwd: "/work/site", stop: "aborted", scope: "all" })).toBeUndefined();
		// Two after errors plus one after an abort: three "continue" replies only if both stops count, which they do not.
		writeSession(join(agentDir, "sessions", "--work-site--", "three.jsonl"), "/work/site", [
			["assistant", "", "error"],
			["user", "continue"],
		]);
		await index.refresh();
		expect(index.replyAfterStop({ cwd: "/work/app", stop: "error", scope: "project+short" })).toBe("continue");
	});

	it("reads only changed files, skips the live file, and saves the index", async () => {
		const { agentDir, project } = fixture();
		const index = new HistoryIndex(agentDir, () => NOW);
		await index.refresh({ skipFile: project });
		expect(
			index.examples({ cwd: "/work/app", after: "Commit?", scope: "all", limit: 6 }).map((e) => e.reply),
		).toEqual(["yes"]);
		const saved = join(agentDir, HISTORY_FILE);
		const first = statSync(saved).mtimeMs;
		await new Promise((resolve) => setTimeout(resolve, 20));
		await index.refresh({ skipFile: project });
		expect(statSync(saved).mtimeMs).toBe(first);

		await index.refresh();
		expect(Object.keys(JSON.parse(readFileSync(saved, "utf8")).files)).toHaveLength(2);
		// A new process loads the saved index without reading the sessions.
		const loaded = new HistoryIndex(agentDir, () => NOW);
		await loaded.load();
		expect(loaded.examples({ cwd: "/work/app", after: "Commit?", scope: "project", limit: 1 })).toHaveLength(1);
	});

	it("reads only what a file gained, pairs across reads, and waits for a line that is still being written", async () => {
		const agentDir = tempDir();
		const file = join(agentDir, "sessions", "--work-app--", "live.jsonl");
		writeSession(file, "/work/app", [
			["user", "start"],
			["assistant", "Tests pass. Commit?"],
		]);
		const index = new HistoryIndex(agentDir, () => NOW);
		await index.refresh();
		const replies = () =>
			index.examples({ cwd: "/work/app", after: "tests pass commit", scope: "all", limit: 6 }).map((e) => e.reply);
		expect(replies()).toEqual([]);

		// The reply to the message of the first read, then half of a line.
		const reply = JSON.stringify({
			type: "message",
			id: "r1",
			parentId: "e1",
			timestamp: "2026-10-02T00:00:00.000Z",
			message: { role: "user", content: [{ type: "text", text: "commit and push" }], timestamp: 1 },
		});
		const next = JSON.stringify({
			type: "message",
			id: "a2",
			parentId: "r1",
			timestamp: "2026-10-02T00:00:01.000Z",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "Pushed. Tests pass. Commit the docs?" }],
				stopReason: "stop",
			},
		});
		const answer = JSON.stringify({
			type: "message",
			id: "r2",
			parentId: "a2",
			timestamp: "2026-10-02T00:00:02.000Z",
			message: { role: "user", content: [{ type: "text", text: "yes" }], timestamp: 1 },
		});
		const before = readFileSync(file, "utf8");
		writeFileSync(file, `${before}${reply}\n${next}\n${answer.slice(0, 40)}`);
		await index.refresh();
		expect(replies()).toEqual(["commit and push"]);

		writeFileSync(file, `${before}${reply}\n${next}\n${answer}\n`);
		await index.refresh();
		expect(replies().sort()).toEqual(["commit and push", "yes"]);

		// A file that shrank (rewritten) is read again from its start.
		writeSession(file, "/work/app", [
			["assistant", "Tests pass. Commit?"],
			["user", "go"],
		]);
		await index.refresh();
		expect(replies()).toEqual(["go"]);
	});

	it("does not build while another process holds a fresh lock, and takes over a stale one", async () => {
		const { agentDir } = fixture();
		const lock = join(agentDir, "pi-predict", "history.lock");
		mkdirSync(join(agentDir, "pi-predict"), { recursive: true });
		writeFileSync(lock, "1");
		const index = new HistoryIndex(agentDir, () => NOW);
		await index.refresh();
		expect(index.examples({ cwd: "/work/app", after: "Commit?", scope: "all", limit: 6 })).toEqual([]);

		const old = new Date(Date.now() - 11 * 60_000);
		utimesSync(lock, old, old);
		await index.refresh();
		expect(index.examples({ cwd: "/work/app", after: "Commit?", scope: "all", limit: 6 })).not.toEqual([]);
	});
});

describe("history in predictions", () => {
	async function indexWith(turns: Turn[]): Promise<HistoryIndex> {
		const agentDir = tempDir();
		writeSession(join(agentDir, "sessions", "--elsewhere--", "old.jsonl"), "/elsewhere", turns);
		const index = new HistoryIndex(agentDir, () => NOW);
		await index.refresh();
		return index;
	}

	it("uses replies from the same project only, by default", async () => {
		const history = await indexWith([
			["assistant", "Tests pass. Commit?"],
			["user", "ship it"],
		]);
		harness = await createHarness({ predict: { history } });
		const exchanges: Exchange[] = [];
		harness.faux.setResponses([provider(exchanges, "Tests pass. Commit?"), provider(exchanges, "ship it")]);
		await harness.session.prompt("fix it");
		await harness.waitForState((state) => state.state === "completed");
		expect(textOf(exchanges[1]?.context.messages.at(-1))).not.toContain("they wrote");
	});

	it("puts short replies from other projects in the instruction with project+short", async () => {
		const history = await indexWith([
			["assistant", "Tests pass. Commit?"],
			["user", "ship it"],
		]);
		harness = await createHarness({ predict: { history }, config: { history: "project+short" } });
		const exchanges: Exchange[] = [];
		harness.faux.setResponses([provider(exchanges, "Tests pass. Commit?"), provider(exchanges, "ship it")]);
		await harness.session.prompt("fix it");
		await harness.waitForState((state) => state.state === "completed");
		expect(textOf(exchanges[1]?.context.messages.at(-1))).toContain(
			'After "Tests pass. Commit?" they wrote: ship it',
		);
	});

	it("after a run that ended in an error, offers the usual reply without a model call", async () => {
		const history = await indexWith([
			["assistant", "", "error"],
			["user", "continue"],
			["assistant", "", "error"],
			["user", "continue"],
			["assistant", "", "error"],
			["user", "continue"],
		]);
		harness = await createHarness({ predict: { history }, config: { history: "project+short" } });
		const exchanges: Exchange[] = [];
		harness.faux.setResponses([
			provider(exchanges, fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded" })),
		]);
		await harness.session.prompt("go");
		const state = await harness.waitForState((s) => s.state === "completed");
		expect(state.text).toBe("continue");
		expect(exchanges).toHaveLength(1);
		const [line] = harness.log().filter((l): l is PredictionLine => l.kind === "prediction");
		expect(line).toMatchObject({ model: "history", cost: 0, text: "continue" });
	});
});
