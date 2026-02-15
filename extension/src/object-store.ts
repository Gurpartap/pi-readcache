import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, open, readdir, readFile, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { READCACHE_OBJECTS_DIR, READCACHE_TMP_DIR } from "./constants.js";

const HASH_HEX_RE = /^[a-f0-9]{64}$/;

export interface ObjectStorePaths {
	objectsDir: string;
	tmpDir: string;
}

export interface PersistObjectResult {
	hash: string;
	path: string;
	written: boolean;
}

export interface ObjectStoreStats {
	objects: number;
	bytes: number;
}

function ensureValidHash(hash: string): void {
	if (!HASH_HEX_RE.test(hash)) {
		throw new Error(`Invalid sha256 hash "${hash}".`);
	}
}

export function hashBytes(buffer: Buffer): string {
	return createHash("sha256").update(buffer).digest("hex");
}

export function hashText(text: string): string {
	return hashBytes(Buffer.from(text, "utf-8"));
}

export function getStorePaths(repoRoot: string): ObjectStorePaths {
	return {
		objectsDir: join(repoRoot, READCACHE_OBJECTS_DIR),
		tmpDir: join(repoRoot, READCACHE_TMP_DIR),
	};
}

export function objectPathForHash(repoRoot: string, hash: string): string {
	ensureValidHash(hash);
	const { objectsDir } = getStorePaths(repoRoot);
	return join(objectsDir, `sha256-${hash}.txt`);
}

export async function ensureStoreDirs(repoRoot: string): Promise<ObjectStorePaths> {
	const paths = getStorePaths(repoRoot);
	await mkdir(paths.objectsDir, { recursive: true, mode: 0o700 });
	await mkdir(paths.tmpDir, { recursive: true, mode: 0o700 });
	return paths;
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

export async function persistObjectIfAbsent(repoRoot: string, hash: string, text: string): Promise<PersistObjectResult> {
	ensureValidHash(hash);
	const { tmpDir } = await ensureStoreDirs(repoRoot);
	const objectPath = objectPathForHash(repoRoot, hash);

	if (await exists(objectPath)) {
		return { hash, path: objectPath, written: false };
	}

	const tempPath = join(tmpDir, `sha256-${hash}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`);
	let tempFileCreated = false;

	try {
		const handle = await open(tempPath, "wx", 0o600);
		tempFileCreated = true;
		try {
			await handle.writeFile(text, "utf-8");
			await handle.sync();
		} finally {
			await handle.close();
		}

		await rename(tempPath, objectPath);
		return { hash, path: objectPath, written: true };
	} catch (error) {
		const errorCode = (error as NodeJS.ErrnoException).code;
		if (errorCode === "EEXIST") {
			if (tempFileCreated && (await exists(tempPath))) {
				await unlink(tempPath);
			}
			return { hash, path: objectPath, written: false };
		}

		if (tempFileCreated && (await exists(tempPath))) {
			await unlink(tempPath);
		}
		throw error;
	}
}

export async function loadObject(repoRoot: string, hash: string): Promise<string | undefined> {
	ensureValidHash(hash);
	const objectPath = objectPathForHash(repoRoot, hash);
	try {
		return await readFile(objectPath, "utf-8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return undefined;
		}
		throw error;
	}
}

export async function getStoreStats(repoRoot: string): Promise<ObjectStoreStats> {
	const { objectsDir } = await ensureStoreDirs(repoRoot);
	const entries = await readdir(objectsDir, { withFileTypes: true });

	let objects = 0;
	let bytes = 0;

	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.startsWith("sha256-") || !entry.name.endsWith(".txt")) {
			continue;
		}
		objects += 1;
		const info = await stat(join(objectsDir, entry.name));
		bytes += info.size;
	}

	return { objects, bytes };
}
