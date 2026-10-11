/**
 * Remove the ambient environment before any suite runs. The same file as
 * `tests/support/hermetic-env.ts` in the author's Pi configuration repository.
 *
 * Pi and its packages read configuration from
 * environment variables and from paths derived from `HOME` and `XDG_*`. An
 * inherited value is indistinguishable from a deliberate one, so a suite run
 * from inside a Pi session, a tmux pane, or an `npm test` script would test a
 * configuration nobody chose, and could read or write the operator's live
 * `~/.pi`, `~/.config`, or `~/.local/share`.
 *
 * - `PI_*` and `PIE_*` are scrubbed by prefix, so a new variable cannot bring
 *   the problem back under a new name. Suites that need one set it explicitly.
 * - `TMUX*` is scrubbed so a best-effort `tmux` call cannot reach the live
 *   server.
 * - `GIT_*` is scrubbed (a git hook exports `GIT_DIR`, which would redirect
 *   fixture repositories to the real one), and system git config is ignored.
 * - `npm_*` is scrubbed in any case: `npm test` exports `npm_config_cache`
 *   and `npm_config_userconfig` pointing at the real home, which a nested
 *   `npm` call would otherwise use, and npm also reads `NPM_CONFIG_*`.
 * - `HOME`, `USERPROFILE` and the XDG base directories point at a fresh
 *   temporary root. Node resolves `os.homedir()` from `$HOME` on POSIX, so the
 *   default Pi agent dir moves with it.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach } from "vitest";

const SCRUBBED = /^(?:PIE?_|TMUX|GIT_|XDG_)/;
/** npm reads its config from `npm_config_*` in any case (`@npmcli/config`). */
const NPM = /^npm_/i;

for (const key of Object.keys(process.env)) {
	if (SCRUBBED.test(key) || NPM.test(key)) delete process.env[key];
}

export const hermeticRoot = join(tmpdir(), `pi-predict-vitest-${process.pid}-${randomUUID()}`);

const REDIRECTED = {
	HOME: hermeticRoot,
	USERPROFILE: hermeticRoot,
	XDG_CONFIG_HOME: join(hermeticRoot, ".config"),
	XDG_DATA_HOME: join(hermeticRoot, ".local", "share"),
	XDG_STATE_HOME: join(hermeticRoot, ".local", "state"),
	XDG_CACHE_HOME: join(hermeticRoot, ".cache"),
} as const;

for (const [key, value] of Object.entries(REDIRECTED)) process.env[key] = value;
process.env.GIT_CONFIG_NOSYSTEM = "1";
mkdirSync(hermeticRoot, { recursive: true, mode: 0o700 });

/**
 * Keep the redirection true for the whole file, not just its first test.
 *
 * `os.homedir()` reads `$HOME` on every call and falls back to the password
 * database when the variable is absent, so a suite that "restores" HOME by
 * deleting it hands the real home back to every later caller.
 * `os.userInfo().homedir` ignores `$HOME`, so it is the reference point.
 * Repairing before failing attributes the breach to the suite that caused it
 * without poisoning the rest of the file.
 */
const realHome = resolve(userInfo().homedir);

const tempUnderHome = resolve(hermeticRoot).startsWith(`${realHome}/`);

function underRealHome(value: string): boolean {
	const resolved = resolve(value);
	if (resolved === realHome) return true;
	// A TMPDIR inside the home directory is legitimate; then only the exact home
	// is a breach, because every temporary path would match the prefix.
	return !tempUnderHome && resolved.startsWith(`${realHome}/`);
}

export function assertHermeticHome(phase: "before" | "after"): void {
	const breaches: string[] = [];
	for (const [key, expected] of Object.entries(REDIRECTED)) {
		const value = process.env[key];
		if (value === undefined || value === "") breaches.push(`${key} is unset`);
		else if (underRealHome(value)) breaches.push(`${key} points into the real home directory`);
		else continue;
		process.env[key] = expected;
	}
	if (breaches.length === 0) return;
	const when = phase === "before" ? "before this test ran" : "after this test ran";
	throw new Error(
		`Test environment left the operator's real home reachable ${when}: ${breaches.join("; ")}. ` +
			"Restore the saved value instead of deleting it, or point it at a temporary directory. " +
			`The hermetic root for this file is ${hermeticRoot}.`,
	);
}

try {
	beforeEach(() => assertHermeticHome("before"));
	afterEach(() => assertHermeticHome("after"));
} catch {
	// A plain Node process can load this module to check the scrubbing. Hook
	// registration throws there because no runner exists, and without a runner
	// there are no tests to guard.
}
