/**
 * The history index (plan D7, D8): pairs of (the end of the agent's message, the owner's reply) from earlier
 * sessions, in `<agentDir>/pi-predict/history-v2.json`.
 *
 * Sources are the top-level session files `<agentDir>/sessions/<dir>/<file>.jsonl`: pi-subagents keeps children in
 * subfolders, so they are not read. Files of temporary working directories, the live session's file, replies that
 * start with `<` (injected blocks), and replies longer than 2,000 characters (pasted logs) are left out. Session files
 * are append-only, so the build reads only the complete lines that a file gained since the last build; a file that
 * shrank is read again from its start. It parses only user and assistant lines and yields to the event loop after
 * each file. A lock file keeps one builder at a time across Pi processes, and the write is
 * atomic.
 */

import { createReadStream } from "node:fs";
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { HistoryScope } from "./config.ts";
import { normalize } from "./outcome.ts";
import type { ReplyExample } from "./prompt.ts";

export const HISTORY_FILE = "pi-predict/history-v2.json";
const LOCK_FILE = "pi-predict/history.lock";
const STALE_LOCK_MS = 10 * 60_000;
const MAX_PAIRS = 20_000;
const MAX_AFTER_CHARS = 400;
const MAX_REPLY_CHARS = 400;
const MAX_SOURCE_REPLY_CHARS = 2_000;
/** "Short" replies may come from any project (owner decision, 2026-10-10). */
export const SHORT_REPLY_CHARS = 60;
/** A history-only reply after an error or an abort needs at least this many earlier cases. */
export const MIN_REPLY_COUNT = 3;
const RECENCY_HALF_LIFE_DAYS = 30;
const SAME_PROJECT_WEIGHT = 1.5;
const QUERY_CHARS = 1_000;

export interface ReplyPair {
	ts: number;
	after: string;
	/** How the agent's message ended: "stop", "error", "aborted", "toolUse", ... */
	afterStop: string;
	reply: string;
}

interface FileRecord {
	/** Bytes read: the end of the last complete line. */
	size: number;
	cwd: string;
	pairs: ReplyPair[];
	/** The agent's last message after the last reply, which the next reply pairs with. */
	pending?: { text: string; stop: string };
}

interface IndexFile {
	version: 2;
	files: Record<string, FileRecord>;
}

export interface HistorySource {
	examples(query: { cwd: string; after: string; scope: HistoryScope; limit: number }): ReplyExample[];
	replyAfterStop(query: { cwd: string; stop: string; scope: HistoryScope }): string | undefined;
}

const TEMPORARY_ROOTS = ["/tmp/", "/private/tmp/", "/var/folders/", "/private/var/folders/"];

export function isTemporaryCwd(cwd: string): boolean {
	const roots = [...TEMPORARY_ROOTS, `${tmpdir()}/`];
	return roots.some((root) => `${cwd}/`.startsWith(root));
}

function textParts(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
}

export interface ReadResult {
	cwd: string;
	pairs: ReplyPair[];
	/** The end of the last complete line. */
	size: number;
	pending?: { text: string; stop: string };
}

/**
 * The reply pairs of one session file and its working directory: from its start, or from `from` (an earlier
 * result) to `size`. A last line without its newline is still being written, so it waits for the next read.
 * Undefined for a file of a temporary directory or without a session header.
 */
export async function readSessionFile(
	path: string,
	options: { size?: number; from?: Pick<ReadResult, "cwd" | "size" | "pending"> } = {},
): Promise<ReadResult | undefined> {
	const start = options.from?.size ?? 0;
	const end = options.size ?? (await stat(path)).size;
	let cwd = options.from?.cwd;
	let last = options.from?.pending;
	let offset = start;
	const pairs: ReplyPair[] = [];
	if (end <= start) {
		return cwd === undefined ? undefined : { cwd, pairs, size: start, ...(last ? { pending: last } : {}) };
	}
	const input = createReadStream(path, { encoding: "utf8", start, end: end - 1 });
	const lines = createInterface({ input, crlfDelay: Infinity });
	for await (const line of lines) {
		const lineEnd = offset + Buffer.byteLength(line, "utf8") + 1;
		if (lineEnd > end) break;
		offset = lineEnd;
		if (cwd === undefined) {
			try {
				const header = JSON.parse(line) as { type?: string; cwd?: unknown };
				if (header.type !== "session" || typeof header.cwd !== "string") break;
				cwd = header.cwd;
			} catch {
				break;
			}
			if (isTemporaryCwd(cwd)) break;
			continue;
		}
		const isUser = line.includes('"message":{"role":"user"');
		if (!isUser && !line.includes('"message":{"role":"assistant"')) continue;
		let entry: { timestamp?: string; message?: { content?: unknown; stopReason?: unknown } };
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		const text = textParts(entry.message?.content).trim();
		if (!isUser) {
			last = { text, stop: typeof entry.message?.stopReason === "string" ? entry.message.stopReason : "stop" };
			continue;
		}
		const before = last;
		last = undefined;
		if (!before || !text || text.startsWith("<") || text.length > MAX_SOURCE_REPLY_CHARS) continue;
		pairs.push({
			ts: Date.parse(entry.timestamp ?? "") || 0,
			after: before.text.slice(-MAX_AFTER_CHARS),
			afterStop: before.stop,
			reply: text.slice(0, MAX_REPLY_CHARS),
		});
	}
	lines.close();
	input.destroy();
	if (cwd === undefined || isTemporaryCwd(cwd)) return undefined;
	return { cwd, pairs, size: offset, ...(last ? { pending: last } : {}) };
}

async function topLevelSessionFiles(sessionsDir: string): Promise<string[]> {
	let dirs: string[];
	try {
		dirs = (await readdir(sessionsDir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
	} catch {
		return [];
	}
	const files: string[] = [];
	for (const dir of dirs) {
		try {
			for (const entry of await readdir(join(sessionsDir, dir), { withFileTypes: true })) {
				if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(join(sessionsDir, dir, entry.name));
			}
		} catch {
			// A folder that went away.
		}
	}
	return files;
}

const STOPWORDS = new Set(
	"the and you for that this with are was have not but can all will your from they what its it's i'm i've let's want should would could there here then than them into also just been more some only when which were did does done now".split(
		" ",
	),
);

export function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^\p{L}\p{N}_]+/u)
		.filter((token) => token.length >= 3 && !STOPWORDS.has(token));
}

interface IndexedPair extends ReplyPair {
	cwd: string;
	terms: Map<string, number>;
	length: number;
}

export class HistoryIndex implements HistorySource {
	private pairs: IndexedPair[] = [];
	private documentFrequency = new Map<string, number>();
	private averageLength = 1;
	private loaded = false;
	private building: Promise<void> | undefined;
	private readonly agentDir: string;
	private readonly now: () => number;

	constructor(agentDir: string, now: () => number = Date.now) {
		this.agentDir = agentDir;
		this.now = now;
	}

	private get indexPath(): string {
		return join(this.agentDir, HISTORY_FILE);
	}

	/** Load the saved index once; a missing or broken file is an empty index. */
	async load(): Promise<void> {
		if (this.loaded) return;
		this.loaded = true;
		try {
			const saved = JSON.parse(await readFile(this.indexPath, "utf8")) as IndexFile;
			if (saved.version === 2) this.use(saved);
		} catch {
			// No index yet.
		}
	}

	/** Bring the index up to date with the session files. Concurrent calls share one build. */
	refresh(options: { skipFile?: string } = {}): Promise<void> {
		this.building ??= this.build(options.skipFile).finally(() => {
			this.building = undefined;
		});
		return this.building;
	}

	private async build(skipFile: string | undefined): Promise<void> {
		await this.load();
		const lockPath = join(this.agentDir, LOCK_FILE);
		await mkdir(join(this.agentDir, "pi-predict"), { recursive: true });
		if (!(await takeLock(lockPath))) return;
		try {
			let saved: IndexFile = { version: 2, files: {} };
			try {
				const parsed = JSON.parse(await readFile(this.indexPath, "utf8")) as IndexFile;
				if (parsed.version === 2) saved = parsed;
			} catch {
				// Build from nothing.
			}
			const next: IndexFile = { version: 2, files: {} };
			let changed = false;
			for (const file of await topLevelSessionFiles(join(this.agentDir, "sessions"))) {
				if (file === skipFile) continue;
				let size: number;
				try {
					size = (await stat(file)).size;
				} catch {
					continue;
				}
				const known = saved.files[file];
				if (known && known.size === size) {
					next.files[file] = known;
					continue;
				}
				changed = true;
				// A file of a temporary directory keeps an empty record, so it is not read again.
				const grew = known && known.size < size && known.cwd ? known : undefined;
				try {
					const read = await readSessionFile(file, { size, ...(grew ? { from: grew } : {}) });
					next.files[file] = read
						? {
								size: read.size,
								cwd: read.cwd,
								pairs: [...(grew?.pairs ?? []), ...read.pairs],
								...(read.pending ? { pending: read.pending } : {}),
							}
						: { size, cwd: "", pairs: [] };
				} catch {
					// An unreadable file is tried again next time.
				}
				await new Promise((resolve) => setImmediate(resolve));
			}
			if (Object.keys(saved.files).some((file) => !(file in next.files))) changed = true;
			trimToLimit(next);
			if (changed) {
				const temporary = `${this.indexPath}.${process.pid}.tmp`;
				await writeFile(temporary, JSON.stringify(next));
				await rename(temporary, this.indexPath);
			}
			this.use(next);
		} finally {
			await rm(lockPath, { force: true });
		}
	}

	private use(index: IndexFile): void {
		const pairs: IndexedPair[] = [];
		for (const record of Object.values(index.files)) {
			if (!record.cwd) continue;
			for (const pair of record.pairs) {
				const terms = new Map<string, number>();
				const tokens = tokenize(pair.after);
				for (const token of tokens) terms.set(token, (terms.get(token) ?? 0) + 1);
				pairs.push({ ...pair, cwd: record.cwd, terms, length: tokens.length });
			}
		}
		const frequency = new Map<string, number>();
		for (const pair of pairs)
			for (const term of pair.terms.keys()) frequency.set(term, (frequency.get(term) ?? 0) + 1);
		this.pairs = pairs;
		this.documentFrequency = frequency;
		this.averageLength = pairs.length > 0 ? pairs.reduce((sum, pair) => sum + pair.length, 0) / pairs.length : 1;
	}

	private inScope(pair: IndexedPair, cwd: string, scope: HistoryScope): boolean {
		switch (scope) {
			case "off":
				return false;
			case "all":
				return true;
			case "project":
				return pair.cwd === cwd;
			case "project+short":
				return pair.cwd === cwd || pair.reply.length <= SHORT_REPLY_CHARS;
		}
	}

	/** Up to `limit` replies to messages like `after`, one per distinct reply, best first (BM25). */
	examples(query: { cwd: string; after: string; scope: HistoryScope; limit: number }): ReplyExample[] {
		if (query.limit <= 0 || query.scope === "off" || this.pairs.length === 0) return [];
		const terms = [...new Set(tokenize(query.after.slice(-QUERY_CHARS)))];
		if (terms.length === 0) return [];
		const total = this.pairs.length;
		const k1 = 1.2;
		const b = 0.75;
		const best = new Map<string, { pair: IndexedPair; score: number }>();
		for (const pair of this.pairs) {
			if (pair.afterStop !== "stop" || !this.inScope(pair, query.cwd, query.scope)) continue;
			let score = 0;
			for (const term of terms) {
				const frequency = pair.terms.get(term);
				if (!frequency) continue;
				const documents = this.documentFrequency.get(term) ?? 0;
				const idf = Math.log(1 + (total - documents + 0.5) / (documents + 0.5));
				score += (idf * frequency * (k1 + 1)) / (frequency + k1 * (1 - b + (b * pair.length) / this.averageLength));
			}
			if (score <= 0) continue;
			const ageDays = Math.max(0, this.now() - pair.ts) / 86_400_000;
			score *= 0.5 + 0.5 * 0.5 ** (ageDays / RECENCY_HALF_LIFE_DAYS);
			if (pair.cwd === query.cwd) score *= SAME_PROJECT_WEIGHT;
			const key = normalize(pair.reply);
			const known = best.get(key);
			if (!known || known.score < score) best.set(key, { pair, score });
		}
		return [...best.values()]
			.sort((a, b) => b.score - a.score)
			.slice(0, query.limit)
			.map(({ pair }) => ({ after: pair.after, reply: pair.reply }));
	}

	/** The reply that most often followed a message that ended this way, if it did so at least 3 times. */
	replyAfterStop(query: { cwd: string; stop: string; scope: HistoryScope }): string | undefined {
		const counts = new Map<string, { reply: string; count: number }>();
		for (const pair of this.pairs) {
			if (pair.afterStop !== query.stop || !this.inScope(pair, query.cwd, query.scope)) continue;
			const key = normalize(pair.reply);
			const known = counts.get(key);
			if (known) known.count++;
			else counts.set(key, { reply: pair.reply.trim(), count: 1 });
		}
		const top = [...counts.values()].sort((a, b) => b.count - a.count)[0];
		return top && top.count >= MIN_REPLY_COUNT ? top.reply : undefined;
	}
}

/** Keep the newest pairs when the index is over its limit. */
function trimToLimit(index: IndexFile): void {
	const all = Object.values(index.files).flatMap((record) => record.pairs.map((pair) => ({ record, pair })));
	if (all.length <= MAX_PAIRS) return;
	all.sort((a, b) => b.pair.ts - a.pair.ts);
	const keep = new Set(all.slice(0, MAX_PAIRS).map(({ pair }) => pair));
	for (const record of Object.values(index.files)) record.pairs = record.pairs.filter((pair) => keep.has(pair));
}

/** An exclusive lock file; a lock older than ten minutes is from a crashed builder and is taken over. */
async function takeLock(path: string): Promise<boolean> {
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const handle = await open(path, "wx");
			await handle.writeFile(String(process.pid));
			await handle.close();
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") return false;
			try {
				const info = await stat(path);
				if (Date.now() - info.mtimeMs < STALE_LOCK_MS) return false;
				await rm(path, { force: true });
			} catch {
				return false;
			}
		}
	}
	return false;
}
