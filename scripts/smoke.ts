/**
 * Smoke test of the published package: pack it, load the tarball's contents into the `pi` binary of the installed
 * SDK in RPC mode, and check that this package registers `/predict`, that no extension reports an error, and that Pi
 * stops after SIGTERM (which runs the extensions' shutdown handlers).
 *
 *   npm run smoke
 *
 * Pi runs offline, with a temporary HOME and agent directory and no credentials. The temporary directory is removed
 * at the end. Exit 0 means pass, and 1 means fail.
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TIMEOUT_MS = 60_000;
/** How long Pi may take to stop after SIGTERM before the test kills it and fails. */
const STOP_MS = 10_000;
const REQUEST_ID = "smoke-commands";

interface RpcRecord {
	type?: string;
	id?: string;
	success?: boolean;
	error?: string;
	data?: { commands?: Array<{ name: string; source?: string; sourceInfo?: { path?: string } }> };
}

function pack(root: string, destination: string): string {
	const result = spawnSync("npm", ["pack", "--json", "--pack-destination", destination], {
		cwd: root,
		encoding: "utf8",
	});
	if (result.status !== 0) throw new Error(`npm pack failed: ${result.stderr.trim()}`);
	const [info] = JSON.parse(result.stdout) as Array<{ filename: string }>;
	if (!info) throw new Error("npm pack printed no file name");
	return join(destination, info.filename);
}

function inside(path: string, directory: string): boolean {
	const rel = relative(directory, path);
	return rel !== "" && !rel.startsWith("..");
}

interface Exchange {
	response: RpcRecord;
	/** Every `extension_error` record until Pi closed its output, also during shutdown. */
	errors: RpcRecord[];
	stderr: string;
	/** False when Pi did not stop within STOP_MS of SIGTERM and was killed. */
	stopped: boolean;
}

/**
 * Starts `pi --mode rpc` with the package and asks for its commands. After the answer, it stops Pi with SIGTERM and
 * resolves when Pi has closed its output.
 */
function askCommands(pi: string, packageDir: string, work: string): Promise<Exchange> {
	const home = join(work, "home");
	const agentDir = join(work, "agent");
	mkdirSync(home, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	const child = spawn(pi, ["--mode", "rpc", "--no-session", "-e", packageDir], {
		cwd: work,
		env: {
			PATH: process.env.PATH ?? "",
			TMPDIR: process.env.TMPDIR ?? tmpdir(),
			HOME: home,
			PI_CODING_AGENT_DIR: agentDir,
			PI_OFFLINE: "1",
			PI_SKIP_VERSION_CHECK: "1",
			PI_TELEMETRY: "0",
		},
		stdio: ["pipe", "pipe", "pipe"],
	});
	const errors: RpcRecord[] = [];
	let stderr = "";
	child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
		stderr += chunk;
	});
	return new Promise<Exchange>((resolvePromise, reject) => {
		let response: RpcRecord | undefined;
		let stopped = true;
		let stopTimer: NodeJS.Timeout | undefined;
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`no response to get_commands in ${TIMEOUT_MS / 1000} s; stderr: ${stderr.trim()}`));
		}, TIMEOUT_MS);
		let buffer = "";
		// RPC records end with LF only; U+2028 and U+2029 can occur inside JSON strings, so no readline.
		child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
			buffer += chunk;
			for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
				const line = buffer.slice(0, end).replace(/\r$/, "");
				buffer = buffer.slice(end + 1);
				if (!line.trim()) continue;
				let record: RpcRecord;
				try {
					record = JSON.parse(line) as RpcRecord;
				} catch {
					continue;
				}
				if (record.type === "extension_error") errors.push(record);
				if (record.type === "response" && record.id === REQUEST_ID && !response) {
					response = record;
					clearTimeout(timer);
					child.kill("SIGTERM");
					stopTimer = setTimeout(() => {
						stopped = false;
						child.kill("SIGKILL");
					}, STOP_MS);
				}
			}
		});
		child.on("error", (error) => {
			clearTimeout(timer);
			clearTimeout(stopTimer);
			reject(error);
		});
		// "close" comes after the last output, so shutdown errors are in `errors` by then.
		child.on("close", (code, signal) => {
			clearTimeout(timer);
			clearTimeout(stopTimer);
			if (response) resolvePromise({ response, errors, stderr, stopped });
			else reject(new Error(`pi exited (${signal ?? code}) before it answered; stderr: ${stderr.trim()}`));
		});
		child.stdin.write(`${JSON.stringify({ id: REQUEST_ID, type: "get_commands" })}\n`);
	});
}

async function main(): Promise<number> {
	const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
	const pi = join(root, "node_modules", ".bin", "pi");
	const work = mkdtempSync(join(tmpdir(), "pi-predict-smoke-"));
	try {
		const tarball = pack(root, work);
		const extracted = spawnSync("tar", ["-xzf", tarball, "-C", work], { encoding: "utf8" });
		if (extracted.status !== 0) throw new Error(`tar failed: ${extracted.stderr.trim()}`);
		const packageDir = join(work, "package");
		// The SDK's manifest, not `pi --version`: Pi reads its agent directory before it prints the version.
		const sdkManifest = join(root, "node_modules", "@earendil-works", "pi-coding-agent", "package.json");
		const { version } = JSON.parse(readFileSync(sdkManifest, "utf8")) as { version: string };
		console.log(`smoke: ${tarball.slice(work.length + 1)} in pi ${version}`);

		const { response, errors, stderr, stopped } = await askCommands(pi, packageDir, work);
		const problems: string[] = [];
		if (!response.success) problems.push(`get_commands failed: ${response.error ?? "no error text"}`);
		if (!stopped) problems.push(`pi did not stop within ${STOP_MS / 1000} s of SIGTERM`);
		const predict = response.data?.commands?.find((command) => command.name === "predict");
		if (!predict) problems.push("/predict is not registered");
		else if (predict.source !== "extension" || !inside(predict.sourceInfo?.path ?? "", packageDir)) {
			problems.push(`/predict comes from ${predict.sourceInfo?.path ?? "an unknown path"}, not the tarball`);
		}
		for (const error of errors) problems.push(`extension error: ${JSON.stringify(error)}`);
		if (problems.length > 0) {
			for (const problem of problems) console.error(`smoke: FAIL: ${problem}`);
			if (stderr.trim()) console.error(`smoke: pi stderr:\n${stderr.trim()}`);
			return 1;
		}
		console.log("smoke: PASS: the packed package registers /predict, no extension reports an error, and Pi stops");
		return 0;
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}

main().then(
	(code) => {
		process.exitCode = code;
	},
	(error: unknown) => {
		console.error(`smoke: FAIL: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	},
);
