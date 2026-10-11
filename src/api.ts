/**
 * The prediction API in the Pi process, `globalThis[Symbol.for("pi-predict:api.v1")]`, for readers such as
 * the Pi extension of a remote client. It follows Codex's `thread/prediction/updated`: each state names the session and the message
 * entry that the prediction continues (`sourceEntryId`, Codex's `sourceTurnId`). Each change also goes to
 * `pi.events` as `predict:updated.v1`.
 *
 * The registry lives on `globalThis`, so a module reload (`/reload`) keeps the listeners of a reader that loaded
 * earlier.
 */

export const PREDICT_API_KEY = Symbol.for("pi-predict:api.v1");
const PREDICT_REGISTRY_KEY = Symbol.for("pi-predict:registry.v1");
export const UPDATED_EVENT = "predict:updated.v1";

export type PredictionStateKind = "running" | "completed" | "failed" | "cleared";

export interface PredictionState {
	sessionId: string;
	/** The id of the last message entry on the branch when the run settled. */
	sourceEntryId: string;
	/** "cleared": the prediction is stale (a new message, a tree move, a compaction, a model change, an end). */
	state: PredictionStateKind;
	/** The predicted message; null while running, when the model had no prediction, on failure, and when cleared. */
	text: string | null;
	/** Unix time in milliseconds. */
	at: number;
}

export type PredictionListener = (state: PredictionState) => void;

export interface PredictApi {
	readonly version: 1;
	/** The session's latest state; undefined before its first prediction. */
	current(sessionId: string): PredictionState | undefined;
	/** Every state of every session. Returns the unsubscribe function. */
	subscribe(listener: PredictionListener): () => void;
}

interface Registry {
	states: Map<string, PredictionState>;
	listeners: Set<PredictionListener>;
}

function registry(): Registry {
	const globals = globalThis as Record<symbol, unknown>;
	let state = globals[PREDICT_REGISTRY_KEY] as Registry | undefined;
	if (!state) {
		state = { states: new Map(), listeners: new Set() };
		globals[PREDICT_REGISTRY_KEY] = state;
	}
	return state;
}

export function installPredictApi(): void {
	registry();
	const api: PredictApi = {
		version: 1,
		current: (sessionId) => {
			const state = registry().states.get(sessionId);
			return state ? { ...state } : undefined;
		},
		subscribe: (listener) => {
			const { listeners } = registry();
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
	(globalThis as Record<symbol, unknown>)[PREDICT_API_KEY] = Object.freeze(api);
}

/** Record the state, then tell the listeners. A listener that throws does not stop the others. */
export function publishState(state: PredictionState, emit?: (channel: string, data: unknown) => void): void {
	const { states, listeners } = registry();
	states.set(state.sessionId, state);
	for (const listener of [...listeners]) {
		try {
			listener({ ...state });
		} catch {
			// A reader's failure is its own.
		}
	}
	emit?.(UPDATED_EVENT, { ...state });
}

/** Forget a session that ended. */
export function forgetSession(sessionId: string): void {
	registry().states.delete(sessionId);
}
