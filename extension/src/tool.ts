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
import { buildReadCacheMetaV1 } from "./meta.js";
import { hashBytes } from "./object-store.js";
import { normalizeOffsetLimit, parseTrailingRangeIfNeeded, scopeKeyForRange } from "./path.js";
import { splitLines } from "./text.js";
import type { ReadCacheMetaV1, ReadToolDetailsExt } from "./types.js";

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

async function buildBaselineMeta(
	ctx: ExtensionContext,
	normalizedPath: string,
	offset: number | undefined,
	limit: number | undefined,
): Promise<ReadCacheMetaV1> {
	const fileBytes = await readFile(normalizedPath);
	const text = fileBytes.toString("utf-8");
	const lines = splitLines(text);
	const totalLines = lines.length;
	const range = normalizeOffsetLimit(offset, limit, totalLines);

	return buildReadCacheMetaV1({
		pathKey: normalizedPath,
		scopeKey: scopeKeyForRange(range.start, range.end, range.totalLines),
		servedHash: hashBytes(fileBytes),
		mode: "full",
		totalLines: range.totalLines,
		rangeStart: range.start,
		rangeEnd: range.end,
		bytes: fileBytes.byteLength,
	});
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

export function createReadOverrideTool() {
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

			try {
				const meta = await buildBaselineMeta(ctx, parsed.absolutePath, parsed.offset, parsed.limit);
				return {
					...baselineResult,
					details: withReadcacheDetails(baselineResult.details, meta),
				};
			} catch {
				return baselineResult;
			}
		},
	};
}
