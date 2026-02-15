import type { ExtensionContext, SessionEntry } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { SCOPE_FULL } from "../../src/constants.js";
import { buildInvalidationV1, buildReadCacheMetaV1 } from "../../src/meta.js";
import {
	applyInvalidation,
	applyReadMeta,
	buildKnowledgeForLeaf,
	createReplayRuntimeState,
	findReplayStartIndex,
	overlaySet,
	replayKnowledgeFromBranch,
} from "../../src/replay.js";
import type { ScopeKey } from "../../src/types.js";

type SessionManagerView = ExtensionContext["sessionManager"];

function createReadEntry(
	id: string,
	parentId: string | null,
	pathKey: string,
	scopeKey: ScopeKey,
	servedHash: string,
): SessionEntry {
	const meta = buildReadCacheMetaV1({
		pathKey,
		scopeKey,
		servedHash,
		mode: "full",
		totalLines: 10,
		rangeStart: 1,
		rangeEnd: 10,
		bytes: 100,
	});

	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date().toISOString(),
		message: {
			role: "toolResult",
			toolCallId: `tool-${id}`,
			toolName: "read",
			content: [{ type: "text", text: "ok" }],
			details: { readcache: meta },
			isError: false,
			timestamp: Date.now(),
		},
	};
}

function createInvalidationEntry(id: string, parentId: string | null, pathKey: string, scopeKey: ScopeKey): SessionEntry {
	return {
		type: "custom",
		id,
		parentId,
		timestamp: new Date().toISOString(),
		customType: "pi-readcache",
		data: buildInvalidationV1(pathKey, scopeKey, Date.now()),
	};
}

function createCompactionEntry(id: string, parentId: string | null, firstKeptEntryId: string): SessionEntry {
	return {
		type: "compaction",
		id,
		parentId,
		timestamp: new Date().toISOString(),
		summary: "compacted",
		firstKeptEntryId,
		tokensBefore: 100,
	};
}

function createSessionManagerStub(state: {
	sessionId: string;
	leafId: string | null;
	branch: SessionEntry[];
}): SessionManagerView {
	return {
		getCwd: () => "/tmp",
		getSessionDir: () => "/tmp",
		getSessionId: () => state.sessionId,
		getSessionFile: () => undefined,
		getLeafId: () => state.leafId,
		getLeafEntry: () =>
			state.leafId ? state.branch.find((entry) => entry.id === state.leafId) : undefined,
		getEntry: (id: string) => state.branch.find((entry) => entry.id === id),
		getLabel: () => undefined,
		getBranch: () => state.branch,
		getHeader: () => null,
		getEntries: () => state.branch,
		getTree: () => [],
		getSessionName: () => undefined,
	};
}

describe("replay", () => {
	it("finds replay start from latest compaction and firstKeptEntryId", () => {
		const path = "/tmp/file.txt";
		const entries: SessionEntry[] = [
			createReadEntry("e1", null, path, SCOPE_FULL, "a".repeat(64)),
			createReadEntry("e2", "e1", path, SCOPE_FULL, "b".repeat(64)),
			createCompactionEntry("e3", "e2", "e2"),
			createReadEntry("e4", "e3", path, SCOPE_FULL, "c".repeat(64)),
		];

		const boundary = findReplayStartIndex(entries);
		expect(boundary.startIndex).toBe(1);
		expect(boundary.boundaryKey).toBe("kept:e2");
	});

	it("falls back to compaction+1 when firstKeptEntryId is missing", () => {
		const path = "/tmp/file.txt";
		const entries: SessionEntry[] = [
			createReadEntry("e1", null, path, SCOPE_FULL, "a".repeat(64)),
			createCompactionEntry("e2", "e1", "missing"),
			createReadEntry("e3", "e2", path, SCOPE_FULL, "b".repeat(64)),
		];

		const boundary = findReplayStartIndex(entries);
		expect(boundary.startIndex).toBe(2);
		expect(boundary.boundaryKey).toBe("compaction:e2");
	});

	it("replays read metadata and applies invalidations safely", () => {
		const path = "/tmp/file.txt";
		const entries: SessionEntry[] = [
			createReadEntry("e1", null, path, SCOPE_FULL, "a".repeat(64)),
			createReadEntry("e2", "e1", path, "r:2:4", "b".repeat(64)),
			createInvalidationEntry("e3", "e2", path, "r:2:4"),
			{
				type: "message",
				id: "e4",
				parentId: "e3",
				timestamp: new Date().toISOString(),
				message: {
					role: "toolResult",
					toolCallId: "tool-e4",
					toolName: "read",
					content: [{ type: "text", text: "ignored" }],
					details: { readcache: { broken: true } },
					isError: false,
					timestamp: Date.now(),
				},
			},
		];

		const knowledge = replayKnowledgeFromBranch(entries, 0);
		expect(knowledge.get(path)?.get(SCOPE_FULL)).toBe("a".repeat(64));
		expect(knowledge.get(path)?.get("r:2:4")).toBeUndefined();
	});

	it("full-scope invalidation clears all range scopes for a path", () => {
		const path = "/tmp/file.txt";
		const knowledge = new Map<string, Map<ScopeKey, string>>();

		applyReadMeta(
			knowledge,
			buildReadCacheMetaV1({
				pathKey: path,
				scopeKey: SCOPE_FULL,
				servedHash: "a".repeat(64),
				mode: "full",
				totalLines: 10,
				rangeStart: 1,
				rangeEnd: 10,
				bytes: 100,
			}),
		);
		applyReadMeta(
			knowledge,
			buildReadCacheMetaV1({
				pathKey: path,
				scopeKey: "r:2:4",
				servedHash: "b".repeat(64),
				mode: "full",
				totalLines: 10,
				rangeStart: 2,
				rangeEnd: 4,
				bytes: 100,
			}),
		);

		applyInvalidation(knowledge, buildInvalidationV1(path, SCOPE_FULL, Date.now()));
		expect(knowledge.has(path)).toBe(false);
	});

	it("merges overlay with replay knowledge and clears overlay after leaf changes", () => {
		const path = "/tmp/file.txt";
		const runtime = createReplayRuntimeState();
		const state: { sessionId: string; leafId: string | null; branch: SessionEntry[] } = {
			sessionId: "session-1",
			leafId: "e1",
			branch: [createReadEntry("e1", null, path, SCOPE_FULL, "a".repeat(64))],
		};
		const sessionManager = createSessionManagerStub(state);

		expect(buildKnowledgeForLeaf(sessionManager, runtime).get(path)?.get(SCOPE_FULL)).toBe("a".repeat(64));

		overlaySet(runtime, sessionManager, path, SCOPE_FULL, "b".repeat(64));
		expect(buildKnowledgeForLeaf(sessionManager, runtime).get(path)?.get(SCOPE_FULL)).toBe("b".repeat(64));

		state.leafId = null;
		state.branch = [];
		expect(buildKnowledgeForLeaf(sessionManager, runtime).size).toBe(0);
	});
});
