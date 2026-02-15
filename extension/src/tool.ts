import { readFile } from "node:fs/promises";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	createReadTool,
	type AgentToolResult,
	type ExtensionContext,
	type ReadToolDetails,
} from "@mariozechner/pi-coding-agent";
import { type Static, Type } from "@sinclair/typebox";
import { SCOPE_FULL } from "./constants.js";
import { buildReadCacheMetaV1 } from "./meta.js";
import { hashBytes, loadObject, persistObjectIfAbsent } from "./object-store.js";
import { normalizeOffsetLimit, parseTrailingRangeIfNeeded, scopeKeyForRange } from "./path.js";
import { buildKnowledgeForLeaf, createReplayRuntimeState, overlaySet, type ReplayRuntimeState } from "./replay.js";
import { compareSlices, splitLines } from "./text.js";
import type { ReadCacheMetaV1, ReadToolDetailsExt, ScopeKey } from "./types.js";

const UTF8_STRICT_DECODER = new TextDecoder("utf-8", { fatal: true });

interface CurrentTextState {
	bytes: Buffer;
	text: string;
	totalLines: number;
	currentHash: string;
}

export const readToolSchema = Type.Object({
	path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
	offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
});

export type ReadToolParams = Static<typeof readToolSchema>;

function buildReadDescription(): string {
	return `Read the contents of a file. Supports text files and images (jpg, png, gif, webp). Images are sent as attachments. For text files, output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.`;
}

function hasImageContent(result: AgentToolResult<ReadToolDetails | undefined>): boolean {
	return result.content.some((block) => block.type === "image");
}

function withReadcacheDetails(details: ReadToolDetails | undefined, readcache: ReadCacheMetaV1): ReadToolDetailsExt {
	return {
		...(details ?? {}),
		readcache,
	};
}

function attachMetaToBaseline(
	baselineResult: AgentToolResult<ReadToolDetails | undefined>,
	meta: ReadCacheMetaV1,
): AgentToolResult<ReadToolDetailsExt | undefined> {
	return {
		...baselineResult,
		details: withReadcacheDetails(baselineResult.details, meta),
	};
}

function buildMarkerResult(marker: string, meta: ReadCacheMetaV1): AgentToolResult<ReadToolDetailsExt | undefined> {
	return {
		content: [{ type: "text", text: marker }],
		details: withReadcacheDetails(undefined, meta),
	};
}

function buildBaselineInput(path: string, offset: number | undefined, limit: number | undefined): ReadToolParams {
	const input: ReadToolParams = { path };
	if (offset !== undefined) {
		input.offset = offset;
	}
	if (limit !== undefined) {
		input.limit = limit;
	}
	return input;
}

function buildReadcacheMeta(
	pathKey: string,
	scopeKey: ScopeKey,
	servedHash: string,
	mode: ReadCacheMetaV1["mode"],
	totalLines: number,
	rangeStart: number,
	rangeEnd: number,
	bytes: number,
	baseHash?: string,
): ReadCacheMetaV1 {
	return buildReadCacheMetaV1({
		pathKey,
		scopeKey,
		servedHash,
		...(baseHash !== undefined ? { baseHash } : {}),
		mode,
		totalLines,
		rangeStart,
		rangeEnd,
		bytes,
	});
}

function buildUnchangedMarker(scopeKey: ScopeKey, start: number, end: number, totalLines: number, outsideRangeChanged: boolean): string {
	if (scopeKey === SCOPE_FULL) {
		return `[readcache: unchanged, ${totalLines} lines]`;
	}
	if (outsideRangeChanged) {
		return `[readcache: unchanged in lines ${start}-${end}; changes exist outside this range]`;
	}
	return `[readcache: unchanged in lines ${start}-${end} of ${totalLines}]`;
}

async function readCurrentTextStrict(absolutePath: string): Promise<CurrentTextState | undefined> {
	let fileBytes: Buffer;
	try {
		fileBytes = await readFile(absolutePath);
	} catch {
		return undefined;
	}

	let text: string;
	try {
		text = UTF8_STRICT_DECODER.decode(fileBytes);
	} catch {
		return undefined;
	}

	const totalLines = splitLines(text).length;
	return {
		bytes: fileBytes,
		text,
		totalLines,
		currentHash: hashBytes(fileBytes),
	};
}

async function persistAndOverlay(
	runtimeState: ReplayRuntimeState,
	ctx: ExtensionContext,
	pathKey: string,
	scopeKey: ScopeKey,
	servedHash: string,
	text: string,
): Promise<void> {
	try {
		await persistObjectIfAbsent(ctx.cwd, servedHash, text);
	} catch {
		// Object persistence failures are fail-open.
	}
	overlaySet(runtimeState, ctx.sessionManager, pathKey, scopeKey, servedHash);
}

export function createReadOverrideTool(runtimeState: ReplayRuntimeState = createReplayRuntimeState()) {
	return {
		name: "read",
		label: "read",
		description: buildReadDescription(),
		parameters: readToolSchema,
		execute: async (
			toolCallId: string,
			params: ReadToolParams,
			signal?: AbortSignal,
			onUpdate?: (partial: AgentToolResult<ReadToolDetailsExt | undefined>) => void,
			ctx?: ExtensionContext,
		): Promise<AgentToolResult<ReadToolDetailsExt | undefined>> => {
			if (!ctx) {
				throw new Error("read override requires extension context");
			}

			const parsed = parseTrailingRangeIfNeeded(params.path, params.offset, params.limit, ctx.cwd);
			const baseline = createReadTool(ctx.cwd);
			const baselineInput = buildBaselineInput(parsed.pathInput, parsed.offset, parsed.limit);
			const baselineResult = await baseline.execute(toolCallId, baselineInput, signal, onUpdate);

			if (hasImageContent(baselineResult)) {
				return baselineResult;
			}

			const current = await readCurrentTextStrict(parsed.absolutePath);
			if (!current) {
				return baselineResult;
			}

			let start: number;
			let end: number;
			let totalLines: number;
			try {
				const normalizedRange = normalizeOffsetLimit(parsed.offset, parsed.limit, current.totalLines);
				start = normalizedRange.start;
				end = normalizedRange.end;
				totalLines = normalizedRange.totalLines;
			} catch {
				return baselineResult;
			}

			const pathKey = parsed.absolutePath;
			const scopeKey = scopeKeyForRange(start, end, totalLines);
			const knowledge = buildKnowledgeForLeaf(ctx.sessionManager, runtimeState);
			const pathKnowledge = knowledge.get(pathKey);
			const baseHash = pathKnowledge?.get(scopeKey) ?? (scopeKey !== SCOPE_FULL ? pathKnowledge?.get(SCOPE_FULL) : undefined);

			if (!baseHash) {
				const meta = buildReadcacheMeta(
					pathKey,
					scopeKey,
					current.currentHash,
					"full",
					totalLines,
					start,
					end,
					current.bytes.byteLength,
				);
				await persistAndOverlay(runtimeState, ctx, pathKey, scopeKey, current.currentHash, current.text);
				return attachMetaToBaseline(baselineResult, meta);
			}

			if (baseHash === current.currentHash) {
				const mode = scopeKey === SCOPE_FULL ? "unchanged" : "unchanged_range";
				const meta = buildReadcacheMeta(
					pathKey,
					scopeKey,
					current.currentHash,
					mode,
					totalLines,
					start,
					end,
					current.bytes.byteLength,
					baseHash,
				);
				const marker = buildUnchangedMarker(scopeKey, start, end, totalLines, false);
				await persistAndOverlay(runtimeState, ctx, pathKey, scopeKey, current.currentHash, current.text);
				return buildMarkerResult(marker, meta);
			}

			let baseText: string | undefined;
			try {
				baseText = await loadObject(ctx.cwd, baseHash);
			} catch {
				baseText = undefined;
			}

			if (!baseText) {
				const meta = buildReadcacheMeta(
					pathKey,
					scopeKey,
					current.currentHash,
					"full_fallback",
					totalLines,
					start,
					end,
					current.bytes.byteLength,
					baseHash,
				);
				await persistAndOverlay(runtimeState, ctx, pathKey, scopeKey, current.currentHash, current.text);
				return attachMetaToBaseline(baselineResult, meta);
			}

			if (scopeKey !== SCOPE_FULL) {
				if (compareSlices(baseText, current.text, start, end)) {
					const meta = buildReadcacheMeta(
						pathKey,
						scopeKey,
						current.currentHash,
						"unchanged_range",
						totalLines,
						start,
						end,
						current.bytes.byteLength,
						baseHash,
					);
					const marker = buildUnchangedMarker(scopeKey, start, end, totalLines, true);
					await persistAndOverlay(runtimeState, ctx, pathKey, scopeKey, current.currentHash, current.text);
					return buildMarkerResult(marker, meta);
				}
			}

			const meta = buildReadcacheMeta(
				pathKey,
				scopeKey,
				current.currentHash,
				"full_fallback",
				totalLines,
				start,
				end,
				current.bytes.byteLength,
				baseHash,
			);
			await persistAndOverlay(runtimeState, ctx, pathKey, scopeKey, current.currentHash, current.text);
			return attachMetaToBaseline(baselineResult, meta);
		},
	};
}
