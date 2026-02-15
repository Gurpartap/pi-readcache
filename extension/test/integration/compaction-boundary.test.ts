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

describe("integration: compaction replay boundary", () => {
	it("does_not_bootstrap_trust_from_non_anchor_unchanged_entries_after_compaction", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-readcache-compact-"));
		const filePath = join(cwd, "sample.txt");
		await writeFile(filePath, "v1", "utf-8");

		const sessionManager = SessionManager.inMemory(cwd);
		const tool = createReadOverrideTool(createReplayRuntimeState());
		const ctx = asContext(cwd, sessionManager);

		const firstRead = await tool.execute("call-1", { path: "sample.txt" }, undefined, undefined, ctx);
		expect(firstRead.details?.readcache?.mode).toBe("full");
		appendReadResult(sessionManager, "call-1", firstRead);

		const secondRead = await tool.execute("call-2", { path: "sample.txt" }, undefined, undefined, ctx);
		expect(secondRead.details?.readcache?.mode).toBe("unchanged");
		const unchangedEntryId = appendReadResult(sessionManager, "call-2", secondRead);

		sessionManager.appendCompaction("compact", unchangedEntryId, 100);

		const postCompactionRead = await tool.execute("call-3", { path: "sample.txt" }, undefined, undefined, ctx);
		expect(postCompactionRead.details?.readcache?.mode).not.toBe("unchanged");
		expect(["full", "full_fallback"]).toContain(postCompactionRead.details?.readcache?.mode);
	});

	it("falls back to compaction+1 when firstKeptEntryId is absent on the active path", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-readcache-compact-"));
		const filePath = join(cwd, "sample.txt");
		await writeFile(filePath, "stable", "utf-8");

		const sessionManager = SessionManager.inMemory(cwd);
		const tool = createReadOverrideTool(createReplayRuntimeState());
		const ctx = asContext(cwd, sessionManager);

		const firstRead = await tool.execute("call-a", { path: "sample.txt" }, undefined, undefined, ctx);
		appendReadResult(sessionManager, "call-a", firstRead);
		expect(firstRead.details?.readcache?.mode).toBe("full");

		sessionManager.appendCompaction("compact", "missing-entry", 42);

		const postCompactionRead = await tool.execute("call-b", { path: "sample.txt" }, undefined, undefined, ctx);
		expect(postCompactionRead.details?.readcache?.mode).toBe("full");
		expect(getText(postCompactionRead)).toContain("stable");
	});

	it("prefers_fresher_full_trust_over_older_exact_range_trust_when_selecting_baseHash", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-readcache-compact-"));
		const filePath = join(cwd, "sample.txt");
		await writeFile(filePath, ["line 1", "line 2", "line 3", "line 4", "line 5"].join("\n"), "utf-8");

		const sessionManager = SessionManager.inMemory(cwd);
		const tool = createReadOverrideTool(createReplayRuntimeState());
		const ctx = asContext(cwd, sessionManager);

		const rangeAnchor = await tool.execute("call-range-1", { path: "sample.txt:2-4" }, undefined, undefined, ctx);
		expect(rangeAnchor.details?.readcache?.mode).toBe("full");
		appendReadResult(sessionManager, "call-range-1", rangeAnchor);
		const olderRangeHash = rangeAnchor.details?.readcache?.servedHash;
		expect(olderRangeHash).toBeDefined();

		await writeFile(filePath, ["LINE 1 changed", "line 2", "line 3", "line 4", "line 5"].join("\n"), "utf-8");
		const fullAnchor = await tool.execute("call-full-1", { path: "sample.txt" }, undefined, undefined, ctx);
		expect(fullAnchor.details?.readcache?.mode).toBe("full");
		appendReadResult(sessionManager, "call-full-1", fullAnchor);
		const fresherFullHash = fullAnchor.details?.readcache?.servedHash;
		expect(fresherFullHash).toBeDefined();

		const secondRangeRead = await tool.execute("call-range-2", { path: "sample.txt:2-4" }, undefined, undefined, ctx);
		expect(secondRangeRead.details?.readcache?.mode).toBe("unchanged_range");
		expect(secondRangeRead.details?.readcache?.baseHash).toBe(fresherFullHash);
		expect(secondRangeRead.details?.readcache?.baseHash).not.toBe(olderRangeHash);
	});

	it("replays historical state correctly when tree-navigating to a pre-compaction point", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-readcache-compact-"));
		const filePath = join(cwd, "sample.txt");
		await writeFile(filePath, "v1", "utf-8");

		const sessionManager = SessionManager.inMemory(cwd);
		const tool = createReadOverrideTool(createReplayRuntimeState());
		const ctx = asContext(cwd, sessionManager);

		const readV1 = await tool.execute("call-pre-1", { path: "sample.txt" }, undefined, undefined, ctx);
		expect(readV1.details?.readcache?.mode).toBe("full");
		const v1EntryId = appendReadResult(sessionManager, "call-pre-1", readV1);

		await writeFile(filePath, "v2", "utf-8");
		const readV2 = await tool.execute("call-pre-2", { path: "sample.txt" }, undefined, undefined, ctx);
		expect(readV2.details?.readcache?.mode).toBe("full_fallback");
		const v2EntryId = appendReadResult(sessionManager, "call-pre-2", readV2);

		sessionManager.appendCompaction("compact", v2EntryId, 64);

		await writeFile(filePath, "v3", "utf-8");
		const readV3 = await tool.execute("call-pre-3", { path: "sample.txt" }, undefined, undefined, ctx);
		expect(readV3.details?.readcache?.mode).toBe("full_fallback");
		appendReadResult(sessionManager, "call-pre-3", readV3);

		sessionManager.branch(v1EntryId);
		await writeFile(filePath, "v1", "utf-8");

		const rewoundRead = await tool.execute("call-pre-4", { path: "sample.txt" }, undefined, undefined, ctx);
		expect(rewoundRead.details?.readcache?.mode).toBe("unchanged");
		expect(getText(rewoundRead)).toContain("[readcache: unchanged");
	});
});
