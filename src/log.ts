/**
 * The prediction log, `<agentDir>/pi-predict/log/YYYY-MM.jsonl`: one line for each prediction request and one line
 * for each outcome. The daily budget (design D9b) is the sum of today's prediction costs in this file, so every Pi
 * process that writes here shares one budget. Each line is one `appendFileSync` with `O_APPEND`. Files older than
 * three months are deleted at session start. A file that exists but cannot be read is an error, not an empty day:
 * the budget must not start again from zero.
 */

import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

export const LOG_DIR = "pi-predict/log";
const KEEP_MONTHS = 3;

export interface PredictionLine {
	kind: "prediction";
	id: string;
	at: string;
	/** Local calendar day, YYYY-MM-DD. */
	day: string;
	sessionId: string;
	cwd: string;
	sourceEntryId: string;
	model: string;
	result: "completed" | "failed";
	reason?: string;
	detail?: string;
	text: string | null;
	usage?: { input: number; output: number; cacheRead: number; cacheWrite: number };
	cost: number;
	/** True when `cost` is the estimate: the request left, then ended with no report of its usage. */
	costEstimated?: boolean;
	cacheReadRatio?: number;
	promptTokens: number;
	examples: number;
	latencyMs: number;
	display: "ghost" | "line" | "none";
}

export type Outcome = "accepted" | "edited" | "typed" | "missed";

export interface OutcomeLine {
	kind: "outcome";
	id: string;
	at: string;
	day: string;
	outcome: Outcome;
	similarity: number;
	shown: boolean;
}

export type LogLine = PredictionLine | OutcomeLine;

/** YYYY-MM-DD in the process's time zone. */
export function localDay(date = new Date()): string {
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function monthFile(agentDir: string, day: string): string {
	return join(agentDir, LOG_DIR, `${day.slice(0, 7)}.jsonl`);
}

export function appendLog(agentDir: string, line: LogLine): void {
	mkdirSync(join(agentDir, LOG_DIR), { recursive: true });
	appendFileSync(monthFile(agentDir, line.day), `${JSON.stringify(line)}\n`);
}

function readLines(path: string): LogLine[] {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const lines: LogLine[] = [];
	for (const row of text.split("\n")) {
		if (!row) continue;
		try {
			lines.push(JSON.parse(row) as LogLine);
		} catch {
			// A torn line from a crash; skip it.
		}
	}
	return lines;
}

/** The lines of the given days (each YYYY-MM-DD), from their month files. */
export function readDays(agentDir: string, days: readonly string[]): LogLine[] {
	const wanted = new Set(days);
	const months = [...new Set(days.map((day) => day.slice(0, 7)))];
	return months.flatMap((month) =>
		readLines(join(agentDir, LOG_DIR, `${month}.jsonl`)).filter((line) => wanted.has(line.day)),
	);
}

export function spentToday(agentDir: string, today = localDay()): number {
	return readDays(agentDir, [today]).reduce((sum, line) => sum + (line.kind === "prediction" ? line.cost : 0), 0);
}

export function pruneLogs(agentDir: string, now = new Date()): void {
	const oldest = new Date(now.getFullYear(), now.getMonth() - KEEP_MONTHS + 1, 1);
	const keepFrom = localDay(oldest).slice(0, 7);
	let names: string[];
	try {
		names = readdirSync(join(agentDir, LOG_DIR));
	} catch {
		return;
	}
	for (const name of names) {
		const match = /^(\d{4}-\d{2})\.jsonl$/.exec(name);
		if (match?.[1] && match[1] < keepFrom) rmSync(join(agentDir, LOG_DIR, name), { force: true });
	}
}

export interface Stats {
	days: number;
	requests: number;
	completed: number;
	predicted: number;
	failed: Record<string, number>;
	outcomes: Record<Outcome, number>;
	shown: number;
	cost: number;
	medianLatencyMs: number | undefined;
	medianCacheReadRatio: number | undefined;
}

function median(values: number[]): number | undefined {
	if (values.length === 0) return undefined;
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? sorted[middle] : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

export function lastDays(count: number, now = new Date()): string[] {
	return Array.from({ length: count }, (_, index) => {
		const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - index);
		return localDay(date);
	});
}

export function computeStats(lines: readonly LogLine[], days: number): Stats {
	const stats: Stats = {
		days,
		requests: 0,
		completed: 0,
		predicted: 0,
		failed: {},
		outcomes: { accepted: 0, edited: 0, typed: 0, missed: 0 },
		shown: 0,
		cost: 0,
		medianLatencyMs: undefined,
		medianCacheReadRatio: undefined,
	};
	const latencies: number[] = [];
	const ratios: number[] = [];
	for (const line of lines) {
		if (line.kind === "outcome") {
			stats.outcomes[line.outcome]++;
			if (line.shown) stats.shown++;
			continue;
		}
		stats.requests++;
		stats.cost += line.cost;
		if (line.cacheReadRatio !== undefined) ratios.push(line.cacheReadRatio);
		if (line.result === "completed") {
			stats.completed++;
			latencies.push(line.latencyMs);
			if (line.text !== null) stats.predicted++;
		} else {
			const reason = line.reason ?? "unknown";
			stats.failed[reason] = (stats.failed[reason] ?? 0) + 1;
		}
	}
	stats.medianLatencyMs = median(latencies);
	stats.medianCacheReadRatio = median(ratios);
	return stats;
}

export function formatStats(stats: Stats): string {
	const percent = (value: number | undefined) => (value === undefined ? "n/a" : `${Math.round(value * 100)}%`);
	const { accepted, edited, typed, missed } = stats.outcomes;
	const decided = accepted + edited + typed + missed;
	const failures = Object.entries(stats.failed)
		.map(([reason, count]) => `${reason} ${count}`)
		.join(", ");
	return [
		`Last ${stats.days} day${stats.days === 1 ? "" : "s"}: ${stats.requests} requests, $${stats.cost.toFixed(2)}.`,
		`Predictions: ${stats.predicted} (no prediction: ${stats.completed - stats.predicted}; failed: ${failures || "none"}).`,
		`Next replies: accepted ${accepted}, edited ${edited}, typed ${typed}, missed ${missed}` +
			(decided > 0 ? ` (accepted + edited ${percent((accepted + edited) / decided)}).` : "."),
		`Shown: ${stats.shown}. Median latency: ${stats.medianLatencyMs === undefined ? "n/a" : `${(stats.medianLatencyMs / 1000).toFixed(1)} s`}. Median cache read: ${percent(stats.medianCacheReadRatio)}.`,
	].join("\n");
}
