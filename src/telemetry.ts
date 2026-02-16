import type { ExtensionContext, SessionEntry } from "@mariozechner/pi-coding-agent";
import { extractReadMetaFromSessionEntry } from "./meta.js";
import { findReplayStartIndex } from "./replay.js";
import type { KnowledgeMap, ReadCacheMode } from "./types.js";

export type ReadCacheModeCounts = Record<ReadCacheMode, number>;

export interface ReplayTelemetrySummary {
	replayStartIndex: number;
	replayEntryCount: number;
	modeCounts: ReadCacheModeCounts;
	estimatedBytesSaved: number;
	estimatedTokensSaved: number;
}

function createModeCounts(): ReadCacheModeCounts {
	return {
		full: 0,
		unchanged: 0,
		unchanged_range: 0,
		diff: 0,
		baseline_fallback: 0,
	};
}

function estimateSelectedBytes(meta: {
	bytes: number;
	rangeStart: number;
	rangeEnd: number;
	totalLines: number;
}): number {
	const rangeLines = Math.max(1, meta.rangeEnd - meta.rangeStart + 1);
	const totalLines = Math.max(1, meta.totalLines);
	const ratio = Math.min(1, rangeLines / totalLines);
	return Math.max(1, Math.round(meta.bytes * ratio));
}

function extractTextBytes(entry: SessionEntry): number {
	if (entry.type !== "message" || entry.message.role !== "toolResult") {
		return 0;
	}

	let total = 0;
	for (const block of entry.message.content) {
		if (block.type !== "text") {
			continue;
		}
		total += Buffer.byteLength(block.text, "utf-8");
	}
	return total;
}

function estimateSavedBytes(entry: SessionEntry, baselineBytes: number): number {
	const servedBytes = extractTextBytes(entry);
	if (servedBytes <= 0) {
		return 0;
	}
	return Math.max(0, baselineBytes - servedBytes);
}

function estimateTokensFromBytes(bytes: number): number {
	if (bytes <= 0) {
		return 0;
	}
	return Math.ceil(bytes / 4);
}

export function collectReplayTelemetry(sessionManager: ExtensionContext["sessionManager"]): ReplayTelemetrySummary {
	const branchEntries = sessionManager.getBranch();
	const boundary = findReplayStartIndex(branchEntries);
	const modeCounts = createModeCounts();
	let estimatedBytesSaved = 0;

	for (let index = boundary.startIndex; index < branchEntries.length; index += 1) {
		const entry = branchEntries[index];
		if (!entry) {
			continue;
		}

		const meta = extractReadMetaFromSessionEntry(entry);
		if (!meta) {
			continue;
		}

		modeCounts[meta.mode] += 1;
		const baselineBytes = estimateSelectedBytes(meta);
		estimatedBytesSaved += estimateSavedBytes(entry, baselineBytes);
	}

	return {
		replayStartIndex: boundary.startIndex,
		replayEntryCount: Math.max(0, branchEntries.length - boundary.startIndex),
		modeCounts,
		estimatedBytesSaved,
		estimatedTokensSaved: estimateTokensFromBytes(estimatedBytesSaved),
	};
}

export function summarizeKnowledge(knowledge: KnowledgeMap): { trackedFiles: number; trackedScopes: number } {
	let trackedScopes = 0;
	for (const scopes of knowledge.values()) {
		trackedScopes += scopes.size;
	}
	return {
		trackedFiles: knowledge.size,
		trackedScopes,
	};
}
