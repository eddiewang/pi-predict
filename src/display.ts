/**
 * Where a prediction shows in the terminal (plan D10). The line display is a widget above the editor: it shows the
 * prediction while the draft is empty, and Tab puts the prediction in the editor. It never replaces the editor, so
 * pi-droid-theme keeps its frame. Nothing is sent; the owner presses Enter.
 */

import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, type TUI, truncateToWidth } from "@earendil-works/pi-tui";

export const WIDGET_KEY = "pi-predict";

export interface PredictionDisplay {
	readonly kind: "line" | "ghost";
	show(text: string): void;
	clear(): void;
	/** Whether the owner could see the prediction that `show` set last. */
	readonly shown: boolean;
	/** Whether the owner took that prediction with the key. */
	readonly acceptedByKey: boolean;
	setPromptOpen(open: boolean): void;
	dispose(): void;
}

export class LineDisplay implements PredictionDisplay {
	readonly kind = "line" as const;
	private text: string | undefined;
	private wasShown = false;
	private tookKey = false;
	private promptOpen = false;
	private tui: TUI | undefined;
	private readonly ui: ExtensionUIContext;
	private readonly isIdle: () => boolean;
	private readonly unsubscribeInput: () => void;

	constructor(ui: ExtensionUIContext, isIdle: () => boolean) {
		this.ui = ui;
		this.isIdle = isIdle;
		ui.setWidget(
			WIDGET_KEY,
			(tui, theme) => {
				this.tui = tui;
				return {
					render: (width: number) => this.render(width, theme),
					invalidate: () => {},
					dispose: () => {
						if (this.tui === tui) this.tui = undefined;
					},
				};
			},
			{ placement: "aboveEditor" },
		);
		this.unsubscribeInput = ui.onTerminalInput((data) => {
			if (!matchesKey(data, "tab") || !this.visible()) return undefined;
			const text = this.text as string;
			this.ui.setEditorText(text);
			// Tab works only while the line can show, so the owner had it in front of them.
			this.wasShown = true;
			this.tookKey = true;
			this.tui?.requestRender();
			return { consume: true };
		});
	}

	get shown(): boolean {
		return this.wasShown;
	}

	get acceptedByKey(): boolean {
		return this.tookKey;
	}

	show(text: string): void {
		this.text = text;
		this.wasShown = false;
		this.tookKey = false;
		this.tui?.requestRender();
	}

	clear(): void {
		if (this.text === undefined) return;
		this.text = undefined;
		this.tui?.requestRender();
	}

	setPromptOpen(open: boolean): void {
		this.promptOpen = open;
	}

	dispose(): void {
		this.text = undefined;
		this.unsubscribeInput();
		this.ui.setWidget(WIDGET_KEY, undefined);
	}

	private visible(): boolean {
		return this.text !== undefined && !this.promptOpen && this.isIdle() && this.ui.getEditorText() === "";
	}

	private render(width: number, theme: Theme): string[] {
		if (!this.visible() || width < 8) return [];
		this.wasShown = true;
		const [first = "", ...rest] = (this.text as string).split("\n");
		const body = rest.length > 0 ? `${first} …` : first;
		const hint = "  tab";
		const room = Math.max(1, width - 2 - hint.length);
		return [theme.fg("dim", "↳ ") + truncateToWidth(theme.fg("muted", body), room) + theme.fg("dim", hint)];
	}
}
