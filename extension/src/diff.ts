import { formatPatch, structuredPatch } from "diff";
import {
	MAX_DIFF_FILE_BYTES,
	MAX_DIFF_FILE_LINES,
	MAX_DIFF_TO_BASE_RATIO,
} from "./constants.js";

const PATCH_SEPARATOR_LINE = "===================================================================";

export interface DiffLimits {
	maxFileBytes: number;
	maxFileLines: number;
	maxDiffToBaseRatio: number;
}

export interface DiffComputation {
	diffText: string;
	changedLines: number;
	addedLines: number;
	removedLines: number;
	diffBytes: number;
}

export const DEFAULT_DIFF_LIMITS: DiffLimits = {
	maxFileBytes: MAX_DIFF_FILE_BYTES,
	maxFileLines: MAX_DIFF_FILE_LINES,
	maxDiffToBaseRatio: MAX_DIFF_TO_BASE_RATIO,
};

function sanitizePathForPatch(pathDisplay: string): string {
	const trimmed = pathDisplay.trim();
	if (!trimmed) {
		return "unknown";
	}
	return trimmed.replace(/[\t\r\n]/g, "_");
}

function stripPatchSeparator(patch: string): string {
	const lines = patch.split("\n");
	if (lines[0] === PATCH_SEPARATOR_LINE) {
		return lines.slice(1).join("\n").trimEnd();
	}
	return patch.trimEnd();
}

function lineCount(text: string): number {
	if (text.length === 0) {
		return 1;
	}
	return text.split("\n").length;
}

function countChangedLinesFromPatch(diffText: string): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const line of diffText.split("\n")) {
		if (!line) {
			continue;
		}
		if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@")) {
			continue;
		}
		if (line.startsWith("+")) {
			added += 1;
			continue;
		}
		if (line.startsWith("-")) {
			removed += 1;
		}
	}
	return { added, removed };
}

export function computeUnifiedDiff(baseText: string, currentText: string, pathDisplay: string): DiffComputation | undefined {
	const safePath = sanitizePathForPatch(pathDisplay);
	const patch = structuredPatch(`a/${safePath}`, `b/${safePath}`, baseText, currentText, "", "", {
		context: 3,
	});
	if (patch.hunks.length === 0) {
		return undefined;
	}

	const diffText = stripPatchSeparator(formatPatch(patch));
	if (!diffText.includes("@@")) {
		return undefined;
	}

	const { added, removed } = countChangedLinesFromPatch(diffText);
	return {
		diffText,
		changedLines: Math.max(added, removed),
		addedLines: added,
		removedLines: removed,
		diffBytes: Buffer.byteLength(diffText, "utf-8"),
	};
}

export function isDiffUseful(
	diffText: string,
	selectedBaseText: string,
	selectedCurrentText: string,
	limits: DiffLimits = DEFAULT_DIFF_LIMITS,
): boolean {
	if (diffText.trim().length === 0 || !diffText.includes("@@")) {
		return false;
	}

	const baseBytes = Buffer.byteLength(selectedBaseText, "utf-8");
	const currentBytes = Buffer.byteLength(selectedCurrentText, "utf-8");
	const selectedBytes = Math.max(baseBytes, currentBytes);
	if (selectedBytes === 0) {
		return false;
	}

	if (selectedBytes > limits.maxFileBytes) {
		return false;
	}

	const maxLines = Math.max(lineCount(selectedBaseText), lineCount(selectedCurrentText));
	if (maxLines > limits.maxFileLines) {
		return false;
	}

	const diffBytes = Buffer.byteLength(diffText, "utf-8");
	if (diffBytes === 0) {
		return false;
	}

	return diffBytes < selectedBytes * limits.maxDiffToBaseRatio;
}
