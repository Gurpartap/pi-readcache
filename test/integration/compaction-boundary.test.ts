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
	it("first_read_after_compaction_is_baseline_even_if_precompaction_anchor_exists", async () => {
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
		const preCompactionEntryId = appendReadResult(sessionManager, "call-2", secondRead);

		sessionManager.appendCompaction("compact", preCompactionEntryId, 100);

		const postCompactionRead = await tool.execute("call-3", { path: "sample.txt" }, undefined, undefined, ctx);
		expect(postCompactionRead.details?.readcache?.mode).not.toBe("unchanged");
		expect(postCompactionRead.details?.readcache?.mode).not.toBe("diff");
		expect(["full", "full_fallback"]).toContain(postCompactionRead.details?.readcache?.mode);
	});

	it("latest_compaction_wins_when_multiple_compactions_exist", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-readcache-compact-"));
		const filePath = join(cwd, "sample.txt");
		await writeFile(filePath, "stable", "utf-8");

		const sessionManager = SessionManager.inMemory(cwd);
		const tool = createReadOverrideTool(createReplayRuntimeState());
		const ctx = asContext(cwd, sessionManager);

		const read1 = await tool.execute("call-a", { path: "sample.txt" }, undefined, undefined, ctx);
		expect(read1.details?.readcache?.mode).toBe("full");
		const entry1 = appendReadResult(sessionManager, "call-a", read1);

		sessionManager.appendCompaction("compact-1", entry1, 42);

		const read2 = await tool.execute("call-b", { path: "sample.txt" }, undefined, undefined, ctx);
		expect(["full", "full_fallback"]).toContain(read2.details?.readcache?.mode);
		const entry2 = appendReadResult(sessionManager, "call-b", read2);

		const read3 = await tool.execute("call-c", { path: "sample.txt" }, undefined, undefined, ctx);
		expect(read3.details?.readcache?.mode).toBe("unchanged");
		const entry3 = appendReadResult(sessionManager, "call-c", read3);

		sessionManager.appendCompaction("compact-2", entry3, 64);

		const postSecondCompactionRead = await tool.execute("call-d", { path: "sample.txt" }, undefined, undefined, ctx);
		expect(postSecondCompactionRead.details?.readcache?.mode).not.toBe("unchanged");
		expect(postSecondCompactionRead.details?.readcache?.mode).not.toBe("diff");
		expect(["full", "full_fallback"]).toContain(postSecondCompactionRead.details?.readcache?.mode);
		appendReadResult(sessionManager, "call-d", postSecondCompactionRead);

		const readAfterBaseline = await tool.execute("call-e", { path: "sample.txt" }, undefined, undefined, ctx);
		expect(readAfterBaseline.details?.readcache?.mode).toBe("unchanged");
		expect(getText(readAfterBaseline)).toContain("[readcache: unchanged");
		expect(entry2).toBeDefined();
	});

	it("post_compaction_first_range_read_is_baseline_range", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-readcache-compact-"));
		const filePath = join(cwd, "sample.txt");
		const lines = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n");
		await writeFile(filePath, lines, "utf-8");

		const sessionManager = SessionManager.inMemory(cwd);
		const tool = createReadOverrideTool(createReplayRuntimeState());
		const ctx = asContext(cwd, sessionManager);

		const fullAnchor = await tool.execute("call-range-1", { path: "sample.txt" }, undefined, undefined, ctx);
		expect(fullAnchor.details?.readcache?.mode).toBe("full");
		appendReadResult(sessionManager, "call-range-1", fullAnchor);

		const preCompactionRange = await tool.execute("call-range-2", { path: "sample.txt:3-5" }, undefined, undefined, ctx);
		expect(preCompactionRange.details?.readcache?.mode).toBe("unchanged_range");
		const preCompactionEntryId = appendReadResult(sessionManager, "call-range-2", preCompactionRange);

		sessionManager.appendCompaction("compact-range", preCompactionEntryId, 55);

		const postCompactionRange = await tool.execute("call-range-3", { path: "sample.txt:3-5" }, undefined, undefined, ctx);
		expect(postCompactionRange.details?.readcache?.mode).not.toBe("unchanged_range");
		expect(["full", "full_fallback"]).toContain(postCompactionRange.details?.readcache?.mode);
		expect(getText(postCompactionRange)).toContain("line 3");
	});

	it("prefers_fresher_full_trust_over_older_exact_range_trust_when_selecting_baseHash", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-readcache-compact-"));
		const filePath = join(cwd, "sample.txt");
		await writeFile(filePath, ["line 1", "line 2", "line 3", "line 4", "line 5"].join("\n"), "utf-8");

		const sessionManager = SessionManager.inMemory(cwd);
		const tool = createReadOverrideTool(createReplayRuntimeState());
		const ctx = asContext(cwd, sessionManager);

		const rangeAnchor = await tool.execute("call-fresh-1", { path: "sample.txt:2-4" }, undefined, undefined, ctx);
		expect(rangeAnchor.details?.readcache?.mode).toBe("full");
		appendReadResult(sessionManager, "call-fresh-1", rangeAnchor);
		const olderRangeHash = rangeAnchor.details?.readcache?.servedHash;
		expect(olderRangeHash).toBeDefined();

		await writeFile(filePath, ["LINE 1 changed", "line 2", "line 3", "line 4", "line 5"].join("\n"), "utf-8");
		const fullAnchor = await tool.execute("call-fresh-2", { path: "sample.txt" }, undefined, undefined, ctx);
		expect(fullAnchor.details?.readcache?.mode).toBe("full");
		appendReadResult(sessionManager, "call-fresh-2", fullAnchor);
		const fresherFullHash = fullAnchor.details?.readcache?.servedHash;
		expect(fresherFullHash).toBeDefined();

		const secondRangeRead = await tool.execute("call-fresh-3", { path: "sample.txt:2-4" }, undefined, undefined, ctx);
		expect(secondRangeRead.details?.readcache?.mode).toBe("unchanged_range");
		expect(secondRangeRead.details?.readcache?.baseHash).toBe(fresherFullHash);
		expect(secondRangeRead.details?.readcache?.baseHash).not.toBe(olderRangeHash);
	});

	it("tree_navigation_pre_compaction_restores_precompaction_visibility", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-readcache-compact-"));
		const filePath = join(cwd, "sample.txt");
		await writeFile(filePath, "v1", "utf-8");

		const sessionManager = SessionManager.inMemory(cwd);
		const tool = createReadOverrideTool(createReplayRuntimeState());
		const ctx = asContext(cwd, sessionManager);

		const readV1 = await tool.execute("call-tree-1", { path: "sample.txt" }, undefined, undefined, ctx);
		expect(readV1.details?.readcache?.mode).toBe("full");
		const v1EntryId = appendReadResult(sessionManager, "call-tree-1", readV1);

		await writeFile(filePath, "v2", "utf-8");
		const readV2 = await tool.execute("call-tree-2", { path: "sample.txt" }, undefined, undefined, ctx);
		expect(readV2.details?.readcache?.mode).toBe("full_fallback");
		const v2EntryId = appendReadResult(sessionManager, "call-tree-2", readV2);

		sessionManager.appendCompaction("compact-tree", v2EntryId, 64);

		await writeFile(filePath, "v3", "utf-8");
		const readV3 = await tool.execute("call-tree-3", { path: "sample.txt" }, undefined, undefined, ctx);
		expect(["full", "full_fallback"]).toContain(readV3.details?.readcache?.mode);
		appendReadResult(sessionManager, "call-tree-3", readV3);

		sessionManager.branch(v1EntryId);
		await writeFile(filePath, "v1", "utf-8");

		const rewoundRead = await tool.execute("call-tree-4", { path: "sample.txt" }, undefined, undefined, ctx);
		expect(rewoundRead.details?.readcache?.mode).toBe("unchanged");
		expect(getText(rewoundRead)).toContain("[readcache: unchanged");
	});
});
