import type { SessionEntry } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { SCOPE_FULL } from "../../src/constants.js";
import {
	buildInvalidationV1,
	buildReadCacheMetaV1,
	extractInvalidationFromSessionEntry,
	extractReadMetaFromSessionEntry,
	isReadCacheInvalidationV1,
	isReadCacheMetaV1,
} from "../../src/meta.js";

describe("meta", () => {
	it("validates readcache metadata", () => {
		const meta = buildReadCacheMetaV1({
			pathKey: "/tmp/file.txt",
			scopeKey: SCOPE_FULL,
			servedHash: "abc",
			mode: "full",
			totalLines: 42,
			rangeStart: 1,
			rangeEnd: 42,
			bytes: 512,
		});

		expect(isReadCacheMetaV1(meta)).toBe(true);
		expect(isReadCacheMetaV1({ ...meta, totalLines: 0 })).toBe(false);
		expect(isReadCacheMetaV1({ ...meta, scopeKey: "r:9:2" })).toBe(false);
	});

	it("validates invalidation payloads", () => {
		const payload = buildInvalidationV1("/tmp/file.txt", "r:10:20", 1234);
		expect(isReadCacheInvalidationV1(payload)).toBe(true);
		expect(isReadCacheInvalidationV1({ ...payload, kind: "other" })).toBe(false);
	});

	it("extracts read metadata from session entries safely", () => {
		const meta = buildReadCacheMetaV1({
			pathKey: "/tmp/file.txt",
			scopeKey: SCOPE_FULL,
			servedHash: "abc",
			mode: "full",
			totalLines: 2,
			rangeStart: 1,
			rangeEnd: 2,
			bytes: 12,
		});

		const validEntry: SessionEntry = {
			type: "message",
			id: "1",
			parentId: null,
			timestamp: new Date().toISOString(),
			message: {
				role: "toolResult",
				toolCallId: "tool-1",
				toolName: "read",
				content: [{ type: "text", text: "ok" }],
				details: { readcache: meta },
				isError: false,
				timestamp: Date.now(),
			},
		};

		const invalidEntry: SessionEntry = {
			type: "message",
			id: "2",
			parentId: "1",
			timestamp: new Date().toISOString(),
			message: {
				role: "toolResult",
				toolCallId: "tool-2",
				toolName: "read",
				content: [{ type: "text", text: "bad" }],
				details: { readcache: { broken: true } },
				isError: false,
				timestamp: Date.now(),
			},
		};

		expect(extractReadMetaFromSessionEntry(validEntry)).toEqual(meta);
		expect(extractReadMetaFromSessionEntry(invalidEntry)).toBeUndefined();
	});

	it("extracts invalidation entries from custom entries", () => {
		const payload = buildInvalidationV1("/tmp/file.txt", SCOPE_FULL, 1234);
		const entry: SessionEntry = {
			type: "custom",
			id: "3",
			parentId: "2",
			timestamp: new Date().toISOString(),
			customType: "pi-readcache",
			data: payload,
		};

		const ignored: SessionEntry = {
			type: "custom",
			id: "4",
			parentId: "2",
			timestamp: new Date().toISOString(),
			customType: "pi-readcache",
			data: { nope: true },
		};

		expect(extractInvalidationFromSessionEntry(entry)).toEqual(payload);
		expect(extractInvalidationFromSessionEntry(ignored)).toBeUndefined();
	});
});
