import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	SessionManager,
	type AgentToolResult,
	type ExtensionAPI,
	type ExtensionContext,
	type ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { registerReadcacheCommands } from "../../src/commands.js";
import { READCACHE_CUSTOM_TYPE } from "../../src/constants.js";
import { createReplayRuntimeState } from "../../src/replay.js";
import { createReadOverrideTool } from "../../src/tool.js";
import type { ReadToolDetailsExt } from "../../src/types.js";

interface ToolRegistration {
	definition: ToolDefinition;
}

function asContext(cwd: string, sessionManager: SessionManager): ExtensionContext {
	return {
		cwd,
		sessionManager,
	} as unknown as ExtensionContext;
}

function appendReadResult(
	sessionManager: SessionManager,
	toolCallId: string,
	result: AgentToolResult<ReadToolDetailsExt | undefined>,
): string {
	return sessionManager.appendMessage({
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: result.content,
		details: result.details,
		isError: false,
		timestamp: Date.now(),
	});
}

function createExtensionHarness(sessionManager: SessionManager): {
	pi: ExtensionAPI;
	tools: Map<string, ToolRegistration>;
} {
	const tools = new Map<string, ToolRegistration>();

	const pi = {
		registerCommand: () => undefined,
		registerTool: (definition: ToolDefinition) => {
			tools.set(definition.name, { definition });
		},
		appendEntry: (customType: string, data?: unknown) => {
			sessionManager.appendCustomEntry(customType, data);
		},
		sendMessage: () => undefined,
	} as unknown as ExtensionAPI;

	return { pi, tools };
}

function appendAssistantSeed(sessionManager: SessionManager, text: string): void {
	sessionManager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "seed-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: 0,
			},
		},
		stopReason: "stop",
		timestamp: Date.now(),
	});
}

describe("integration: restart and resume", () => {
	it("rebuilds invalidation semantics from branch replay after restart", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-readcache-resume-cwd-"));
		const sessionDir = await mkdtemp(join(tmpdir(), "pi-readcache-resume-session-"));
		await writeFile(join(cwd, "sample.txt"), "alpha\nbeta\ngamma", "utf-8");

		const sessionManager = SessionManager.create(cwd, sessionDir);
		appendAssistantSeed(sessionManager, "seed assistant turn for persistence");
		const runtimeState = createReplayRuntimeState();
		const readTool = createReadOverrideTool(runtimeState);
		const harness = createExtensionHarness(sessionManager);
		registerReadcacheCommands(harness.pi, runtimeState);

		const refreshTool = harness.tools.get("readcache_refresh");
		expect(refreshTool).toBeDefined();
		if (!refreshTool) {
			throw new Error("expected readcache_refresh tool registration");
		}

		const ctx = asContext(cwd, sessionManager);
		const firstRead = await readTool.execute("read-1", { path: "sample.txt" }, undefined, undefined, ctx);
		expect(firstRead.details?.readcache?.mode).toBe("full");
		appendReadResult(sessionManager, "read-1", firstRead);

		const unchangedRead = await readTool.execute("read-2", { path: "sample.txt" }, undefined, undefined, ctx);
		expect(unchangedRead.details?.readcache?.mode).toBe("unchanged");

		await refreshTool.definition.execute("refresh-1", { path: "sample.txt" }, undefined, undefined, ctx);
		const invalidationEntries = sessionManager
			.getEntries()
			.filter((entry) => entry.type === "custom" && entry.customType === READCACHE_CUSTOM_TYPE);
		expect(invalidationEntries).toHaveLength(1);

		const sessionFile = sessionManager.getSessionFile();
		expect(sessionFile).toBeDefined();
		if (!sessionFile) {
			throw new Error("expected persisted session file");
		}

		const persistedSessionJsonl = await readFile(sessionFile, "utf-8");
		expect(persistedSessionJsonl).toContain('"toolName":"read"');
		expect(persistedSessionJsonl).toContain('"customType":"pi-readcache"');

		const resumedSessionManager = SessionManager.open(sessionFile, sessionDir);
		const resumedRuntimeState = createReplayRuntimeState();
		const resumedReadTool = createReadOverrideTool(resumedRuntimeState);
		const resumedCtx = asContext(cwd, resumedSessionManager);

		const resumedRead = await resumedReadTool.execute("read-3", { path: "sample.txt" }, undefined, undefined, resumedCtx);
		expect(resumedRead.details?.readcache?.mode).toBe("full");
		appendReadResult(resumedSessionManager, "read-3", resumedRead);

		const resumedUnchanged = await resumedReadTool.execute(
			"read-4",
			{ path: "sample.txt" },
			undefined,
			undefined,
			resumedCtx,
		);
		expect(resumedUnchanged.details?.readcache?.mode).toBe("unchanged");
	});

	it("keeps replay knowledge isolated when switching between sessions", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-readcache-switch-cwd-"));
		const sessionDirA = await mkdtemp(join(tmpdir(), "pi-readcache-switch-a-"));
		const sessionDirB = await mkdtemp(join(tmpdir(), "pi-readcache-switch-b-"));
		const filePath = join(cwd, "sample.txt");
		await writeFile(filePath, "shared", "utf-8");

		const runtimeState = createReplayRuntimeState();
		const readTool = createReadOverrideTool(runtimeState);

		const sessionA = SessionManager.create(cwd, sessionDirA);
		const sessionB = SessionManager.create(cwd, sessionDirB);
		const ctxA = asContext(cwd, sessionA);
		const ctxB = asContext(cwd, sessionB);

		const aFirst = await readTool.execute("switch-a-1", { path: "sample.txt" }, undefined, undefined, ctxA);
		expect(aFirst.details?.readcache?.mode).toBe("full");
		appendReadResult(sessionA, "switch-a-1", aFirst);

		const aSecond = await readTool.execute("switch-a-2", { path: "sample.txt" }, undefined, undefined, ctxA);
		expect(aSecond.details?.readcache?.mode).toBe("unchanged");

		const bFirst = await readTool.execute("switch-b-1", { path: "sample.txt" }, undefined, undefined, ctxB);
		expect(bFirst.details?.readcache?.mode).toBe("full");
	});
});
