import { constants as fsConstants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import { type Static, Type } from "@sinclair/typebox";
import { READCACHE_CUSTOM_TYPE, SCOPE_FULL, scopeRange } from "./constants.js";
import { buildInvalidationV1 } from "./meta.js";
import { getStoreStats } from "./object-store.js";
import { normalizeOffsetLimit, parseTrailingRangeIfNeeded, resolveReadPath, scopeKeyForRange } from "./path.js";
import { buildKnowledgeForLeaf, clearReplayRuntimeState, type ReplayRuntimeState } from "./replay.js";
import { collectReplayTelemetry, summarizeKnowledge } from "./telemetry.js";
import { splitLines } from "./text.js";
import type { ScopeKey } from "./types.js";

const STATUS_MESSAGE_TYPE = "pi-readcache-status";
const REFRESH_MESSAGE_TYPE = "pi-readcache-refresh";
const UTF8_STRICT_DECODER = new TextDecoder("utf-8", { fatal: true });

const readcacheRefreshSchema = Type.Object({
	path: Type.String({ description: "Path to refresh (same input semantics as read)" }),
	offset: Type.Optional(Type.Number({ description: "Line number to start from (1-indexed)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines" })),
});

export type ReadcacheRefreshParams = Static<typeof readcacheRefreshSchema>;

interface RefreshResolution {
	pathKey: string;
	scopeKey: ScopeKey;
	pathInput: string;
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) {
		return `${bytes} B`;
	}
	if (bytes < 1024 * 1024) {
		return `${(bytes / 1024).toFixed(1)} KiB`;
	}
	return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function formatModeCounts(modeCounts: ReturnType<typeof collectReplayTelemetry>["modeCounts"]): string {
	return [
		`full=${modeCounts.full}`,
		`unchanged=${modeCounts.unchanged}`,
		`unchanged_range=${modeCounts.unchanged_range}`,
		`diff=${modeCounts.diff}`,
		`full_fallback=${modeCounts.full_fallback}`,
	].join(", ");
}

function emitStatusReport(pi: ExtensionAPI, ctx: ExtensionCommandContext, report: string): void {
	pi.sendMessage({
		customType: STATUS_MESSAGE_TYPE,
		content: report,
		display: true,
	});

	if (ctx.hasUI) {
		ctx.ui.notify("Readcache status generated", "info");
	}
}

function emitRefreshReport(pi: ExtensionAPI, ctx: ExtensionCommandContext, report: string): void {
	pi.sendMessage({
		customType: REFRESH_MESSAGE_TYPE,
		content: report,
		display: true,
	});

	if (ctx.hasUI) {
		ctx.ui.notify("Readcache refresh invalidation appended", "info");
	}
}

function stripWrappingQuotes(value: string): string {
	if (value.length < 2) {
		return value;
	}
	const first = value[0];
	const last = value[value.length - 1];
	if (!first || !last) {
		return value;
	}
	if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
		return value.slice(1, -1);
	}
	return value;
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path, fsConstants.F_OK);
		return true;
	} catch {
		return false;
	}
}

function isPositiveInteger(value: number | undefined): value is number {
	return value !== undefined && Number.isInteger(value) && value > 0;
}

function parseRangeToken(value: string): { offset: number; limit?: number } {
	const singleMatch = /^(\d+)$/.exec(value);
	if (singleMatch) {
		const offsetRaw = singleMatch[1];
		if (!offsetRaw) {
			throw new Error(`Invalid range token "${value}".`);
		}
		const offset = Number.parseInt(offsetRaw, 10);
		if (!isPositiveInteger(offset)) {
			throw new Error(`Invalid line number "${value}". Line numbers must be positive integers.`);
		}
		return { offset };
	}

	const rangeMatch = /^(\d+)-(\d+)$/.exec(value);
	if (!rangeMatch) {
		throw new Error(`Invalid range token "${value}". Use <start> or <start>-<end>.`);
	}
	const startRaw = rangeMatch[1];
	const endRaw = rangeMatch[2];
	if (!startRaw || !endRaw) {
		throw new Error(`Invalid range token "${value}". Use <start> or <start>-<end>.`);
	}

	const start = Number.parseInt(startRaw, 10);
	const end = Number.parseInt(endRaw, 10);
	if (!isPositiveInteger(start) || !isPositiveInteger(end)) {
		throw new Error(`Invalid range token "${value}". Line numbers must be positive integers.`);
	}
	if (end < start) {
		throw new Error(`Invalid range "${value}": end line must be greater than or equal to start line.`);
	}

	return {
		offset: start,
		limit: end - start + 1,
	};
}

async function parseRefreshCommandArgs(args: string, cwd: string): Promise<ReadcacheRefreshParams> {
	const trimmed = args.trim();
	if (!trimmed) {
		throw new Error("Usage: /readcache-refresh <path> [start-end]");
	}

	const rangeSuffixMatch = /^(.*)\s+(\d+(?:-\d+)?)$/.exec(trimmed);
	if (!rangeSuffixMatch) {
		return { path: stripWrappingQuotes(trimmed) };
	}

	const fullPathCandidate = stripWrappingQuotes(trimmed);
	const fullPathResolved = resolveReadPath(fullPathCandidate, cwd);
	if (await pathExists(fullPathResolved)) {
		return { path: fullPathCandidate };
	}

	const pathPartRaw = stripWrappingQuotes(rangeSuffixMatch[1]?.trim() ?? "");
	const rangeToken = rangeSuffixMatch[2];
	if (!pathPartRaw || !rangeToken) {
		return { path: fullPathCandidate };
	}

	const range = parseRangeToken(rangeToken);
	return {
		path: pathPartRaw,
		...range,
	};
}

function validateExplicitRange(offset: number | undefined, limit: number | undefined): void {
	if (offset !== undefined && !isPositiveInteger(offset)) {
		throw new Error(`Invalid offset "${offset}". Offset must be a positive integer.`);
	}
	if (limit !== undefined && !isPositiveInteger(limit)) {
		throw new Error(`Invalid limit "${limit}". Limit must be a positive integer.`);
	}
}

async function resolveInvalidationScopeKey(
	absolutePath: string,
	offset: number | undefined,
	limit: number | undefined,
): Promise<ScopeKey> {
	if (offset === undefined && limit === undefined) {
		return SCOPE_FULL;
	}

	validateExplicitRange(offset, limit);

	try {
		const bytes = await readFile(absolutePath);
		const text = UTF8_STRICT_DECODER.decode(bytes);
		const totalLines = splitLines(text).length;
		const normalized = normalizeOffsetLimit(offset, limit, totalLines);
		return scopeKeyForRange(normalized.start, normalized.end, normalized.totalLines);
	} catch {
		if (offset === undefined) {
			return SCOPE_FULL;
		}
		if (limit !== undefined) {
			return scopeRange(offset, offset + limit - 1);
		}
		return SCOPE_FULL;
	}
}

function formatScope(scopeKey: ScopeKey): string {
	if (scopeKey === SCOPE_FULL) {
		return "full scope";
	}
	const parts = scopeKey.split(":");
	const start = parts[1];
	const end = parts[2];
	if (!start || !end) {
		return `scope ${scopeKey}`;
	}
	return `lines ${start}-${end}`;
}

function buildRefreshConfirmation(scopeKey: ScopeKey, pathInput: string): string {
	return `[readcache-refresh] invalidated ${formatScope(scopeKey)} for ${pathInput}`;
}

export async function appendReadcacheInvalidation(
	pi: Pick<ExtensionAPI, "appendEntry">,
	runtimeState: ReplayRuntimeState,
	cwd: string,
	params: ReadcacheRefreshParams,
): Promise<RefreshResolution> {
	const parsed = parseTrailingRangeIfNeeded(params.path, params.offset, params.limit, cwd);
	const scopeKey = await resolveInvalidationScopeKey(parsed.absolutePath, parsed.offset, parsed.limit);

	const invalidation = buildInvalidationV1(parsed.absolutePath, scopeKey, Date.now());
	pi.appendEntry(READCACHE_CUSTOM_TYPE, invalidation);
	clearReplayRuntimeState(runtimeState);

	return {
		pathKey: parsed.absolutePath,
		scopeKey,
		pathInput: parsed.pathInput,
	};
}

export function createReadcacheRefreshTool(
	pi: Pick<ExtensionAPI, "appendEntry">,
	runtimeState: ReplayRuntimeState,
) {
	return {
		name: "readcache_refresh",
		label: "readcache_refresh",
		description: "Invalidate readcache state for a path or range so the next read returns baseline output",
		parameters: readcacheRefreshSchema,
		execute: async (
			_toolCallId: string,
			params: ReadcacheRefreshParams,
			signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: ExtensionContext,
		): Promise<AgentToolResult<undefined>> => {
			if (signal?.aborted) {
				throw new Error("Operation aborted");
			}

			const refreshed = await appendReadcacheInvalidation(pi, runtimeState, ctx.cwd, params);
			return {
				content: [{ type: "text", text: buildRefreshConfirmation(refreshed.scopeKey, refreshed.pathInput) }],
				details: undefined,
			};
		},
	};
}

export function registerReadcacheCommands(pi: ExtensionAPI, runtimeState: ReplayRuntimeState): void {
	pi.registerCommand("readcache-status", {
		description: "Show replay-context readcache status and object store stats",
		handler: async (_args, ctx) => {
			const replayTelemetry = collectReplayTelemetry(ctx.sessionManager);
			const knowledge = buildKnowledgeForLeaf(ctx.sessionManager, runtimeState);
			const knowledgeSummary = summarizeKnowledge(knowledge);

			let storeLine = "object store: unavailable";
			try {
				const storeStats = await getStoreStats(ctx.cwd);
				storeLine = `object store: ${storeStats.objects} objects, ${formatBytes(storeStats.bytes)}`;
			} catch {
				// Best effort only.
			}

			const reportLines = [
				"[readcache-status]",
				`tracked scopes: ${knowledgeSummary.trackedScopes} across ${knowledgeSummary.trackedFiles} files`,
				`replay window: ${replayTelemetry.replayEntryCount} entries (start index ${replayTelemetry.replayStartIndex})`,
				`mode counts: ${formatModeCounts(replayTelemetry.modeCounts)}`,
				`estimated savings: ~${replayTelemetry.estimatedTokensSaved} tokens (${formatBytes(replayTelemetry.estimatedBytesSaved)})`,
				storeLine,
			];

			emitStatusReport(pi, ctx, reportLines.join("\n"));
		},
	});

	pi.registerCommand("readcache-refresh", {
		description: "Invalidate readcache state for a path and optional line range",
		handler: async (args, ctx) => {
			try {
				const parsed = await parseRefreshCommandArgs(args, ctx.cwd);
				const refreshed = await appendReadcacheInvalidation(pi, runtimeState, ctx.cwd, parsed);
				emitRefreshReport(pi, ctx, buildRefreshConfirmation(refreshed.scopeKey, refreshed.pathInput));
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (ctx.hasUI) {
					ctx.ui.notify(message, "error");
				}
				throw error instanceof Error ? error : new Error(message);
			}
		},
	});

	pi.registerTool(createReadcacheRefreshTool(pi, runtimeState) as unknown as ToolDefinition);
}
