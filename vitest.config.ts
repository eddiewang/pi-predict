import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Every suite starts from the hermetic environment: no inherited PI_*/TMUX*/GIT_*/npm_* state, and a HOME and XDG_*
// that point at a temporary root, never the user's.
export default defineConfig({
	test: {
		name: "pi-predict",
		include: ["tests/**/*.test.ts"],
		setupFiles: [fileURLToPath(new URL("./tests/support/hermetic-env.ts", import.meta.url))],
		testTimeout: 30_000,
		hookTimeout: 30_000,
	},
});
