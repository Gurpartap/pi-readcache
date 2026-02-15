import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { createReadOverrideTool } from "../../src/tool.js";

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
});
