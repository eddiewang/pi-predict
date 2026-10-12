/**
 * Make `docs/demo.svg`, the README's demo: run Pi with this package in a tmux pane, capture three frames, and draw
 * them as one animated SVG.
 *
 *   node scripts/demo/make.ts
 *
 * Needs tmux, fd, ripgrep, and python3 with fontTools. Pi comes from node_modules, so run `npm ci` first. Pi runs
 * offline in a temporary HOME. A local fake provider streams fixed replies, so the run needs no credentials and costs
 * nothing. The frames are:
 *
 *   A  the agent's reply, before the prediction arrives
 *   B  the prediction above the editor
 *   C  the editor after Tab
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = join(ROOT, "docs/demo.svg");
const SOCKET = "pi-predict-demo";
const COLS = 80;
/** The transcript, the prediction line, the editor, and the footer, with nothing scrolled off. */
const ROWS = 13;
const MODEL = "claude-opus-5";

const REQUEST = "the retry test is flaky on CI. find out why and fix it";
const REPLY =
	"Fixed. The retry test waited on real timers, so the 250 ms backoff raced the CI timeout. It now uses fake timers, and all 43 tests pass.";
const PREDICTION = "commit and push";
/** The prediction arrives this long after its request, so that frame A shows the reply alone. */
const PREDICTION_DELAY_MS = 4_000;

interface Usage {
	prompt_tokens: number;
	completion_tokens: number;
	prompt_tokens_details: { cached_tokens: number; cache_write_tokens: number };
}

const REPLY_USAGE: Usage = {
	prompt_tokens: 24_310,
	completion_tokens: 141,
	prompt_tokens_details: { cached_tokens: 23_612, cache_write_tokens: 686 },
};
const PREDICTION_USAGE: Usage = {
	prompt_tokens: 24_660,
	completion_tokens: 6,
	prompt_tokens_details: { cached_tokens: 24_310, cache_write_tokens: 338 },
};

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) return content.map((part: { text?: unknown }) => String(part?.text ?? "")).join("");
	return "";
}

/** An OpenAI-compatible endpoint: the reply for the agent's request, the prediction for pi-predict's request. */
async function answer(request: IncomingMessage, response: ServerResponse, seen: string[]): Promise<void> {
	let raw = "";
	for await (const chunk of request) raw += chunk;
	if (!request.url?.endsWith("/chat/completions")) {
		response.writeHead(404).end();
		return;
	}
	const body = JSON.parse(raw) as { model?: string; messages?: Array<{ content?: unknown }> };
	const isPrediction = (body.messages ?? []).some((m) => textOf(m.content).includes("<next_message_prediction>"));
	seen.push(isPrediction ? "prediction" : "reply");
	const [text, usage] = isPrediction ? [PREDICTION, PREDICTION_USAGE] : [REPLY, REPLY_USAGE];

	response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
	const base = { id: "chatcmpl-demo", object: "chat.completion.chunk", created: 0, model: body.model };
	const send = (chunk: object) => response.write(`data: ${JSON.stringify({ ...base, ...chunk })}\n\n`);
	await sleep(isPrediction ? PREDICTION_DELAY_MS : 300);
	for (const word of text.match(/\S+\s*/g) ?? []) {
		send({ choices: [{ index: 0, delta: { content: word }, finish_reason: null }] });
		await sleep(20);
	}
	send({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
	send({ choices: [], usage });
	response.end("data: [DONE]\n\n");
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv = process.env): string {
	const result = spawnSync(command, args, { encoding: "utf8", env });
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`${command} ${args.join(" ")}: ${result.stderr.trim()}`);
	return result.stdout;
}

function which(command: string): string {
	const path = spawnSync("sh", ["-c", `command -v ${command}`], { encoding: "utf8" }).stdout.trim();
	if (!path) throw new Error(`${command} is not on PATH`);
	return path;
}

const tmux = (...args: string[]) => run("tmux", ["-L", SOCKET, ...args]);
const screen = () => tmux("capture-pane", "-p", "-t", "demo");
const frame = () => tmux("capture-pane", "-p", "-e", "-N", "-t", "demo");

async function waitFor(what: string, test: () => boolean, timeoutMs = 30_000): Promise<void> {
	const end = Date.now() + timeoutMs;
	while (!test()) {
		if (Date.now() > end) throw new Error(`timed out: ${what}\n${screen()}`);
		await sleep(100);
	}
}

async function main(): Promise<void> {
	const pi = join(ROOT, "node_modules/.bin/pi");
	which("tmux");
	run("python3", ["-c", "import fontTools"]);
	// Without them, Pi prints a warning into the transcript, and offline mode does not download them.
	which("fd");
	which("rg");

	// realpath: on macOS, /var is a link, and Pi shortens the cwd only under the real HOME.
	const tmp = realpathSync(mkdtempSync(join(tmpdir(), "pi-predict-demo-")));
	const home = join(tmp, "home");
	const agentDir = join(home, ".pi/agent");
	const project = join(home, "code/relay");
	const frames = join(tmp, "frames");
	for (const dir of [agentDir, project, frames]) mkdirSync(dir, { recursive: true });

	const seen: string[] = [];
	const server = createServer((request, response) => void answer(request, response, seen));
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	const { port } = server.address() as AddressInfo;

	try {
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({
				theme: "dark",
				quietStartup: true,
				defaultProvider: "demo",
				defaultModel: MODEL,
				defaultThinkingLevel: "medium",
				defaultProjectTrust: "always",
			}),
		);
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					demo: {
						baseUrl: `http://127.0.0.1:${port}/v1`,
						api: "openai-completions",
						apiKey: "demo",
						models: [
							{
								id: MODEL,
								reasoning: true,
								input: ["text"],
								contextWindow: 200_000,
								maxTokens: 64_000,
								cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
							},
						],
					},
				},
			}),
		);
		const git = (...args: string[]) => run("git", ["-C", project, ...args]);
		git("init", "-q", "-b", "main");
		git("-c", "user.name=demo", "-c", "user.email=demo@example.com", "commit", "-q", "--allow-empty", "-m", "init");

		// A clean environment: no provider keys, and the pane runs /bin/sh, so no shell profile changes PATH.
		const launcher = join(tmp, "pi.sh");
		writeFileSync(launcher, `#!/bin/sh\ncd '${project}' && exec '${pi}' -e '${ROOT}'\n`, { mode: 0o755 });
		const conf = join(tmp, "tmux.conf");
		writeFileSync(
			conf,
			[
				"set -g default-shell /bin/sh",
				"set -g default-terminal tmux-256color",
				"set -as terminal-features ',*:RGB'",
				"set -g extended-keys on",
				"set -g extended-keys-format csi-u",
				"set -g escape-time 10",
				"set -g status off",
				"",
			].join("\n"),
		);
		const env = {
			PATH: process.env.PATH,
			HOME: home,
			USER: userInfo().username,
			LANG: "en_US.UTF-8",
			LC_ALL: "en_US.UTF-8",
			TERM: "xterm-256color",
			COLORTERM: "truecolor",
			PI_CODING_AGENT_DIR: agentDir,
			PI_OFFLINE: "1",
			PI_SKIP_VERSION_CHECK: "1",
			PI_TELEMETRY: "0",
			PI_TRUE_COLOR: "1",
		};
		spawnSync("tmux", ["-L", SOCKET, "kill-server"], { stdio: "ignore" });
		const size = ["-x", String(COLS), "-y", String(ROWS)];
		run("tmux", ["-L", SOCKET, "-f", conf, "new-session", "-d", "-s", "demo", ...size, launcher], env);

		await waitFor("Pi starts", () => screen().includes(MODEL));
		tmux("send-keys", "-t", "demo", "-l", REQUEST);
		await sleep(300);
		tmux("send-keys", "-t", "demo", "Enter");
		await waitFor("pi-predict sends its request", () => seen.includes("prediction"));
		await sleep(600);
		const a = frame();
		await waitFor("the prediction shows", () => screen().includes(`↳ ${PREDICTION}`));
		await sleep(300);
		const b = frame();
		tmux("send-keys", "-t", "demo", "Tab");
		await waitFor("Tab fills the editor", () => !screen().includes("↳"));
		await sleep(300);
		const c = frame();

		if (!b.includes(REQUEST)) throw new Error(`frame B lost the request; raise ROWS\n${screen()}`);
		for (const [name, text] of Object.entries({ A: a, B: b, C: c })) writeFileSync(join(frames, name), text);

		const render = spawnSync(
			"python3",
			[
				join(ROOT, "scripts/demo/render.py"),
				"--frames",
				...["A", "B", "C"].map((name) => `${name}=${join(frames, name)}`),
				"--css",
				join(ROOT, "scripts/demo/demo.css"),
				"--cols",
				String(COLS),
				"--rows",
				String(ROWS),
				"--title",
				"pi-predict in Pi",
				"--desc",
				`After the agent's reply, the line “↳ ${PREDICTION}  tab” shows above the editor. Tab puts “${PREDICTION}” in the editor.`,
				"--out",
				OUT,
			],
			{ stdio: "inherit" },
		);
		if (render.status !== 0) throw new Error(`render.py exited with ${render.status}`);
	} finally {
		spawnSync("tmux", ["-L", SOCKET, "kill-server"], { stdio: "ignore" });
		server.close();
		rmSync(tmp, { recursive: true, force: true });
	}
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
});
