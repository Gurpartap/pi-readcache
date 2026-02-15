import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	expandPath,
	normalizeOffsetLimit,
	parseTrailingRangeIfNeeded,
	resolveReadPath,
	scopeKeyForRange,
} from "../../src/path.js";

describe("path", () => {
	it("expands home shortcuts", () => {
		expect(expandPath("~")).toBe(process.env.HOME);
		expect(expandPath("~/notes.txt")).toBe(`${process.env.HOME}/notes.txt`);
	});

	it("resolves @-prefixed and unicode-space paths", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-readcache-path-"));
		await writeFile(join(cwd, "hello world.txt"), "ok", "utf-8");
		await writeFile(join(cwd, "at.txt"), "ok", "utf-8");

		expect(resolveReadPath("hello\u00A0world.txt", cwd)).toBe(join(cwd, "hello world.txt"));
		expect(resolveReadPath("@at.txt", cwd)).toBe(join(cwd, "at.txt"));
	});

	it("keeps existing colon file paths as files", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-readcache-path-"));
		await writeFile(join(cwd, "report:2024.txt"), "ok", "utf-8");

		const parsed = parseTrailingRangeIfNeeded("report:2024.txt", undefined, undefined, cwd);
		expect(parsed.parsedFromPath).toBe(false);
		expect(parsed.pathInput).toBe("report:2024.txt");
	});

	it("parses trailing line shorthand only when safe", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-readcache-path-"));
		await writeFile(join(cwd, "notes.txt"), "1\n2\n3\n4\n5\n6", "utf-8");

		const parsed = parseTrailingRangeIfNeeded("notes.txt:3-6", undefined, undefined, cwd);
		expect(parsed.parsedFromPath).toBe(true);
		expect(parsed.pathInput).toBe("notes.txt");
		expect(parsed.offset).toBe(3);
		expect(parsed.limit).toBe(4);
	});

	it("does not parse shorthand when offset/limit are explicit", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-readcache-path-"));
		await writeFile(join(cwd, "notes.txt"), "1\n2\n3\n4\n5\n6", "utf-8");

		const parsed = parseTrailingRangeIfNeeded("notes.txt:3-6", 10, 2, cwd);
		expect(parsed.parsedFromPath).toBe(false);
		expect(parsed.pathInput).toBe("notes.txt:3-6");
		expect(parsed.offset).toBe(10);
		expect(parsed.limit).toBe(2);
	});

	it("rejects malformed ranges when candidate path exists", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-readcache-path-"));
		await writeFile(join(cwd, "notes.txt"), "1\n2\n3", "utf-8");

		expect(() => parseTrailingRangeIfNeeded("notes.txt:3-", undefined, undefined, cwd)).toThrow(
			/Invalid range suffix/,
		);
		expect(() => parseTrailingRangeIfNeeded("notes.txt:8-2", undefined, undefined, cwd)).toThrow(
			/end line must be greater than or equal to start line/,
		);
	});

	it("normalizes offset/limit and scope keys", () => {
		expect(normalizeOffsetLimit(5, 10, 20)).toEqual({ start: 5, end: 14, totalLines: 20 });
		expect(normalizeOffsetLimit(undefined, undefined, 20)).toEqual({ start: 1, end: 20, totalLines: 20 });
		expect(scopeKeyForRange(1, 20, 20)).toBe("full");
		expect(scopeKeyForRange(2, 5, 20)).toBe("r:2:5");
		expect(() => normalizeOffsetLimit(99, undefined, 10)).toThrow(/beyond end of file/);
		expect(() => normalizeOffsetLimit(0, undefined, 10)).toThrow(/positive integer/);
		expect(() => normalizeOffsetLimit(1, 0, 10)).toThrow(/positive integer/);
	});

	it("resolves macOS screenshot AM/PM variants", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-readcache-path-"));
		const narrowNoBreakSpace = "\u202F";
		const filenameWithNarrowSpace = `Screen Shot 2026-01-01 at 10.00.00${narrowNoBreakSpace}AM.png`;
		await writeFile(join(cwd, filenameWithNarrowSpace), "png", "utf-8");

		const resolved = resolveReadPath("Screen Shot 2026-01-01 at 10.00.00 AM.png", cwd);
		expect(resolved).toBe(join(cwd, filenameWithNarrowSpace));
	});
});
