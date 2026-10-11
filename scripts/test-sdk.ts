/**
 * Run the tests against Pi SDK tarballs instead of the npm versions in the lockfile, for example the release of a Pi
 * fork or a local build of Pi:
 *
 *   npm run test:sdk -- <directory> [vitest arguments]
 *
 * The directory holds `pi-ai.tgz`, `pi-coding-agent.tgz` and `pi-tui.tgz`, and `pi-agent-core.tgz` when the build
 * changes that package. The script copies this repository's files (tracked files, and new files that git does not
 * ignore) into a temporary directory. There it points the SDK packages at the tarballs, with `overrides` so that every
 * dependent gets the same copy, and pins the other `@earendil-works/*` packages that the tarballs need to the version
 * of `pi-coding-agent.tgz`. Then it installs with lifecycle scripts disabled and runs Vitest. The working tree and its
 * node_modules do not change. Tests that need a feature of such a build run only there.
 *
 * Set PI_PREDICT_KEEP_SDK_DIR=1 to keep the temporary directory.
 */

import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCOPE = "@earendil-works";
const REQUIRED = ["pi-ai", "pi-coding-agent", "pi-tui"];
const OPTIONAL = ["pi-agent-core"];

interface Manifest {
	version?: string;
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
	overrides?: Record<string, string>;
}

class SdkError extends Error {}

function run(command: string, args: string[], cwd: string, capture = false): SpawnSyncReturns<string> {
	const result = spawnSync(command, args, {
		cwd,
		encoding: "utf8",
		stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
	});
	if (result.error) throw new SdkError(`${command}: ${result.error.message}`);
	return result;
}

function tarballManifest(path: string): Manifest {
	const result = run("tar", ["-xzOf", path, "package/package.json"], dirname(path), true);
	if (result.status !== 0) throw new SdkError(`cannot read package/package.json in ${path}`);
	return JSON.parse(result.stdout) as Manifest;
}

function main(argv: string[]): number {
	const [sdkArg, ...vitestArgs] = argv;
	if (!sdkArg) {
		throw new SdkError("usage: npm run test:sdk -- <directory with pi-ai.tgz, pi-coding-agent.tgz, pi-tui.tgz>");
	}
	const sdk = resolve(sdkArg);
	const tarballs = new Map<string, string>();
	for (const name of [...REQUIRED, ...OPTIONAL]) {
		const path = join(sdk, `${name}.tgz`);
		if (existsSync(path)) tarballs.set(`${SCOPE}/${name}`, path);
		else if (REQUIRED.includes(name)) throw new SdkError(`${path} does not exist`);
	}
	const sdkVersion = tarballManifest(join(sdk, "pi-coding-agent.tgz")).version;
	if (!sdkVersion) throw new SdkError("pi-coding-agent.tgz has no version");
	const scoped = new Set<string>();
	for (const path of tarballs.values()) {
		for (const name of Object.keys(tarballManifest(path).dependencies ?? {})) {
			if (name.startsWith(`${SCOPE}/`)) scoped.add(name);
		}
	}

	const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
	const work = mkdtempSync(join(tmpdir(), "pi-predict-sdk-"));
	try {
		const files = run("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], root, true);
		if (files.status !== 0) throw new SdkError("git ls-files failed");
		for (const file of files.stdout.split("\0")) {
			// The lockfile pins the npm SDK; the install below resolves the tarballs instead.
			if (!file || file === "package-lock.json" || !existsSync(join(root, file))) continue;
			mkdirSync(dirname(join(work, file)), { recursive: true });
			cpSync(join(root, file), join(work, file));
		}
		const manifestPath = join(work, "package.json");
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
		const devDependencies = { ...manifest.devDependencies };
		const overrides: Record<string, string> = {};
		for (const [name, path] of tarballs) {
			devDependencies[name] = `file:${path}`;
			overrides[name] = `$${name}`;
		}
		for (const name of scoped) overrides[name] ??= sdkVersion;
		writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, devDependencies, overrides }, null, 2)}\n`);

		console.log(`test:sdk: ${sdk} (pi-coding-agent ${sdkVersion}) in ${work}`);
		const install = run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error"], work);
		if (install.status !== 0) throw new SdkError(`npm install exited ${install.status}`);
		return run("npm", ["test", "--", ...vitestArgs], work).status ?? 1;
	} finally {
		if (process.env.PI_PREDICT_KEEP_SDK_DIR) console.log(`test:sdk: kept ${work}`);
		else rmSync(work, { recursive: true, force: true });
	}
}

try {
	process.exitCode = main(process.argv.slice(2));
} catch (error) {
	if (!(error instanceof SdkError)) throw error;
	console.error(`test:sdk: ${error.message}`);
	process.exitCode = 2;
}
