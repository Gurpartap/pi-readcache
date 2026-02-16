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

describe("integration: selective range behavior", () => {
	it("returns baseline slice on the first range read and unchanged_range on the second", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-readcache-range-"));
		const filePath = join(cwd, "sample.txt");
		const initialLines = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`);
		await writeFile(filePath, initialLines.join("\n"), "utf-8");

		const sessionManager = SessionManager.inMemory(cwd);
		const tool = createReadOverrideTool(createReplayRuntimeState());
		const ctx = asContext(cwd, sessionManager);

		const firstRangeRead = await tool.execute("call-range-first", { path: "sample.txt:3-5" }, undefined, undefined, ctx);
		expect(firstRangeRead.details?.readcache?.mode).toBe("full");
		expect(getText(firstRangeRead)).toContain("line 3");
		expect(getText(firstRangeRead)).toContain("line 5");
		appendReadResult(sessionManager, "call-range-first", firstRangeRead);

		const secondRangeRead = await tool.execute(
			"call-range-second",
			{ path: "sample.txt:3-5" },
			undefined,
			undefined,
			ctx,
		);
		expect(secondRangeRead.details?.readcache?.mode).toBe("unchanged_range");
		expect(getText(secondRangeRead)).toContain("[readcache: unchanged in lines 3-5 of 12]");
	});

	it("keeps unchanged_range for outside edits and falls back when the requested range changed", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-readcache-range-"));
		const filePath = join(cwd, "sample.txt");
		const initialLines = Array.from({ length: 400 }, (_, index) => `line ${index + 1}`);
		await writeFile(filePath, initialLines.join("\n"), "utf-8");

		const sessionManager = SessionManager.inMemory(cwd);
		const tool = createReadOverrideTool(createReplayRuntimeState());
		const ctx = asContext(cwd, sessionManager);

		const fullRead = await tool.execute("call-full", { path: "sample.txt" }, undefined, undefined, ctx);
		expect(fullRead.details?.readcache?.mode).toBe("full");
		appendReadResult(sessionManager, "call-full", fullRead);

		const firstRangeRead = await tool.execute("call-range-1", { path: "sample.txt:160-249" }, undefined, undefined, ctx);
		expect(firstRangeRead.details?.readcache?.mode).toBe("unchanged_range");
		appendReadResult(sessionManager, "call-range-1", firstRangeRead);

		const editedLines = [...initialLines];
		editedLines[299] = "line 300 updated";
		await writeFile(filePath, editedLines.join("\n"), "utf-8");

		const unchangedRange = await tool.execute("call-range-2", { path: "sample.txt:160-249" }, undefined, undefined, ctx);
		expect(unchangedRange.details?.readcache?.mode).toBe("unchanged_range");
		expect(getText(unchangedRange)).toContain("changes exist outside this range");
		appendReadResult(sessionManager, "call-range-2", unchangedRange);

		const changedRange = await tool.execute("call-range-3", { path: "sample.txt:100-349" }, undefined, undefined, ctx);
		expect(changedRange.details?.readcache?.mode).toBe("baseline_fallback");
		expect(getText(changedRange)).toContain("line 300 updated");
	});

	it("treats line insertions before a requested range as range-changed fallback", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-readcache-range-"));
		const filePath = join(cwd, "sample.txt");
		const initialLines = Array.from({ length: 200 }, (_, index) => `line ${index + 1}`);
		await writeFile(filePath, initialLines.join("\n"), "utf-8");

		const sessionManager = SessionManager.inMemory(cwd);
		const tool = createReadOverrideTool(createReplayRuntimeState());
		const ctx = asContext(cwd, sessionManager);

		const firstRead = await tool.execute("call-insert-1", { path: "sample.txt" }, undefined, undefined, ctx);
		expect(firstRead.details?.readcache?.mode).toBe("full");
		appendReadResult(sessionManager, "call-insert-1", firstRead);

		const shifted = ["inserted header line", ...initialLines];
		await writeFile(filePath, shifted.join("\n"), "utf-8");

		const shiftedRangeRead = await tool.execute(
			"call-insert-2",
			{ path: "sample.txt:100-120" },
			undefined,
			undefined,
			ctx,
		);
		expect(shiftedRangeRead.details?.readcache?.mode).toBe("baseline_fallback");
		expect(getText(shiftedRangeRead)).toContain("line 99");
	});
});
