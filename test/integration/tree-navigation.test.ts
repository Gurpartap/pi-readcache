import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	SessionManager,
	type AgentToolResult,
	type ExtensionContext,
	type ReadToolDetails,
} from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { createReplayRuntimeState } from "../../src/replay.js";
import { createReadOverrideTool } from "../../src/tool.js";
import type { ReadToolDetailsExt } from "../../src/types.js";

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

function getText(result: AgentToolResult<ReadToolDetails | undefined>): string {
	const block = result.content.find((content) => content.type === "text");
	if (!block || block.type !== "text") {
		throw new Error("Expected text content in read result");
	}
	return block.text;
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

describe("integration: tree navigation", () => {
	it("does not leak stale base hashes across branch navigation", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-readcache-tree-"));
		const filePath = join(cwd, "sample.txt");
		await writeFile(filePath, "alpha\nbeta\ngamma", "utf-8");

		const sessionManager = SessionManager.inMemory(cwd);
		const tool = createReadOverrideTool(createReplayRuntimeState());
		const ctx = asContext(cwd, sessionManager);

		const firstRead = await tool.execute("call-1", { path: "sample.txt" }, undefined, undefined, ctx);
		expect(firstRead.details?.readcache?.mode).toBe("full");
		const firstEntryId = appendReadResult(sessionManager, "call-1", firstRead);

		await writeFile(filePath, "alpha\nBETA\ngamma", "utf-8");
		const secondRead = await tool.execute("call-2", { path: "sample.txt" }, undefined, undefined, ctx);
		expect(secondRead.details?.readcache?.mode).toBe("baseline_fallback");
		appendReadResult(sessionManager, "call-2", secondRead);

		sessionManager.branch(firstEntryId);

		const thirdRead = await tool.execute("call-3", { path: "sample.txt" }, undefined, undefined, ctx);
		expect(thirdRead.details?.readcache?.mode).toBe("baseline_fallback");
		expect(getText(thirdRead)).toContain("BETA");
	});

	it("keeps forked sessions isolated from source-session replay updates", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-readcache-tree-fork-cwd-"));
		const sourceSessionDir = await mkdtemp(join(tmpdir(), "pi-readcache-tree-fork-source-"));
		const forkSessionDir = await mkdtemp(join(tmpdir(), "pi-readcache-tree-fork-target-"));
		const filePath = join(cwd, "sample.txt");
		await writeFile(filePath, "v1", "utf-8");

		const runtimeState = createReplayRuntimeState();
		const tool = createReadOverrideTool(runtimeState);

		const sourceSession = SessionManager.create(cwd, sourceSessionDir);
		appendAssistantSeed(sourceSession, "seed assistant turn for persistence");
		const sourceCtx = asContext(cwd, sourceSession);
		const sourceFirst = await tool.execute("source-1", { path: "sample.txt" }, undefined, undefined, sourceCtx);
		expect(sourceFirst.details?.readcache?.mode).toBe("full");
		appendReadResult(sourceSession, "source-1", sourceFirst);

		const sourceSessionFile = sourceSession.getSessionFile();
		expect(sourceSessionFile).toBeDefined();
		if (!sourceSessionFile) {
			throw new Error("expected source session file");
		}

		const forkedSession = SessionManager.forkFrom(sourceSessionFile, cwd, forkSessionDir);
		const forkedCtx = asContext(cwd, forkedSession);

		await writeFile(filePath, "v2", "utf-8");
		const sourceSecond = await tool.execute("source-2", { path: "sample.txt" }, undefined, undefined, sourceCtx);
		expect(sourceSecond.details?.readcache?.mode).toBe("baseline_fallback");
		appendReadResult(sourceSession, "source-2", sourceSecond);

		await writeFile(filePath, "v1", "utf-8");
		const sourceThird = await tool.execute("source-3", { path: "sample.txt" }, undefined, undefined, sourceCtx);
		expect(sourceThird.details?.readcache?.mode).not.toBe("unchanged");

		const forkedRead = await tool.execute("fork-1", { path: "sample.txt" }, undefined, undefined, forkedCtx);
		expect(forkedRead.details?.readcache?.mode).toBe("unchanged");
		expect(getText(forkedRead)).toContain("[readcache: unchanged");
	});
});
