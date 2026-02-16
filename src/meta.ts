import type { SessionEntry } from "@mariozechner/pi-coding-agent";
import { READCACHE_CUSTOM_TYPE, READCACHE_META_VERSION, SCOPE_FULL } from "./constants.js";
import type {
	ReadCacheDebugV1,
	ReadCacheInvalidationV1,
	ReadCacheMetaV1,
	ReadCacheMode,
	ScopeKey,
} from "./types.js";

const RANGE_SCOPE_RE = /^r:(\d+):(\d+)$/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function normalizeReadCacheMode(value: unknown): ReadCacheMode | undefined {
	if (value === "full") {
		return "full";
	}
	if (value === "unchanged") {
		return "unchanged";
	}
	if (value === "unchanged_range") {
		return "unchanged_range";
	}
	if (value === "diff") {
		return "diff";
	}
	if (value === "baseline_fallback") {
		return "baseline_fallback";
	}
	return undefined;
}

function isReadCacheDebugReason(value: unknown): value is ReadCacheDebugV1["reason"] {
	return (
		value === "no_base_hash" ||
		value === "hash_match" ||
		value === "base_object_missing" ||
		value === "range_slice_unchanged" ||
		value === "range_slice_changed" ||
		value === "diff_file_too_large_bytes" ||
		value === "diff_file_too_large_lines" ||
		value === "diff_unavailable_or_empty" ||
		value === "diff_not_useful" ||
		value === "diff_payload_truncated" ||
		value === "diff_emitted" ||
		value === "bypass_cache"
	);
}

function isOptionalBoolean(value: unknown): value is boolean | undefined {
	return value === undefined || typeof value === "boolean";
}

function isOptionalPositiveInteger(value: unknown): value is number | undefined {
	return value === undefined || isPositiveInteger(value);
}

function isOptionalNonNegativeInteger(value: unknown): value is number | undefined {
	return value === undefined || isNonNegativeInteger(value);
}

function isReadCacheDebugV1(value: unknown): value is ReadCacheDebugV1 {
	if (!isRecord(value)) {
		return false;
	}

	if (!isReadCacheDebugReason(value.reason)) {
		return false;
	}

	if (value.scope !== "full" && value.scope !== "range") {
		return false;
	}

	if (typeof value.baseHashFound !== "boolean" || typeof value.diffAttempted !== "boolean") {
		return false;
	}

	return (
		isOptionalBoolean(value.outsideRangeChanged) &&
		isOptionalBoolean(value.baseObjectFound) &&
		isOptionalPositiveInteger(value.largestBytes) &&
		isOptionalPositiveInteger(value.maxLines) &&
		isOptionalNonNegativeInteger(value.diffBytes) &&
		isOptionalNonNegativeInteger(value.diffChangedLines)
	);
}

export function isScopeKey(value: unknown): value is ScopeKey {
	if (value === SCOPE_FULL) {
		return true;
	}
	if (typeof value !== "string") {
		return false;
	}

	const match = RANGE_SCOPE_RE.exec(value);
	if (!match) {
		return false;
	}

	const startRaw = match[1];
	const endRaw = match[2];
	if (!startRaw || !endRaw) {
		return false;
	}

	const start = Number.parseInt(startRaw, 10);
	const end = Number.parseInt(endRaw, 10);
	return Number.isInteger(start) && Number.isInteger(end) && start > 0 && end >= start;
}

function parseReadCacheMetaV1(value: unknown): ReadCacheMetaV1 | undefined {
	if (!isRecord(value)) {
		return undefined;
	}

	if (value.v !== READCACHE_META_VERSION) {
		return undefined;
	}

	if (typeof value.pathKey !== "string" || value.pathKey.length === 0) {
		return undefined;
	}

	if (!isScopeKey(value.scopeKey)) {
		return undefined;
	}

	if (typeof value.servedHash !== "string" || value.servedHash.length === 0) {
		return undefined;
	}

	const mode = normalizeReadCacheMode(value.mode);
	if (!mode) {
		return undefined;
	}

	const requiresBaseHash = mode === "unchanged" || mode === "unchanged_range" || mode === "diff";
	if (requiresBaseHash) {
		if (typeof value.baseHash !== "string" || value.baseHash.length === 0) {
			return undefined;
		}
	} else if (value.baseHash !== undefined && (typeof value.baseHash !== "string" || value.baseHash.length === 0)) {
		return undefined;
	}

	if (
		!isPositiveInteger(value.totalLines) ||
		!isPositiveInteger(value.rangeStart) ||
		!isPositiveInteger(value.rangeEnd) ||
		value.rangeEnd < value.rangeStart ||
		!isNonNegativeInteger(value.bytes) ||
		(value.debug !== undefined && !isReadCacheDebugV1(value.debug))
	) {
		return undefined;
	}

	return {
		v: READCACHE_META_VERSION,
		pathKey: value.pathKey,
		scopeKey: value.scopeKey,
		servedHash: value.servedHash,
		...(typeof value.baseHash === "string" ? { baseHash: value.baseHash } : {}),
		mode,
		totalLines: value.totalLines,
		rangeStart: value.rangeStart,
		rangeEnd: value.rangeEnd,
		bytes: value.bytes,
		...(value.debug !== undefined ? { debug: value.debug } : {}),
	};
}

export function isReadCacheMetaV1(value: unknown): value is ReadCacheMetaV1 {
	return parseReadCacheMetaV1(value) !== undefined;
}

export function isReadCacheInvalidationV1(value: unknown): value is ReadCacheInvalidationV1 {
	if (!isRecord(value)) {
		return false;
	}

	return (
		value.v === READCACHE_META_VERSION &&
		value.kind === "invalidate" &&
		typeof value.pathKey === "string" &&
		value.pathKey.length > 0 &&
		isScopeKey(value.scopeKey) &&
		isPositiveInteger(value.at)
	);
}

export function buildReadCacheMetaV1(meta: Omit<ReadCacheMetaV1, "v">): ReadCacheMetaV1 {
	return {
		v: READCACHE_META_VERSION,
		...meta,
	};
}

export function buildInvalidationV1(pathKey: string, scopeKey: ScopeKey, at = Date.now()): ReadCacheInvalidationV1 {
	return {
		v: READCACHE_META_VERSION,
		kind: "invalidate",
		pathKey,
		scopeKey,
		at,
	};
}

export function extractReadMetaFromSessionEntry(entry: SessionEntry): ReadCacheMetaV1 | undefined {
	if (entry.type !== "message") {
		return undefined;
	}

	const message = entry.message;
	if (message.role !== "toolResult" || message.toolName !== "read") {
		return undefined;
	}

	if (!isRecord(message.details)) {
		return undefined;
	}

	const candidate = message.details.readcache;
	return parseReadCacheMetaV1(candidate);
}

export function extractInvalidationFromSessionEntry(entry: SessionEntry): ReadCacheInvalidationV1 | undefined {
	if (entry.type !== "custom" || entry.customType !== READCACHE_CUSTOM_TYPE) {
		return undefined;
	}

	if (!isReadCacheInvalidationV1(entry.data)) {
		return undefined;
	}

	return entry.data;
}
