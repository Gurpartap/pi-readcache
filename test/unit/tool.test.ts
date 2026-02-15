import { mkdtemp, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, type AgentToolResult, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { objectPathForHash } from "../../src/object-store.js";
import { createReadOverrideTool } from "../../src/tool.js";
import type { ReadToolDetailsExt } from "../../src/types.js";

function appendReadResult(
	sessionManager: SessionManager,
	toolCallId: string,
	result: AgentToolResult<ReadToolDetailsExt | undefined>,
): void {
	sessionManager.appendMessage({
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: result.content,
		details: result.details,
		isError: false,
		timestamp: Date.now(),
	});
}

describe("tool", () => {
	it("delegates to baseline read and attaches readcache metadata", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-readcache-tool-"));
		await writeFile(join(cwd, "sample.txt"), "a\nb\nc", "utf-8");

		const tool = createReadOverrideTool();
		const sessionManager = SessionManager.inMemory(cwd);
		const ctx = { cwd, sessionManager } as unknown as ExtensionContext;
		const result = await tool.execute("call-1", { path: "sample.txt" }, undefined, undefined, ctx);

		expect(result.content[0]?.type).toBe("text");
		expect(result.details?.readcache).toMatchObject({
			v: 1,
			pathKey: join(cwd, "sample.txt"),
			scopeKey: "full",
			mode: "full",
			totalLines: 3,
			rangeStart: 1,
			rangeEnd: 3,
		});
	});

	it("supports :start-end shorthand parsing", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-readcache-tool-"));
		await writeFile(join(cwd, "sample.txt"), "1\n2\n3\n4\n5", "utf-8");

		const tool = createReadOverrideTool();
		const sessionManager = SessionManager.inMemory(cwd);
		const ctx = { cwd, sessionManager } as unknown as ExtensionContext;
		const result = await tool.execute("call-2", { path: "sample.txt:2-4" }, undefined, undefined, ctx);

		expect(result.details?.readcache?.scopeKey).toBe("r:2:4");
		expect(result.details?.readcache?.rangeStart).toBe(2);
		expect(result.details?.readcache?.rangeEnd).toBe(4);
	});

	it("emits full-scope diff output when changed content has a useful patch", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-readcache-tool-"));
		const filePath = join(cwd, "sample.txt");
		const lines = Array.from({ length: 300 }, (_, index) => `line ${index + 1} :: original text payload`);
		await writeFile(filePath, lines.join("\n"), "utf-8");

		const tool = createReadOverrideTool();
		const sessionManager = SessionManager.inMemory(cwd);
		const ctx = { cwd, sessionManager } as unknown as ExtensionContext;

		const firstRead = await tool.execute("call-3", { path: "sample.txt" }, undefined, undefined, ctx);
		expect(firstRead.details?.readcache?.mode).toBe("full");
		appendReadResult(sessionManager, "call-3", firstRead);

		const changed = [...lines];
		changed[199] = "line 200 :: changed text payload";
		await writeFile(filePath, changed.join("\n"), "utf-8");

		const secondRead = await tool.execute("call-4", { path: "sample.txt" }, undefined, undefined, ctx);
		const diffText = secondRead.content[0] && secondRead.content[0].type === "text" ? secondRead.content[0].text : "";

		expect(secondRead.details?.readcache?.mode).toBe("diff");
		expect(secondRead.details?.readcache?.debug).toMatchObject({
			reason: "diff_emitted",
			scope: "full",
			baseHashFound: true,
			diffAttempted: true,
			diffChangedLines: 1,
		});
		expect(diffText).toContain("[readcache: 1 lines changed of 300]");
		expect(diffText).toContain("--- a/sample.txt");
		expect(diffText).toContain("+++ b/sample.txt");
		expect(diffText).toContain("-line 200 :: original text payload");
		expect(diffText).toContain("+line 200 :: changed text payload");
	});

	it("falls back to baseline diff mode for oversized full-file changes", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-readcache-tool-"));
		const filePath = join(cwd, "sample.txt");
		const large = `${"a".repeat(2 * 1024 * 1024 + 64)}\n`;
		await writeFile(filePath, large, "utf-8");

		const tool = createReadOverrideTool();
		const sessionManager = SessionManager.inMemory(cwd);
		const ctx = { cwd, sessionManager } as unknown as ExtensionContext;

		const firstRead = await tool.execute("call-5", { path: "sample.txt" }, undefined, undefined, ctx);
		appendReadResult(sessionManager, "call-5", firstRead);

		await writeFile(filePath, `b${large.slice(1)}`, "utf-8");
		const secondRead = await tool.execute("call-6", { path: "sample.txt" }, undefined, undefined, ctx);
		expect(secondRead.details?.readcache?.mode).toBe("full_fallback");
		expect(secondRead.details?.readcache?.debug).toMatchObject({
			reason: "diff_file_too_large_bytes",
			scope: "full",
			baseHashFound: true,
			diffAttempted: true,
		});
	});

	it("bypasses readcache metadata for excluded sensitive paths", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-readcache-tool-"));
		const paths = [".env.local", "server.key", ".npmrc", "id_ed25519"];
		for (const path of paths) {
			await writeFile(join(cwd, path), `sensitive:${path}`, "utf-8");
		}

		const tool = createReadOverrideTool();
		const sessionManager = SessionManager.inMemory(cwd);
		const ctx = { cwd, sessionManager } as unknown as ExtensionContext;

		for (const path of paths) {
			const result = await tool.execute(`call-7-${path}`, { path }, undefined, undefined, ctx);
			expect(result.details?.readcache).toBeUndefined();
		}
	});

	it("falls back to baseline for non-UTF8 file payloads", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-readcache-tool-"));
		await writeFile(join(cwd, "binary.bin"), Buffer.from([0xff, 0xfe, 0x00, 0xf8]));

		const tool = createReadOverrideTool();
		const sessionManager = SessionManager.inMemory(cwd);
		const ctx = { cwd, sessionManager } as unknown as ExtensionContext;
		const result = await tool.execute("call-8", { path: "binary.bin" }, undefined, undefined, ctx);

		expect(result.details?.readcache).toBeUndefined();
	});

	it("rejects malformed path range suffixes when the target file exists", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-readcache-tool-"));
		await writeFile(join(cwd, "notes.txt"), "1\n2\n3", "utf-8");

		const tool = createReadOverrideTool();
		const sessionManager = SessionManager.inMemory(cwd);
		const ctx = { cwd, sessionManager } as unknown as ExtensionContext;

		await expect(tool.execute("call-9", { path: "notes.txt:3-" }, undefined, undefined, ctx)).rejects.toThrow(
			/Invalid range suffix/,
		);
	});

	it("falls back safely when the base object hash is missing", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-readcache-tool-"));
		const filePath = join(cwd, "sample.txt");
		await writeFile(filePath, "one\ntwo\nthree", "utf-8");

		const tool = createReadOverrideTool();
		const sessionManager = SessionManager.inMemory(cwd);
		const ctx = { cwd, sessionManager } as unknown as ExtensionContext;

		const firstRead = await tool.execute("call-10", { path: "sample.txt" }, undefined, undefined, ctx);
		expect(firstRead.details?.readcache?.mode).toBe("full");
		appendReadResult(sessionManager, "call-10", firstRead);

		const firstHash = firstRead.details?.readcache?.servedHash;
		expect(firstHash).toBeDefined();
		if (!firstHash) {
			throw new Error("expected served hash");
		}
		await unlink(objectPathForHash(cwd, firstHash));

		await writeFile(filePath, "one\nTWO\nthree", "utf-8");
		const secondRead = await tool.execute("call-11", { path: "sample.txt" }, undefined, undefined, ctx);

		expect(secondRead.details?.readcache?.mode).toBe("full_fallback");
		const text = secondRead.content[0] && secondRead.content[0].type === "text" ? secondRead.content[0].text : "";
		expect(text).toContain("TWO");
	});

	it("preserves baseline truncation details when metadata is attached", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-readcache-tool-"));
		const lines = Array.from({ length: 2200 }, (_, index) => `line ${index + 1}`);
		await writeFile(join(cwd, "big.txt"), lines.join("\n"), "utf-8");

		const tool = createReadOverrideTool();
		const sessionManager = SessionManager.inMemory(cwd);
		const ctx = { cwd, sessionManager } as unknown as ExtensionContext;
		const result = await tool.execute("call-12", { path: "big.txt" }, undefined, undefined, ctx);

		expect(result.details?.truncation).toBeDefined();
		expect(result.details?.readcache?.mode).toBe("full");
	});

	it("delegates image reads to baseline behavior without readcache metadata", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-readcache-tool-"));
		const pngBytes = Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO5uS1QAAAAASUVORK5CYII=",
			"base64",
		);
		await writeFile(join(cwd, "tiny.png"), pngBytes);

		const tool = createReadOverrideTool();
		const sessionManager = SessionManager.inMemory(cwd);
		const ctx = { cwd, sessionManager } as unknown as ExtensionContext;
		const result = await tool.execute("call-13", { path: "tiny.png" }, undefined, undefined, ctx);

		expect(result.content.some((content) => content.type === "image")).toBe(true);
		expect(result.details?.readcache).toBeUndefined();
	});

	it("aborts cleanly when cancellation happens during a changed-read flow", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-readcache-tool-"));
		const filePath = join(cwd, "sample.txt");
		const lines = Array.from({ length: 1600 }, (_, index) => `line ${index + 1} payload`);
		await writeFile(filePath, lines.join("\n"), "utf-8");

		const tool = createReadOverrideTool();
		const sessionManager = SessionManager.inMemory(cwd);
		const ctx = { cwd, sessionManager } as unknown as ExtensionContext;

		const firstRead = await tool.execute("call-14", { path: "sample.txt" }, undefined, undefined, ctx);
		expect(firstRead.details?.readcache?.mode).toBe("full");
		appendReadResult(sessionManager, "call-14", firstRead);

		const changed = [...lines];
		changed[799] = "line 800 changed payload";
		await writeFile(filePath, changed.join("\n"), "utf-8");

		const controller = new AbortController();
		const pending = tool.execute("call-15", { path: "sample.txt" }, controller.signal, undefined, ctx);
		controller.abort();

		await expect(pending).rejects.toThrow(/Operation aborted/);
	});
});
