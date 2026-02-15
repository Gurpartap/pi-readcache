import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	SessionManager,
	type AgentToolResult,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type ReadToolDetails,
	type SessionEntry,
	 type ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { registerReadcacheCommands } from "../../src/commands.js";
import { READCACHE_CUSTOM_TYPE } from "../../src/constants.js";
import { createReplayRuntimeState } from "../../src/replay.js";
import { createReadOverrideTool } from "../../src/tool.js";
import type { ReadCacheInvalidationV1, ReadToolDetailsExt } from "../../src/types.js";

interface CommandRegistration {
	handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}

interface ToolRegistration {
	definition: ToolDefinition;
}

interface SentMessage {
	customType: string;
	content: string;
	display?: boolean;
}

function asContext(cwd: string, sessionManager: SessionManager): ExtensionContext {
	return {
		cwd,
		sessionManager,
	} as unknown as ExtensionContext;
}

function asCommandContext(cwd: string, sessionManager: SessionManager): ExtensionCommandContext {
	return {
		cwd,
		sessionManager,
		hasUI: false,
		ui: {
			notify: () => undefined,
		},
	} as unknown as ExtensionCommandContext;
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

function listInvalidations(sessionManager: SessionManager): ReadCacheInvalidationV1[] {
	return sessionManager
		.getEntries()
		.filter((entry): entry is Extract<SessionEntry, { type: "custom" }> => entry.type === "custom")
		.filter((entry) => entry.customType === READCACHE_CUSTOM_TYPE)
		.map((entry) => entry.data)
		.filter((entry): entry is ReadCacheInvalidationV1 => {
			if (typeof entry !== "object" || entry === null) {
				return false;
			}
			const data = entry as Record<string, unknown>;
			return data.kind === "invalidate" && data.v === 1;
		});
}

function createExtensionHarness(sessionManager: SessionManager): {
	pi: ExtensionAPI;
	commands: Map<string, CommandRegistration>;
	tools: Map<string, ToolRegistration>;
	sentMessages: SentMessage[];
} {
	const commands = new Map<string, CommandRegistration>();
	const tools = new Map<string, ToolRegistration>();
	const sentMessages: SentMessage[] = [];

	const pi = {
		registerCommand: (name: string, options: CommandRegistration) => {
			commands.set(name, options);
		},
		registerTool: (definition: ToolDefinition) => {
			tools.set(definition.name, { definition });
		},
		appendEntry: (customType: string, data?: unknown) => {
			sessionManager.appendCustomEntry(customType, data);
		},
		sendMessage: (message: SentMessage) => {
			sentMessages.push(message);
		},
	} as unknown as ExtensionAPI;

	return { pi, commands, tools, sentMessages };
}

describe("integration: refresh invalidation", () => {
	it("/readcache-refresh appends invalidation entries and forces the next read baseline", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-readcache-refresh-"));
		await writeFile(join(cwd, "sample.txt"), "alpha\nbeta\ngamma", "utf-8");

		const sessionManager = SessionManager.inMemory(cwd);
		const runtimeState = createReplayRuntimeState();
		const readTool = createReadOverrideTool(runtimeState);
		const harness = createExtensionHarness(sessionManager);
		registerReadcacheCommands(harness.pi, runtimeState);

		const refreshCommand = harness.commands.get("readcache-refresh");
		expect(refreshCommand).toBeDefined();
		if (!refreshCommand) {
			throw new Error("expected readcache-refresh command registration");
		}

		const ctx = asContext(cwd, sessionManager);
		const cmdCtx = asCommandContext(cwd, sessionManager);

		const firstRead = await readTool.execute("read-1", { path: "sample.txt" }, undefined, undefined, ctx);
		expect(firstRead.details?.readcache?.mode).toBe("full");
		appendReadResult(sessionManager, "read-1", firstRead);

		const unchangedRead = await readTool.execute("read-2", { path: "sample.txt" }, undefined, undefined, ctx);
		expect(unchangedRead.details?.readcache?.mode).toBe("unchanged");

		await refreshCommand.handler("sample.txt", cmdCtx);

		const invalidations = listInvalidations(sessionManager);
		expect(invalidations).toHaveLength(1);
		expect(invalidations[0]).toMatchObject({
			v: 1,
			kind: "invalidate",
			pathKey: join(cwd, "sample.txt"),
			scopeKey: "full",
		});

		const refreshedRead = await readTool.execute("read-3", { path: "sample.txt" }, undefined, undefined, ctx);
		expect(refreshedRead.details?.readcache?.mode).toBe("full");
		expect(harness.sentMessages.some((message) => message.customType === "pi-readcache-refresh")).toBe(true);
	});

	it("range refresh blocks full fallback until a range baseline re-anchors trust", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-readcache-refresh-range-"));
		await writeFile(join(cwd, "sample.txt"), "one\ntwo\nthree\nfour", "utf-8");

		const sessionManager = SessionManager.inMemory(cwd);
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

		const firstFullRead = await readTool.execute("read-r1", { path: "sample.txt" }, undefined, undefined, ctx);
		expect(firstFullRead.details?.readcache?.mode).toBe("full");
		appendReadResult(sessionManager, "read-r1", firstFullRead);

		const rangeRead = await readTool.execute(
			"read-r2",
			{ path: "sample.txt", offset: 2, limit: 2 },
			undefined,
			undefined,
			ctx,
		);
		expect(rangeRead.details?.readcache?.mode).toBe("unchanged_range");
		appendReadResult(sessionManager, "read-r2", rangeRead);

		await refreshTool.definition.execute(
			"refresh-r1",
			{ path: "sample.txt", offset: 2, limit: 2 },
			undefined,
			undefined,
			ctx,
		);

		const invalidations = listInvalidations(sessionManager);
		expect(invalidations).toHaveLength(1);
		expect(invalidations[0]?.scopeKey).toBe("r:2:3");

		const afterRangeRefresh = await readTool.execute(
			"read-r3",
			{ path: "sample.txt", offset: 2, limit: 2 },
			undefined,
			undefined,
			ctx,
		);
		expect(afterRangeRefresh.details?.readcache?.mode).toBe("full");
		appendReadResult(sessionManager, "read-r3", afterRangeRefresh);

		const secondRangeRead = await readTool.execute(
			"read-r4",
			{ path: "sample.txt", offset: 2, limit: 2 },
			undefined,
			undefined,
			ctx,
		);
		expect(secondRangeRead.details?.readcache?.mode).toBe("unchanged_range");

		const fullReadAfterRangeRefresh = await readTool.execute("read-r5", { path: "sample.txt" }, undefined, undefined, ctx);
		expect(fullReadAfterRangeRefresh.details?.readcache?.mode).toBe("unchanged");
	});

	it("range refresh followed by full read still forces the next range read baseline", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-readcache-refresh-range-after-full-"));
		await writeFile(join(cwd, "sample.txt"), "one\ntwo\nthree\nfour", "utf-8");

		const sessionManager = SessionManager.inMemory(cwd);
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

		const initialFullRead = await readTool.execute("read-f1", { path: "sample.txt" }, undefined, undefined, ctx);
		expect(initialFullRead.details?.readcache?.mode).toBe("full");
		appendReadResult(sessionManager, "read-f1", initialFullRead);

		const initialRangeRead = await readTool.execute(
			"read-f2",
			{ path: "sample.txt", offset: 2, limit: 2 },
			undefined,
			undefined,
			ctx,
		);
		expect(initialRangeRead.details?.readcache?.mode).toBe("unchanged_range");
		appendReadResult(sessionManager, "read-f2", initialRangeRead);

		await refreshTool.definition.execute(
			"refresh-f1",
			{ path: "sample.txt", offset: 2, limit: 2 },
			undefined,
			undefined,
			ctx,
		);

		const fullReadAfterRefresh = await readTool.execute("read-f3", { path: "sample.txt" }, undefined, undefined, ctx);
		expect(fullReadAfterRefresh.details?.readcache?.mode).toBe("unchanged");
		appendReadResult(sessionManager, "read-f3", fullReadAfterRefresh);

		const rangeReadAfterFullRead = await readTool.execute(
			"read-f4",
			{ path: "sample.txt", offset: 2, limit: 2 },
			undefined,
			undefined,
			ctx,
		);
		expect(rangeReadAfterFullRead.details?.readcache?.mode).toBe("full");
		appendReadResult(sessionManager, "read-f4", rangeReadAfterFullRead);

		const rangeReadAgain = await readTool.execute(
			"read-f5",
			{ path: "sample.txt", offset: 2, limit: 2 },
			undefined,
			undefined,
			ctx,
		);
		expect(rangeReadAgain.details?.readcache?.mode).toBe("unchanged_range");
	});

	it("readcache_refresh tool uses the same persistent invalidation semantics as the command", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-readcache-refresh-tool-"));
		await writeFile(join(cwd, "sample.txt"), "one\ntwo\nthree", "utf-8");

		const sessionManager = SessionManager.inMemory(cwd);
		const runtimeState = createReplayRuntimeState();
		const readTool = createReadOverrideTool(runtimeState);
		const harness = createExtensionHarness(sessionManager);
		registerReadcacheCommands(harness.pi, runtimeState);

		const refreshCommand = harness.commands.get("readcache-refresh");
		const refreshTool = harness.tools.get("readcache_refresh");
		expect(refreshCommand).toBeDefined();
		expect(refreshTool).toBeDefined();
		if (!refreshCommand || !refreshTool) {
			throw new Error("expected refresh command and tool registrations");
		}

		const ctx = asContext(cwd, sessionManager);
		const cmdCtx = asCommandContext(cwd, sessionManager);

		const firstRead = await readTool.execute("read-a", { path: "sample.txt" }, undefined, undefined, ctx);
		appendReadResult(sessionManager, "read-a", firstRead);

		await refreshCommand.handler("sample.txt", cmdCtx);
		const afterCommand = await readTool.execute("read-b", { path: "sample.txt" }, undefined, undefined, ctx);
		expect(afterCommand.details?.readcache?.mode).toBe("full");
		appendReadResult(sessionManager, "read-b", afterCommand);

		const unchangedAgain = await readTool.execute("read-c", { path: "sample.txt" }, undefined, undefined, ctx);
		expect(unchangedAgain.details?.readcache?.mode).toBe("unchanged");

		await refreshTool.definition.execute("refresh-tool", { path: "sample.txt" }, undefined, undefined, ctx);

		const afterTool = await readTool.execute("read-d", { path: "sample.txt" }, undefined, undefined, ctx);
		expect(afterTool.details?.readcache?.mode).toBe("full");

		const invalidations = listInvalidations(sessionManager);
		expect(invalidations).toHaveLength(2);
		expect(invalidations[0]?.scopeKey).toBe("full");
		expect(invalidations[1]?.scopeKey).toBe("full");
	});
});
