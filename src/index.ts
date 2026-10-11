/**
 * pi-predict: when a run of the agent settles, predict the user's next message with the session model and the
 * session's cached prefix, and offer it as a suggestion that one key accepts. It never sends a message.
 *
 * Design: `docs/design.md`. It follows Codex's composer predictions
 * (`thread/prediction/*`, `experimentalPredictionMode` forks): an ephemeral request that continues the session's
 * own prompt, keyed by the message that it continues.
 *
 * Surfaces: the line above the editor (Tab), the API `Symbol.for("pi-predict:api.v1")` with the event
 * `predict:updated.v1` for other extensions, and the `/predict` command.
 */

import { type ExtensionAPI, type ExtensionCommandContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { forgetSession, installPredictApi } from "./api.ts";
import { loadConfig, saveEnabled } from "./config.ts";
import { HistoryIndex, type HistorySource } from "./history.ts";
import { computeStats, formatStats, lastDays, pruneLogs, readDays } from "./log.ts";
import { SessionPredictor } from "./predictor.ts";

export {
	PREDICT_API_KEY,
	type PredictApi,
	type PredictionListener,
	type PredictionState,
	type PredictionStateKind,
	UPDATED_EVENT,
} from "./api.ts";
export { CONFIG_FILE, DEFAULT_CONFIG, type PredictConfig } from "./config.ts";
export { WIDGET_KEY } from "./display.ts";

const SUBCOMMANDS = ["on", "off", "now", "stats", "resume"] as const;

export interface PiPredictOptions {
	/** Directory of `pi-predict.json` and `pi-predict/`. Defaults to Pi's agent directory. */
	agentDir?: string;
	/** The user's earlier replies. Defaults to the history index in the agent directory. */
	history?: HistorySource;
}

/**
 * Subscribe to an event that only some Pi builds emit. Stock Pi's event map does not name it, so the call goes
 * through a cast; stock Pi accepts the subscription and never emits the event.
 */
function onOptionalEvent(pi: ExtensionAPI, event: string, handler: () => void): void {
	(pi as unknown as { on(event: string, handler: () => void): void }).on(event, handler);
}

/** The history build waits this long after a session starts, so it does not compete with the start. */
export const HISTORY_BUILD_DELAY_MS = 5_000;

/** Create the extension. Tests pass a temporary agent directory. */
export function createPiPredict(options: PiPredictOptions = {}): (pi: ExtensionAPI) => void {
	return function piPredict(pi: ExtensionAPI): void {
		installPredictApi();
		let predictor: SessionPredictor | undefined;
		let index: HistoryIndex | undefined;
		let buildTimer: ReturnType<typeof setTimeout> | undefined;
		const agentDir = () => options.agentDir ?? getAgentDir();

		const end = () => {
			if (buildTimer) clearTimeout(buildTimer);
			buildTimer = undefined;
			const current = predictor;
			predictor = undefined;
			if (!current) return;
			current.dispose();
			forgetSession(current.sessionId);
		};

		pi.on("session_start", (_event, ctx) => {
			end();
			const dir = agentDir();
			const { config, warnings } = loadConfig(dir);
			if (ctx.hasUI) for (const warning of warnings) ctx.ui.notify(`pi-predict: ${warning}`, "warning");
			try {
				pruneLogs(dir);
			} catch {
				// Old logs stay until the next start.
			}
			let history = options.history;
			if (!history && config.enabled && config.history !== "off") {
				if (!index) index = new HistoryIndex(dir);
				const shared = index;
				history = shared;
				void shared.load();
				// The live session's own exchanges are already in its context.
				const skipFile = ctx.sessionManager.getSessionFile();
				buildTimer = setTimeout(() => {
					buildTimer = undefined;
					void shared.refresh(skipFile ? { skipFile } : {}).catch(() => undefined);
				}, HISTORY_BUILD_DELAY_MS);
				buildTimer.unref?.();
			}
			predictor = new SessionPredictor({ pi, ctx, agentDir: dir, config, ...(history ? { history } : {}) });
		});

		pi.on("context_with_system", (event, ctx) => {
			predictor?.noteContext(ctx.sessionManager.getLeafId(), event.messages);
			return undefined;
		});
		pi.on("before_provider_request", (event) => {
			predictor?.notePayload(event.payload);
			return undefined;
		});

		// The prediction runs after the handler returns: `agent_settled` only notifies.
		pi.on("agent_settled", (_event, ctx) => {
			const current = predictor;
			if (current) void current.predict(ctx).catch(() => undefined);
		});
		pi.on("input", (event) => {
			predictor?.onInput(event.text);
			return undefined;
		});
		pi.on("agent_start", () => predictor?.cancel());
		// The captured request no longer matches the branch or the model.
		pi.on("session_tree", () => predictor?.reset());
		pi.on("session_compact", () => predictor?.reset());
		// Pi builds with context windows start a new window without a compaction.
		onOptionalEvent(pi, "session_context_window", () => predictor?.reset());
		pi.on("model_select", () => predictor?.reset());
		pi.on("ui_prompt_start", () => predictor?.onPromptOpen(true));
		pi.on("ui_prompt_end", () => predictor?.onPromptOpen(false));
		pi.on("session_shutdown", end);

		pi.registerCommand("predict", {
			description: "Next-reply predictions: on, off, now, stats, resume (no argument: status)",
			getArgumentCompletions: (prefix) =>
				SUBCOMMANDS.filter((name) => name.startsWith(prefix.trim())).map((name) => ({ value: name, label: name })),
			handler: async (args, ctx) => {
				ctx.ui.notify(await runCommand(args.trim(), ctx), "info");
			},
		});

		async function runCommand(command: string, ctx: ExtensionCommandContext): Promise<string> {
			const current = predictor;
			if (!current) return "pi-predict has no session yet.";
			switch (command) {
				case "":
					return current.status();
				case "on":
				case "off": {
					const enabled = command === "on";
					saveEnabled(agentDir(), enabled);
					current.config.enabled = enabled;
					if (!enabled) current.cancel();
					return `pi-predict is ${command}.`;
				}
				case "now": {
					const skip = await current.predict(ctx, true);
					return skip ? `No prediction: ${skip}.` : current.status();
				}
				case "stats": {
					const days = lastDays(7);
					const today = computeStats(readDays(agentDir(), days.slice(0, 1)), 1);
					const week = computeStats(readDays(agentDir(), days), 7);
					return `${formatStats(today)}\n\n${formatStats(week)}`;
				}
				case "resume":
					current.resume();
					return "pi-predict resumed.";
				default:
					return `Unknown argument "${command}". Use: ${SUBCOMMANDS.join(", ")}.`;
			}
		}
	};
}

export default createPiPredict();
