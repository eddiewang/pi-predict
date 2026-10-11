/**
 * `<agentDir>/pi-predict.json`. Every key is optional; a missing or invalid key uses its default, and an invalid
 * value gives a warning. `/predict on|off` writes `enabled` and keeps every other key of the file.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const CONFIG_FILE = "pi-predict.json";
export const DISPLAYS = ["auto", "ghost", "line"] as const;
export type Display = (typeof DISPLAYS)[number];
export const HISTORY_SCOPES = ["project+short", "project", "all", "off"] as const;
export type HistoryScope = (typeof HISTORY_SCOPES)[number];

export interface PredictConfig {
	enabled: boolean;
	/** "auto": ghost text when the host has an editor suggestion API, else the line above the editor. */
	display: Display;
	/**
	 * Which past replies may go into the request as examples. "project" (the default) uses replies from the same
	 * working directory only; "project+short" adds short replies from all projects, which then go to the provider of
	 * the current session.
	 */
	history: HistoryScope;
	/** At most this many examples (0-12). */
	examples: number;
	/** Skip a prediction whose estimated price is above this, in dollars. */
	maxCostPerPrediction: number;
	/** Stop for the day when the predictions of the day cost this much, in dollars (all Pi processes). */
	dailyBudget: number;
	/** Two predictions in a row that read less than this share of their prompt from the cache pause the session. */
	minCacheReadRatio: number;
}

export const DEFAULT_CONFIG: Readonly<PredictConfig> = Object.freeze({
	enabled: true,
	display: "auto",
	history: "project",
	examples: 6,
	maxCostPerPrediction: 0.4,
	dailyBudget: 10,
	minCacheReadRatio: 0.8,
});

type Validator = (value: unknown) => boolean;
const isBoolean: Validator = (value) => typeof value === "boolean";
const oneOf =
	(values: readonly string[]): Validator =>
	(value) =>
		typeof value === "string" && values.includes(value);
const numberIn =
	(min: number, max: number, integer = false): Validator =>
	(value) =>
		typeof value === "number" &&
		Number.isFinite(value) &&
		value >= min &&
		value <= max &&
		(!integer || Number.isInteger(value));

const VALIDATORS: Readonly<Record<keyof PredictConfig, Validator>> = {
	enabled: isBoolean,
	display: oneOf(DISPLAYS),
	history: oneOf(HISTORY_SCOPES),
	examples: numberIn(0, 12, true),
	maxCostPerPrediction: numberIn(0, 100),
	dailyBudget: numberIn(0, 10_000),
	minCacheReadRatio: numberIn(0, 1),
};

export interface LoadedConfig {
	config: PredictConfig;
	warnings: string[];
}

function readRaw(path: string): { raw: Record<string, unknown>; warning?: string } {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { raw: {} };
		return { raw: {}, warning: `cannot read ${path}; using defaults` };
	}
	try {
		const parsed: unknown = JSON.parse(text);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
			return { raw: parsed as Record<string, unknown> };
	} catch {
		// Fall through to the warning.
	}
	return { raw: {}, warning: `${path} is not a JSON object; using defaults` };
}

export function loadConfig(agentDir: string): LoadedConfig {
	const path = join(agentDir, CONFIG_FILE);
	const { raw, warning } = readRaw(path);
	const warnings = warning ? [warning] : [];
	const config: PredictConfig = { ...DEFAULT_CONFIG };
	for (const key of Object.keys(VALIDATORS) as (keyof PredictConfig)[]) {
		if (!(key in raw)) continue;
		const value = raw[key];
		if (VALIDATORS[key](value)) (config as unknown as Record<string, unknown>)[key] = value;
		else warnings.push(`${CONFIG_FILE}: invalid "${key}"; using ${JSON.stringify(DEFAULT_CONFIG[key])}`);
	}
	return { config, warnings };
}

/** Write `enabled` and keep the other keys of the file, also unknown ones. The write is atomic. */
export function saveEnabled(agentDir: string, enabled: boolean): void {
	const path = join(agentDir, CONFIG_FILE);
	const { raw } = readRaw(path);
	const next = { ...raw, enabled };
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(next, null, "\t")}\n`);
	renameSync(temporary, path);
}
