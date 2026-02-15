import { describe, expect, it } from "vitest";
import { compareSlices, estimateTokens, sliceByLineRange, splitLines, truncateForReadcache } from "../../src/text.js";

describe("text", () => {
	it("splits text into lines", () => {
		expect(splitLines("a\nb\nc")).toEqual(["a", "b", "c"]);
		expect(splitLines("")).toEqual([""]);
	});

	it("slices content by 1-based inclusive line ranges", () => {
		const text = "l1\nl2\nl3\nl4";
		expect(sliceByLineRange(text, 2, 3)).toBe("l2\nl3");
		expect(sliceByLineRange(text, 4, 10)).toBe("l4");
		expect(sliceByLineRange(text, 99, 120)).toBe("");
		expect(() => sliceByLineRange(text, 0, 1)).toThrow(/positive integers/);
		expect(() => sliceByLineRange(text, 3, 2)).toThrow(/greater than or equal/);
	});

	it("compares slices across two texts", () => {
		const oldText = "a\nb\nc\nd";
		const newText = "x\nb\nc\ny";
		expect(compareSlices(oldText, newText, 2, 3)).toBe(true);
		expect(compareSlices(oldText, newText, 1, 2)).toBe(false);
	});

	it("estimates tokens from utf-8 size", () => {
		expect(estimateTokens("")).toBe(0);
		expect(estimateTokens("abcd")).toBe(1);
		expect(estimateTokens("a".repeat(40))).toBe(10);
	});

	it("applies shared truncation semantics", () => {
		const text = "1\n2\n3\n4";
		const truncation = truncateForReadcache(text, { maxLines: 2, maxBytes: 50_000 });
		expect(truncation.truncated).toBe(true);
		expect(truncation.content).toBe("1\n2");
		expect(truncation.truncatedBy).toBe("lines");
	});
});
