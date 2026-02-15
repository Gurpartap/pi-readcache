import { describe, expect, it } from "vitest";
import { computeUnifiedDiff, isDiffUseful } from "../../src/diff.js";

describe("diff", () => {
	it("computes deterministic unified diffs for full-scope changes", () => {
		const baseText = ["line 1", "line 2", "line 3"].join("\n");
		const currentText = ["line 1", "line 2 updated", "line 3"].join("\n");

		const diff = computeUnifiedDiff(baseText, currentText, "sample.txt");
		expect(diff).toBeDefined();
		expect(diff?.diffText).toContain("--- a/sample.txt");
		expect(diff?.diffText).toContain("+++ b/sample.txt");
		expect(diff?.diffText).toContain("@@ -1,3 +1,3 @@");
		expect(diff?.diffText).toContain("-line 2");
		expect(diff?.diffText).toContain("+line 2 updated");
		expect(diff?.changedLines).toBe(1);
		expect(diff?.diffText.startsWith("===")).toBe(false);
	});

	it("returns undefined when there are no line-level hunks", () => {
		const diff = computeUnifiedDiff("same\ntext", "same\ntext", "sample.txt");
		expect(diff).toBeUndefined();
	});

	it("gates diff usefulness by size ratio and file thresholds", () => {
		const usefulDiff = computeUnifiedDiff("a\nb\nc", "a\nB\nc", "sample.txt");
		expect(usefulDiff).toBeDefined();
		expect(
			isDiffUseful(usefulDiff?.diffText ?? "", "a\nb\nc", "a\nB\nc", {
				maxFileBytes: 1024,
				maxFileLines: 100,
				maxDiffToBaseRatio: 100,
			}),
		).toBe(true);

		const notUsefulByRatio = isDiffUseful("@@\n" + "x".repeat(200), "small", "small", {
			maxFileBytes: 1024,
			maxFileLines: 100,
			maxDiffToBaseRatio: 1,
		});
		expect(notUsefulByRatio).toBe(false);

		const notUsefulByLineLimit = isDiffUseful("@@ -1 +1 @@\n-a\n+b", "a\n".repeat(200), "b\n".repeat(200), {
			maxFileBytes: 1024 * 1024,
			maxFileLines: 50,
			maxDiffToBaseRatio: 2,
		});
		expect(notUsefulByLineLimit).toBe(false);
	});
});
