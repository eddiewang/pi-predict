/**
 * Smoke test of the published package: pack it, load the tarball's contents into the `pi` binary of the installed
 * SDK in RPC mode, and check that this package registers `/predict` and that no extension reports an error.
 *
 *   npm run smoke
 *
 * Pi runs offline, with a temporary HOME and agent directory and no credentials. The temporary directory is removed
 * at the end. Exit 0 means pass, and 1 means fail.
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TIMEOUT_MS = 60_000;
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

/** Starts `pi --mode rpc` with the package, asks for its commands, and resolves with the response and the errors. */
function askCommands(pi: string, packageDir: string, work: string) {
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
	return new Promise<{ response: RpcRecord; errors: RpcRecord[]; stderr: string }>((resolvePromise, reject) => {
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
				if (record.type === "response" && record.id === REQUEST_ID) {
					clearTimeout(timer);
					child.kill("SIGTERM");
					resolvePromise({ response: record, errors, stderr });
				}
			}
		});
		child.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.on("exit", (code, signal) => {
			clearTimeout(timer);
			reject(new Error(`pi exited (${signal ?? code}) before it answered; stderr: ${stderr.trim()}`));
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
		const version = spawnSync(pi, ["--version"], { encoding: "utf8" }).stdout.trim();
		console.log(`smoke: ${tarball.slice(work.length + 1)} in pi ${version}`);

		const { response, errors, stderr } = await askCommands(pi, packageDir, work);
		const problems: string[] = [];
		if (!response.success) problems.push(`get_commands failed: ${response.error ?? "no error text"}`);
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
		console.log("smoke: PASS: /predict is registered by the packed package, with no extension errors");
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
