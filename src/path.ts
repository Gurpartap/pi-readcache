import { accessSync, constants } from "node:fs";
import * as os from "node:os";
import { isAbsolute, resolve as resolvePath } from "node:path";
import { SCOPE_FULL, scopeRange } from "./constants.js";
import type { ScopeKey } from "./types.js";

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
const NARROW_NO_BREAK_SPACE = "\u202F";

function normalizeUnicodeSpaces(value: string): string {
	return value.replace(UNICODE_SPACES, " ");
}

function normalizeAtPrefix(value: string): string {
	return value.startsWith("@") ? value.slice(1) : value;
}

function tryMacOSScreenshotPath(filePath: string): string {
	return filePath.replace(/ (AM|PM)\./g, `${NARROW_NO_BREAK_SPACE}$1.`);
}

function tryNfdVariant(filePath: string): string {
	return filePath.normalize("NFD");
}

function tryCurlyQuoteVariant(filePath: string): string {
	return filePath.replace(/'/g, "\u2019");
}

function fileExists(filePath: string): boolean {
	try {
		accessSync(filePath, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

function validateLineNumber(value: number, label: "start" | "end"): void {
	if (!Number.isInteger(value) || value <= 0) {
		throw new Error(`Invalid ${label} line number "${value}". Line numbers must be positive integers.`);
	}
}

function parseRangeSuffix(suffix: string): { start: number; end?: number } {
	const singleLineMatch = /^(\d+)$/.exec(suffix);
	if (singleLineMatch) {
		const startRaw = singleLineMatch[1];
		if (!startRaw) {
			throw new Error(`Invalid range suffix "${suffix}". Use :<start> or :<start>-<end>.`);
		}
		const start = Number.parseInt(startRaw, 10);
		validateLineNumber(start, "start");
		return { start };
	}

	const rangeMatch = /^(\d+)-(\d+)$/.exec(suffix);
	if (rangeMatch) {
		const startRaw = rangeMatch[1];
		const endRaw = rangeMatch[2];
		if (!startRaw || !endRaw) {
			throw new Error(`Invalid range suffix "${suffix}". Use :<start> or :<start>-<end>.`);
		}
		const start = Number.parseInt(startRaw, 10);
		const end = Number.parseInt(endRaw, 10);
		validateLineNumber(start, "start");
		validateLineNumber(end, "end");
		if (end < start) {
			throw new Error(`Invalid range "${suffix}": end line must be greater than or equal to start line.`);
		}
		return { start, end };
	}

	throw new Error(`Invalid range suffix "${suffix}". Use :<start> or :<start>-<end>.`);
}

export interface ParsedReadPath {
	pathInput: string;
	absolutePath: string;
	offset?: number;
	limit?: number;
	parsedFromPath: boolean;
}

export interface NormalizedRange {
	start: number;
	end: number;
	totalLines: number;
}

export function expandPath(filePath: string): string {
	const normalized = normalizeUnicodeSpaces(normalizeAtPrefix(filePath));
	if (normalized === "~") {
		return os.homedir();
	}
	if (normalized.startsWith("~/")) {
		return os.homedir() + normalized.slice(1);
	}
	return normalized;
}

export function resolveToCwd(filePath: string, cwd: string): string {
	const expanded = expandPath(filePath);
	if (isAbsolute(expanded)) {
		return expanded;
	}
	return resolvePath(cwd, expanded);
}

export function resolveReadPath(filePath: string, cwd: string): string {
	const resolved = resolveToCwd(filePath, cwd);
	if (fileExists(resolved)) {
		return resolved;
	}

	const amPmVariant = tryMacOSScreenshotPath(resolved);
	if (amPmVariant !== resolved && fileExists(amPmVariant)) {
		return amPmVariant;
	}

	const nfdVariant = tryNfdVariant(resolved);
	if (nfdVariant !== resolved && fileExists(nfdVariant)) {
		return nfdVariant;
	}

	const curlyVariant = tryCurlyQuoteVariant(resolved);
	if (curlyVariant !== resolved && fileExists(curlyVariant)) {
		return curlyVariant;
	}

	const nfdCurlyVariant = tryCurlyQuoteVariant(nfdVariant);
	if (nfdCurlyVariant !== resolved && fileExists(nfdCurlyVariant)) {
		return nfdCurlyVariant;
	}

	return resolved;
}

export function normalizeInputPath(rawPath: string, cwd: string): ParsedReadPath {
	return {
		pathInput: rawPath,
		absolutePath: resolveReadPath(rawPath, cwd),
		parsedFromPath: false,
	};
}

export function parseTrailingRangeIfNeeded(
	rawPath: string,
	explicitOffset: number | undefined,
	explicitLimit: number | undefined,
	cwd: string,
): ParsedReadPath {
	if (explicitOffset !== undefined || explicitLimit !== undefined) {
		const parsed: ParsedReadPath = {
			pathInput: rawPath,
			absolutePath: resolveReadPath(rawPath, cwd),
			parsedFromPath: false,
		};
		if (explicitOffset !== undefined) {
			parsed.offset = explicitOffset;
		}
		if (explicitLimit !== undefined) {
			parsed.limit = explicitLimit;
		}
		return parsed;
	}

	const resolvedRawPath = resolveReadPath(rawPath, cwd);
	if (fileExists(resolvedRawPath)) {
		return {
			pathInput: rawPath,
			absolutePath: resolvedRawPath,
			parsedFromPath: false,
		};
	}

	const lastColonIndex = rawPath.lastIndexOf(":");
	if (lastColonIndex <= 0 || lastColonIndex === rawPath.length - 1) {
		return {
			pathInput: rawPath,
			absolutePath: resolvedRawPath,
			parsedFromPath: false,
		};
	}

	const candidatePath = rawPath.slice(0, lastColonIndex);
	const suffix = rawPath.slice(lastColonIndex + 1);
	const resolvedCandidatePath = resolveReadPath(candidatePath, cwd);
	if (!fileExists(resolvedCandidatePath)) {
		return {
			pathInput: rawPath,
			absolutePath: resolvedRawPath,
			parsedFromPath: false,
		};
	}

	const parsedRange = parseRangeSuffix(suffix);
	const offset = parsedRange.start;
	const limit = parsedRange.end !== undefined ? parsedRange.end - parsedRange.start + 1 : undefined;

	const parsed: ParsedReadPath = {
		pathInput: candidatePath,
		absolutePath: resolvedCandidatePath,
		offset,
		parsedFromPath: true,
	};
	if (limit !== undefined) {
		parsed.limit = limit;
	}
	return parsed;
}

export function normalizeOffsetLimit(
	offset: number | undefined,
	limit: number | undefined,
	totalLines: number,
): NormalizedRange {
	if (offset !== undefined && (!Number.isInteger(offset) || offset <= 0)) {
		throw new Error(`Invalid offset "${offset}". Offset must be a positive integer.`);
	}
	if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
		throw new Error(`Invalid limit "${limit}". Limit must be a positive integer.`);
	}

	const normalizedTotalLines = Math.max(1, totalLines);
	const start = offset ?? 1;
	if (start > normalizedTotalLines) {
		throw new Error(`Offset ${start} is beyond end of file (${normalizedTotalLines} lines total)`);
	}

	const unclampedEnd = limit !== undefined ? start + limit - 1 : normalizedTotalLines;
	const end = Math.min(unclampedEnd, normalizedTotalLines);

	return {
		start,
		end,
		totalLines: normalizedTotalLines,
	};
}

export function scopeKeyForRange(start: number, end: number, totalLines: number): ScopeKey {
	if (start === 1 && end === totalLines) {
		return SCOPE_FULL;
	}
	return scopeRange(start, end);
}
