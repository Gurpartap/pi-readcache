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
		expect(secondRead.details?.readcache?.mode).toBe("full_fallback");
		appendReadResult(sessionManager, "call-2", secondRead);

		sessionManager.branch(firstEntryId);

		const thirdRead = await tool.execute("call-3", { path: "sample.txt" }, undefined, undefined, ctx);
		expect(thirdRead.details?.readcache?.mode).toBe("full_fallback");
		expect(getText(thirdRead)).toContain("BETA");
	});
});
