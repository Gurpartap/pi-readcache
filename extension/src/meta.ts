import type { SessionEntry } from "@mariozechner/pi-coding-agent";
import { READCACHE_CUSTOM_TYPE, READCACHE_META_VERSION, SCOPE_FULL } from "./constants.js";
import type { ReadCacheInvalidationV1, ReadCacheMetaV1, ReadCacheMode, ScopeKey } from "./types.js";

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

function isReadCacheMode(value: unknown): value is ReadCacheMode {
	return (
		value === "full" ||
		value === "unchanged" ||
		value === "unchanged_range" ||
		value === "diff" ||
		value === "full_fallback"
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

export function isReadCacheMetaV1(value: unknown): value is ReadCacheMetaV1 {
	if (!isRecord(value)) {
		return false;
	}

	if (value.v !== READCACHE_META_VERSION) {
		return false;
	}

	if (typeof value.pathKey !== "string" || value.pathKey.length === 0) {
		return false;
	}

	if (!isScopeKey(value.scopeKey)) {
		return false;
	}

	if (typeof value.servedHash !== "string" || value.servedHash.length === 0) {
		return false;
	}

	if (!isReadCacheMode(value.mode)) {
		return false;
	}

	const requiresBaseHash = value.mode === "unchanged" || value.mode === "unchanged_range" || value.mode === "diff";
	if (requiresBaseHash) {
		if (typeof value.baseHash !== "string" || value.baseHash.length === 0) {
			return false;
		}
	} else if (value.baseHash !== undefined && (typeof value.baseHash !== "string" || value.baseHash.length === 0)) {
		return false;
	}

	return (
		isPositiveInteger(value.totalLines) &&
		isPositiveInteger(value.rangeStart) &&
		isPositiveInteger(value.rangeEnd) &&
		value.rangeEnd >= value.rangeStart &&
		isNonNegativeInteger(value.bytes)
	);
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
	if (!isReadCacheMetaV1(candidate)) {
		return undefined;
	}

	return candidate;
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
