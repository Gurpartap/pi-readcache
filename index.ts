import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerReadcacheCommands } from "./src/commands.js";
import { clearReplayRuntimeState, createReplayRuntimeState } from "./src/replay.js";
import { pruneObjectsOlderThan } from "./src/object-store.js";
import { createReadOverrideTool } from "./src/tool.js";

export default function (pi: ExtensionAPI): void {
	const runtimeState = createReplayRuntimeState();
	pi.registerTool(createReadOverrideTool(runtimeState));
	registerReadcacheCommands(pi, runtimeState);

	const clearCaches = (): void => {
		clearReplayRuntimeState(runtimeState);
	};

	pi.on("session_start", (_event, ctx) => {
		void pruneObjectsOlderThan(ctx.cwd).catch(() => {
			// Fail-open: object pruning should never disrupt session startup.
		});
	});

	pi.on("session_compact", clearCaches);
	pi.on("session_tree", clearCaches);
	pi.on("session_fork", clearCaches);
	pi.on("session_switch", clearCaches);
	pi.on("session_shutdown", clearCaches);
}
