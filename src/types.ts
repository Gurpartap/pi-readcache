import type { SessionEntry } from "@mariozechner/pi-coding-agent";
import type { ReadToolDetails } from "@mariozechner/pi-coding-agent";
import type { SCOPE_FULL } from "./constants.js";

export type ScopeRangeKey = `r:${number}:${number}`;
export type ScopeKey = typeof SCOPE_FULL | ScopeRangeKey;

export interface ScopeTrust {
	hash: string;
	seq: number;
}

export type ReadCacheMode = "full" | "unchanged" | "unchanged_range" | "diff" | "full_fallback";

export type ReadCacheDebugReason =
	| "no_base_hash"
	| "hash_match"
	| "base_object_missing"
	| "range_slice_unchanged"
	| "range_slice_changed"
	| "diff_file_too_large_bytes"
	| "diff_file_too_large_lines"
	| "diff_unavailable_or_empty"
	| "diff_not_useful"
	| "diff_payload_truncated"
	| "diff_emitted"
	| "bypass_cache";

export interface ReadCacheDebugV1 {
	reason: ReadCacheDebugReason;
	scope: "full" | "range";
	baseHashFound: boolean;
	diffAttempted: boolean;
	outsideRangeChanged?: boolean;
	baseObjectFound?: boolean;
	largestBytes?: number;
	maxLines?: number;
	diffBytes?: number;
	diffChangedLines?: number;
}

export interface ReadCacheMetaV1 {
	v: 1;
	pathKey: string;
	scopeKey: ScopeKey;
	servedHash: string;
	baseHash?: string;
	mode: ReadCacheMode;
	totalLines: number;
	rangeStart: number;
	rangeEnd: number;
	bytes: number;
	debug?: ReadCacheDebugV1;
}

export interface ReadCacheInvalidationV1 {
	v: 1;
	kind: "invalidate";
	pathKey: string;
	scopeKey: ScopeKey;
	at: number;
}

export interface ReadKnowledgeEvent {
	kind: "read";
	pathKey: string;
	scopeKey: ScopeKey;
	servedHash: string;
}

export interface ReadInvalidationEvent {
	kind: "invalidate";
	pathKey: string;
	scopeKey: ScopeKey;
}

export type ReplayEvent = ReadKnowledgeEvent | ReadInvalidationEvent;

export type KnowledgeMap = Map<string, Map<ScopeKey, ScopeTrust>>;

export interface NormalizedReadRequest {
	inputPath: string;
	absolutePath: string;
	pathKey: string;
	offset?: number;
	limit?: number;
	start: number;
	end: number;
	totalLines: number;
	scopeKey: ScopeKey;
}

export interface ReadToolDetailsExt extends ReadToolDetails {
	readcache?: ReadCacheMetaV1;
}

export interface ExtractedReplayData {
	entry: SessionEntry;
	read?: ReadCacheMetaV1;
	invalidation?: ReadCacheInvalidationV1;
}
