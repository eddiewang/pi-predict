import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Api,
	type AssistantMessage,
	type FauxModelDefinition,
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxProvider,
	type Model,
	type SimpleStreamOptions,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionContext,
	type ExtensionFactory,
	type ExtensionUIContext,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { expect } from "vitest";
import { PREDICT_API_KEY, type PredictApi, type PredictionState } from "../src/api.ts";
import { createPiPredict, type PiPredictOptions } from "../src/index.ts";
import type { LogLine } from "../src/log.ts";
import { readDays } from "../src/log.ts";

export const MAIN_PROMPT = "Main assistant prompt.";
export const TAB = "\t";

export function api(): PredictApi {
	const value = (globalThis as Record<symbol, unknown>)[PREDICT_API_KEY] as PredictApi | undefined;
	if (!value) throw new Error("pi-predict API is not installed");
	return value;
}

export function textOf(message: unknown): string {
	const content = (message as { content?: unknown } | undefined)?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part: { type?: string }) => part.type === "text")
		.map((part: { text: string }) => part.text)
		.join("\n");
}

/** A manual gate: a faux step waits for `open()` or for the request's abort. */
export function gate() {
	let release!: () => void;
	const opened = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { open: () => release(), opened };
}

/** What a provider would send: a payload built from the request, as the Anthropic provider builds one. */
export function payloadOf(context: TranscriptContext, options: SimpleStreamOptions | undefined) {
	return {
		model: "test",
		max_tokens: options?.maxTokens ?? 16_384,
		stream: true,
		messages: context.messages.map((message) => ({
			role: message.role,
			content: (message as { content?: unknown }).content ?? null,
		})),
	};
}

export interface Exchange {
	context: TranscriptContext;
	options: SimpleStreamOptions | undefined;
	/** What `onPayload` returned, or the error that it threw (then the provider sends nothing). */
	payloadError?: unknown;
}

/**
 * A faux step that acts as a provider: it builds the payload, awaits `onPayload` (a throw there means nothing is
 * sent, so the step rethrows), optionally waits for `until` or the abort, then answers.
 */
export function provider(
	exchanges: Exchange[],
	answer: string | AssistantMessage,
	options: { until?: Promise<void>; entered?: () => void } = {},
): FauxResponseStep {
	return async (context, streamOptions, _state, model) => {
		const exchange: Exchange = { context, options: streamOptions };
		exchanges.push(exchange);
		try {
			await streamOptions?.onPayload?.(payloadOf(context, streamOptions), model as Model<Api>);
		} catch (error) {
			exchange.payloadError = error;
			throw error;
		}
		options.entered?.();
		if (options.until) {
			const until = options.until;
			await new Promise<void>((resolve) => {
				until.then(resolve);
				streamOptions?.signal?.addEventListener("abort", () => resolve(), { once: true });
			});
		}
		return typeof answer === "string" ? fauxAssistantMessage(answer) : answer;
	};
}

/** A terminal UI with an editor, widgets, and raw input, enough for the line display. */
export function fakeTerminal() {
	let editor = "";
	const widgets = new Map<string, ((tui: TUI, theme: unknown) => Component) | string[] | undefined>();
	const inputs = new Set<(data: string) => { consume?: boolean; data?: string } | undefined>();
	const notes: Array<{ message: string; type: string | undefined }> = [];
	const theme = { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text };
	const tui = { requestRender: () => {} } as unknown as TUI;
	const components = new Map<string, Component>();
	const ui: Partial<ExtensionUIContext> = {
		theme: theme as unknown as ExtensionUIContext["theme"],
		notify: (message, type) => {
			notes.push({ message, type });
		},
		setStatus: () => {},
		setWidget: ((key: string, content: unknown) => {
			widgets.set(key, content as never);
			components.delete(key);
		}) as ExtensionUIContext["setWidget"],
		onTerminalInput: (handler) => {
			inputs.add(handler);
			return () => inputs.delete(handler);
		},
		getEditorText: () => editor,
		setEditorText: (text) => {
			editor = text;
		},
	};
	return {
		ui,
		notes,
		get editor() {
			return editor;
		},
		set editor(text: string) {
			editor = text;
		},
		/** Raw input: the listeners see it first; an unconsumed printable key goes to the editor. */
		press(data: string): boolean {
			for (const handler of [...inputs]) if (handler(data)?.consume) return true;
			if (data !== TAB) editor += data;
			return false;
		},
		/** The widget's lines at this width ([] when it has no widget). */
		render(key: string, width = 80): string[] {
			const content = widgets.get(key);
			if (!content) return [];
			if (Array.isArray(content)) return content;
			let component = components.get(key);
			if (!component) {
				component = content(tui, theme);
				components.set(key, component);
			}
			return component.render(width);
		},
	};
}

export type Harness = Awaited<ReturnType<typeof createHarness>>;

export async function createHarness(
	options: {
		mode?: ExtensionContext["mode"];
		/** Extensions loaded before pi-predict (their payload changes come first). */
		before?: ExtensionFactory[];
		predict?: Omit<PiPredictOptions, "agentDir">;
		/** Model prices per million tokens (default: the owner's claude-opus-5-5 prices). */
		cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
		/** Other fields of the faux model, such as `input` and `inputLimits`. */
		model?: Omit<FauxModelDefinition, "id" | "cost">;
	} = {},
) {
	const root = mkdtempSync(join(tmpdir(), "pi-predict-"));
	const agentDir = join(root, "agent");
	const faux = fauxProvider({
		provider: `predict-${Math.random().toString(36).slice(2)}`,
		api: "anthropic-messages",
		tokensPerSecond: 0,
		models: [
			{
				id: "test",
				contextWindow: 500_000,
				...options.model,
				cost: options.cost ?? { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
			},
		],
	});
	const modelRuntime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null });
	modelRuntime.registerNativeProvider(faux.provider);
	await modelRuntime.setRuntimeApiKey(faux.provider.id, "fixture-key");
	const settings = SettingsManager.inMemory(
		{ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" },
		{ projectTrusted: true },
	);
	const sessionManager = SessionManager.create(root, join(root, "sessions"));
	const errors: string[] = [];
	const terminal = fakeTerminal();
	const resourceLoader = new DefaultResourceLoader({
		cwd: root,
		agentDir: root,
		settingsManager: settings,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		systemPromptOverride: () => MAIN_PROMPT,
		extensionFactories: [
			...(options.before ?? []).map((factory, index) => ({ name: `before-${index}`, factory })),
			{ name: "pi-predict", factory: createPiPredict({ agentDir, ...options.predict }) },
		],
	});
	await resourceLoader.reload();
	expect(resourceLoader.getExtensions().errors).toEqual([]);
	const { session } = await createAgentSession({
		cwd: root,
		agentDir: root,
		model: faux.getModel(),
		modelRuntime,
		settingsManager: settings,
		sessionManager,
		resourceLoader,
	});
	const mode = options.mode ?? "tui";
	await session.bindExtensions({
		mode,
		...(mode === "tui" || mode === "rpc" ? { uiContext: terminal.ui as ExtensionUIContext } : {}),
		onError: (error) => errors.push(error.error),
	});
	const sessionId = sessionManager.getSessionId();
	const states: PredictionState[] = [];
	const unsubscribe = api().subscribe((state) => {
		if (state.sessionId === sessionId) states.push(state);
	});

	const harness = {
		root,
		agentDir,
		faux,
		modelRuntime,
		session: session as AgentSession,
		sessionManager,
		sessionId,
		terminal,
		states,
		errors,
		/** Resolves with the first state of the session that satisfies `test`, after the states seen so far. */
		async waitForState(test: (state: PredictionState) => boolean, from = 0): Promise<PredictionState> {
			for (let waited = 0; waited < 5_000; waited += 5) {
				const found = states.slice(from).find(test);
				if (found) return found;
				await new Promise((resolve) => setTimeout(resolve, 5));
			}
			throw new Error(`no matching state; seen: ${JSON.stringify(states)}`);
		},
		/** Let pending handlers and microtasks run. */
		async settle(ms = 30): Promise<void> {
			await new Promise((resolve) => setTimeout(resolve, ms));
		},
		log(): LogLine[] {
			const today = new Date();
			const pad = (value: number) => String(value).padStart(2, "0");
			const day = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
			return readDays(agentDir, [day]);
		},
		async command(text: string): Promise<string> {
			const before = terminal.notes.length;
			await session.prompt(text);
			return terminal.notes
				.slice(before)
				.map((note) => note.message)
				.join("\n");
		},
		async cleanup() {
			try {
				await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
				expect(errors).toEqual([]);
			} finally {
				unsubscribe();
				session.dispose();
				rmSync(root, { recursive: true, force: true });
			}
		},
	};
	return harness;
}
