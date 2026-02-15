export const READCACHE_META_VERSION = 1 as const;
export const READCACHE_CUSTOM_TYPE = "pi-readcache" as const;

export const SCOPE_FULL = "full" as const;

export const MAX_DIFF_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_DIFF_FILE_LINES = 12_000;
export const MAX_DIFF_TO_BASE_RATIO = 1.0;

export const DEFAULT_EXCLUDED_PATH_PATTERNS = [".env*", "*.pem", "*.key", "*.p12"] as const;

export const READCACHE_ROOT_DIR = ".pi/readcache";
export const READCACHE_OBJECTS_DIR = `${READCACHE_ROOT_DIR}/objects`;
export const READCACHE_TMP_DIR = `${READCACHE_ROOT_DIR}/tmp`;

export function scopeRange(start: number, end: number): `r:${number}:${number}` {
	return `r:${start}:${end}`;
}
