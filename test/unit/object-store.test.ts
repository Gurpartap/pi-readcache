import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	getStoreStats,
	hashText,
	loadObject,
	objectPathForHash,
	persistObjectIfAbsent,
} from "../../src/object-store.js";

describe("object-store", () => {
	it("persists and loads content by hash", async () => {
		const repoRoot = await mkdtemp(join(tmpdir(), "pi-readcache-store-"));
		const text = "hello object store";
		const hash = hashText(text);

		const persisted = await persistObjectIfAbsent(repoRoot, hash, text);
		expect(persisted.written).toBe(true);
		expect(persisted.path).toBe(objectPathForHash(repoRoot, hash));

		const loaded = await loadObject(repoRoot, hash);
		expect(loaded).toBe(text);

		const persistedAgain = await persistObjectIfAbsent(repoRoot, hash, text);
		expect(persistedAgain.written).toBe(false);
	});

	it("handles parallel writes of identical hashes safely", async () => {
		const repoRoot = await mkdtemp(join(tmpdir(), "pi-readcache-store-"));
		const text = "same text across concurrent writers";
		const hash = hashText(text);

		const writes = await Promise.all(
			Array.from({ length: 20 }, () => persistObjectIfAbsent(repoRoot, hash, text)),
		);

		expect(writes.some((result) => result.written)).toBe(true);
		expect(writes.every((result) => result.path === objectPathForHash(repoRoot, hash))).toBe(true);
		expect(await loadObject(repoRoot, hash)).toBe(text);
	});

	it("reports object store stats", async () => {
		const repoRoot = await mkdtemp(join(tmpdir(), "pi-readcache-store-"));
		const one = "alpha";
		const two = "beta";

		await persistObjectIfAbsent(repoRoot, hashText(one), one);
		await persistObjectIfAbsent(repoRoot, hashText(two), two);

		const stats = await getStoreStats(repoRoot);
		expect(stats.objects).toBe(2);
		expect(stats.bytes).toBeGreaterThan(0);
	});
});
