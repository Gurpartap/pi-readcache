import type { ExtensionContext, SessionEntry } from "@mariozechner/pi-coding-agent";
import { SCOPE_FULL } from "./constants.js";
import { extractInvalidationFromSessionEntry, extractReadMetaFromSessionEntry } from "./meta.js";
import type {
	KnowledgeMap,
	ReadCacheInvalidationV1,
	ReadCacheMetaV1,
	ScopeKey,
	ScopeTrust,
} from "./types.js";

type SessionManagerView = ExtensionContext["sessionManager"];

const OVERLAY_SEQ_START = 1_000_000_000;

interface OverlayState {
	leafId: string | null;
	knowledge: KnowledgeMap;
}

export interface ReplayRuntimeState {
	memoByLeaf: Map<string, KnowledgeMap>;
	overlayBySession: Map<string, OverlayState>;
	nextOverlaySeq: number;
}

export interface ReplayBoundary {
	startIndex: number;
	boundaryKey: string;
}

function cloneKnowledgeMap(source: KnowledgeMap): KnowledgeMap {
	const cloned: KnowledgeMap = new Map();
	for (const [pathKey, scopes] of source.entries()) {
		const clonedScopes = new Map<ScopeKey, ScopeTrust>();
		for (const [scopeKey, trust] of scopes.entries()) {
			clonedScopes.set(scopeKey, { ...trust });
		}
		cloned.set(pathKey, clonedScopes);
	}
	return cloned;
}

function getMemoKey(sessionId: string, leafId: string | null, boundaryKey: string): string {
	return `${sessionId}:${leafId ?? "null"}:${boundaryKey}`;
}

function ensureScopeMap(knowledge: KnowledgeMap, pathKey: string): Map<ScopeKey, ScopeTrust> {
	const existing = knowledge.get(pathKey);
	if (existing) {
		return existing;
	}
	const created = new Map<ScopeKey, ScopeTrust>();
	knowledge.set(pathKey, created);
	return created;
}

export function getTrust(knowledge: KnowledgeMap, pathKey: string, scopeKey: ScopeKey): ScopeTrust | undefined {
	return knowledge.get(pathKey)?.get(scopeKey);
}

export function setTrust(knowledge: KnowledgeMap, pathKey: string, scopeKey: ScopeKey, hash: string, seq: number): void {
	const scopes = ensureScopeMap(knowledge, pathKey);
	scopes.set(scopeKey, { hash, seq });
}

function mergeKnowledge(base: KnowledgeMap, overlay: KnowledgeMap): KnowledgeMap {
	const merged = cloneKnowledgeMap(base);
	for (const [pathKey, overlayScopes] of overlay.entries()) {
		const targetScopes = ensureScopeMap(merged, pathKey);
		for (const [scopeKey, trust] of overlayScopes.entries()) {
			targetScopes.set(scopeKey, { ...trust });
		}
	}
	return merged;
}

function ensureOverlayForLeaf(runtimeState: ReplayRuntimeState, sessionId: string, leafId: string | null): OverlayState {
	const existing = runtimeState.overlayBySession.get(sessionId);
	if (!existing || existing.leafId !== leafId) {
		const fresh: OverlayState = {
			leafId,
			knowledge: new Map(),
		};
		runtimeState.overlayBySession.set(sessionId, fresh);
		return fresh;
	}
	return existing;
}

function leafHasChildren(sessionManager: SessionManagerView, leafId: string | null): boolean {
	if (!leafId) {
		return false;
	}
	return sessionManager.getEntries().some((entry) => entry.parentId === leafId);
}

export function createReplayRuntimeState(): ReplayRuntimeState {
	return {
		memoByLeaf: new Map(),
		overlayBySession: new Map(),
		nextOverlaySeq: OVERLAY_SEQ_START,
	};
}

export function clearReplayRuntimeState(runtimeState: ReplayRuntimeState): void {
	runtimeState.memoByLeaf.clear();
	runtimeState.overlayBySession.clear();
	runtimeState.nextOverlaySeq = OVERLAY_SEQ_START;
}

export function findReplayStartIndex(branchEntries: SessionEntry[]): ReplayBoundary {
	for (let index = branchEntries.length - 1; index >= 0; index -= 1) {
		const entry = branchEntries[index];
		if (!entry || entry.type !== "compaction") {
			continue;
		}

		return {
			startIndex: Math.min(index + 1, branchEntries.length),
			boundaryKey: `compaction:${entry.id}`,
		};
	}

	return {
		startIndex: 0,
		boundaryKey: "root",
	};
}

export function applyReadMetaTransition(knowledge: KnowledgeMap, meta: ReadCacheMetaV1, seq: number): void {
	const { pathKey, scopeKey, servedHash, baseHash, mode } = meta;
	const fullTrust = getTrust(knowledge, pathKey, SCOPE_FULL);
	const rangeTrust = scopeKey === SCOPE_FULL ? undefined : getTrust(knowledge, pathKey, scopeKey);

	if (mode === "full" || mode === "full_fallback") {
		setTrust(knowledge, pathKey, scopeKey, servedHash, seq);
		return;
	}

	if (mode === "unchanged" && scopeKey === SCOPE_FULL) {
		if (!baseHash) {
			return;
		}
		if (!fullTrust || fullTrust.hash !== baseHash) {
			return;
		}
		if (servedHash !== baseHash) {
			return;
		}
		setTrust(knowledge, pathKey, SCOPE_FULL, servedHash, seq);
		return;
	}

	if (mode === "diff" && scopeKey === SCOPE_FULL) {
		if (!baseHash) {
			return;
		}
		if (!fullTrust || fullTrust.hash !== baseHash) {
			return;
		}
		setTrust(knowledge, pathKey, SCOPE_FULL, servedHash, seq);
		return;
	}

	if (mode === "unchanged_range" && scopeKey !== SCOPE_FULL) {
		if (!baseHash) {
			return;
		}
		if (rangeTrust?.hash !== baseHash && fullTrust?.hash !== baseHash) {
			return;
		}
		setTrust(knowledge, pathKey, scopeKey, servedHash, seq);
	}
}

export function applyInvalidation(knowledge: KnowledgeMap, invalidation: ReadCacheInvalidationV1): void {
	const scopes = knowledge.get(invalidation.pathKey);
	if (!scopes) {
		return;
	}

	if (invalidation.scopeKey === SCOPE_FULL) {
		knowledge.delete(invalidation.pathKey);
		return;
	}

	scopes.delete(invalidation.scopeKey);
	if (scopes.size === 0) {
		knowledge.delete(invalidation.pathKey);
	}
}

export function replayKnowledgeFromBranch(branchEntries: SessionEntry[], startIndex: number): KnowledgeMap {
	const knowledge: KnowledgeMap = new Map();
	const normalizedStart = Math.max(0, Math.min(startIndex, branchEntries.length));
	let seq = 0;

	for (let index = normalizedStart; index < branchEntries.length; index += 1) {
		const entry = branchEntries[index];
		if (!entry) {
			continue;
		}

		const meta = extractReadMetaFromSessionEntry(entry);
		if (meta) {
			seq += 1;
			applyReadMetaTransition(knowledge, meta, seq);
			continue;
		}

		const invalidation = extractInvalidationFromSessionEntry(entry);
		if (invalidation) {
			applyInvalidation(knowledge, invalidation);
		}
	}

	return knowledge;
}

export function buildKnowledgeForLeaf(
	sessionManager: SessionManagerView,
	runtimeState: ReplayRuntimeState,
): KnowledgeMap {
	const sessionId = sessionManager.getSessionId();
	const leafId = sessionManager.getLeafId();
	const branchEntries = sessionManager.getBranch();
	const boundary = findReplayStartIndex(branchEntries);
	const memoKey = getMemoKey(sessionId, leafId, boundary.boundaryKey);

	let replayKnowledge = runtimeState.memoByLeaf.get(memoKey);
	if (!replayKnowledge) {
		replayKnowledge = replayKnowledgeFromBranch(branchEntries, boundary.startIndex);
		runtimeState.memoByLeaf.set(memoKey, cloneKnowledgeMap(replayKnowledge));
	}

	const overlayState = ensureOverlayForLeaf(runtimeState, sessionId, leafId);
	if (leafHasChildren(sessionManager, leafId)) {
		overlayState.knowledge.clear();
	}
	return mergeKnowledge(replayKnowledge, overlayState.knowledge);
}

export function overlaySet(
	runtimeState: ReplayRuntimeState,
	sessionManager: SessionManagerView,
	pathKey: string,
	scopeKey: ScopeKey,
	servedHash: string,
): void {
	const sessionId = sessionManager.getSessionId();
	const leafId = sessionManager.getLeafId();
	const overlayState = ensureOverlayForLeaf(runtimeState, sessionId, leafId);
	const seq = runtimeState.nextOverlaySeq;
	runtimeState.nextOverlaySeq += 1;
	setTrust(overlayState.knowledge, pathKey, scopeKey, servedHash, seq);
}
