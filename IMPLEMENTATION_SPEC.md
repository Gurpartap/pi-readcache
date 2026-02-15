# pi-readcache — Canonical Implementation Specification

This document defines the end-to-end implementation of `pi-readcache` with correctness-first behavior for pi session trees (`/tree`, compaction, fork, resume, switch), selective reads, and concurrent sessions.

It is intentionally strict: if correctness is uncertain, serve normal full read output.

---

## 1) Scope and objective

`pi-readcache` is a pi extension that overrides the built-in `read` tool while preserving compatibility.

Required behavior:
- First read of a file/scope in current active context -> full output (baseline read behavior)
- Subsequent read of same file/scope and same content -> compact unchanged marker
- Subsequent read with changed content -> compact diff for full-file scope, safe fallback for range scope
- Fully correct across:
  - `/tree` navigation to arbitrary points
  - compaction boundaries
  - `/fork`, `/resume`, session switches
  - restart/resume

Non-goal:
- It is not a transport/protocol cache. It is context-aware read-state optimization.

---

## 2) Hard correctness invariants (non-negotiable)

1. Tool contract compatibility:
   - Tool name remains `read`
   - Input schema remains `{ path: string; offset?: number; limit?: number }`
   - Output shape remains read-compatible (`content`, optional `details.truncation`)

2. Context-safety rule:
   - Never emit `unchanged`/`diff` unless a valid base hash is provably present in current active branch context for the requested scope.

3. Uncertainty rule:
   - On ambiguity or failure (missing base, parse error, store error, diff failure), return baseline full read output.

4. Branch correctness rule:
   - Canonical read-state must be derived from current branch history, not from a mutable global pointer table.

5. Scope correctness rule:
   - Read-state is scope-aware:
     - `full`
     - `range(start,end)`

6. Persistence safety rule:
   - Any shared file write must be atomic.

---

## 3) Canonical architecture

### 3.1 Canonical truth

Canonical knowledge = replay of `read` tool metadata from session entries on current active branch path.

Use `ctx.sessionManager.getBranch()` as source, filtered by context boundary rules (Section 7).

### 3.2 Supporting store

External object store for content snapshots by hash:

```text
<repo>/.pi/readcache/
  objects/
    sha256-<64hex>.txt
  tmp/
```

This store is **supporting data** for diffing. It is not canonical context truth.

### 3.3 Optional performance cache

In-memory memoization keyed by `(sessionId, leafId)` + in-flight overlay.

Performance cache is disposable. Never trust it as source of truth.

---

## 4) Tool metadata contract (embedded in tool result details)

Add a compact namespace under tool result `details`:

```ts
interface ReadCacheMetaV1 {
  v: 1;
  pathKey: string;        // canonical absolute (or canonical realpath fallback)
  scopeKey: string;       // "full" | `r:${start}:${end}`
  servedHash: string;     // hash of current content served against
  baseHash?: string;      // hash used as comparison base (if any)
  mode: "full" | "unchanged" | "unchanged_range" | "diff" | "full_fallback";
  totalLines: number;
  rangeStart: number;
  rangeEnd: number;
  bytes: number;
}

interface ReadToolDetailsExt {
  truncation?: unknown;      // preserve built-in shape
  readcache?: ReadCacheMetaV1;
}
```

Rules:
- Keep metadata tiny and deterministic.
- Do not store large payloads in metadata.
- Do not rely on any metadata except `details.readcache.v === 1` with valid fields.

Persistent invalidation entry schema (for explicit refresh):

```ts
interface ReadCacheInvalidationV1 {
  v: 1;
  kind: "invalidate";
  pathKey: string;
  scopeKey: string; // "full" | `r:${start}:${end}`
  at: number;
}
```

Store this via `appendCustomEntry("pi-readcache", { ... })` when refresh is requested.
These invalidation entries are replayed with branch history and become canonical for that branch.

---

## 5) Path and range normalization

### 5.1 Path normalization parity

Path behavior must match built-in `read` semantics in pi:
- strip leading `@`
- expand `~` / `~/...`
- normalize unicode spaces as in built-in path utils
- support macOS screenshot variants (AM/PM narrow space, NFD, curly quote variants)
- resolve relative paths against `ctx.cwd`

Implement this in `path.ts` mirroring pi behavior.

### 5.2 `path:start-end` parsing

The model may emit range shorthand in `path`.

Parse rules:
1. If `offset` or `limit` explicitly present, do not parse suffix.
2. Try resolve raw path as-is. If it exists, keep as path (no suffix parse).
3. Else parse trailing `:<n>` or `:<n>-<m>`.
4. Resolve candidate path before suffix. Parse only if candidate exists.
5. If both forms are ambiguous, prefer raw path-as-file.

Validation:
- line numbers must be positive integers
- if end < start -> reject with clear error
- `offset` beyond EOF -> match built-in read error semantics

Range canonicalization:
- `start = offset ?? 1`
- `end = limit ? start + limit - 1 : totalLines`
- clamp `end` to `totalLines`
- `scopeKey = full` when range spans entire file exactly, else `r:start:end`

---

## 6) Text eligibility and fallback policy

Optimization applies only to normal text files.

Always delegate to baseline read when:
- image/supported binary type
- UTF-8 strict decode fails
- file too large for safe diff path (configurable thresholds)
- signal aborted
- any internal failure

Baseline read is created from pi SDK factory and remains behavior-compatible.

---

## 7) Branch replay and context boundary rules

Given current branch entries (root -> leaf):

```ts
const branch = ctx.sessionManager.getBranch();
```

Build active read knowledge map by replaying `readcache` metadata in branch entries, starting from a context-safe boundary.

### 7.1 Boundary selection

Find latest `compaction` entry on path.

If none:
- replay from root

If found:
- preferred start = index of `firstKeptEntryId` referenced by that compaction (if present on path)
- fallback start = index(compaction) + 1

Rationale:
- only states represented in active context are trusted
- this avoids using pre-compaction state that is no longer in context

### 7.2 Replay rule

For each entry in replay window, process in timestamp/path order:

1. Read tool results:
- if entry type `message`
- and `message.role === "toolResult"`
- and `message.toolName === "read"`
- and `message.details.readcache.v === 1`

Then set:
- `knowledge[pathKey][scopeKey] = servedHash`

2. Explicit invalidations:
- if entry type `custom`
- and `customType === "pi-readcache"`
- and `data.v === 1`
- and `data.kind === "invalidate"`

Then remove matching scope knowledge:
- delete `knowledge[pathKey][scopeKey]`
- if `scopeKey === "full"`, also delete all range scopes for `pathKey`

Later entries overwrite earlier ones naturally.

### 7.3 In-flight overlay

Because tool result persistence timing may lag within the same agent turn, maintain in-memory overlay:
- after successful read execution, overlay latest `(pathKey, scopeKey) -> servedHash`
- when computing knowledge, merge `replayKnowledge + overlay`
- invalidate overlay when leaf changes (or on session/tree/compact events)

---

## 8) Read decision algorithm (authoritative)

Inputs: normalized `path`, `offset?`, `limit?`

1. Resolve canonical path (`pathKey`).
2. Load current file bytes and strict UTF-8 text.
3. Compute:
   - `currentHash = sha256(bytes)`
   - `totalLines`
   - normalized range `(start,end)`
   - `scopeKey`
4. Build active knowledge map for current leaf (Section 7).
5. Determine `baseHash`:
   - exact scope first: `knowledge[pathKey][scopeKey]`
   - for range scope, fallback to `knowledge[pathKey]["full"]`
6. If no `baseHash`:
   - return baseline full/sliced output
   - set `mode = full`
7. If `baseHash === currentHash`:
   - return unchanged marker (full or range form)
   - set `mode = unchanged` / `unchanged_range`
8. Else (`baseHash !== currentHash`):
   - load `baseContent` from object store by `baseHash`
   - if missing: return baseline output, `mode = full_fallback`
   - if range scope:
     - compare exact numeric slices from base and current (`oldSlice`, `newSlice`)
     - if equal: unchanged_range marker
     - else: return baseline output for that range (safe default)
   - if full scope:
     - compute unified diff base->current
     - if diff is useful and under limits: return diff payload (`mode = diff`)
     - else: baseline output (`mode = full_fallback`)
9. Persist current content in object store if absent.
10. Include `details.readcache` metadata in returned tool result.
11. Update in-flight overlay with `(pathKey, scopeKey) -> currentHash`.

Important: step 8 range path uses slice equality; do not rely only on hunk overlap.

---

## 9) Output formats

### 9.1 Unchanged markers

Full:
- `[readcache: unchanged, <totalLines> lines]`

Range:
- `[readcache: unchanged in lines <start>-<end> of <totalLines>]`

Range unchanged with file changed elsewhere:
- `[readcache: unchanged in lines <start>-<end>; changes exist outside this range]`

### 9.2 Diff output (full scope only, default)

Prefix:
- `[readcache: <n> lines changed of <totalLines>]`

Body:
- unified diff (`--- a/...`, `+++ b/...`, hunks)

### 9.3 Truncation

Apply built-in truncation semantics to custom-generated text.
If truncation reduces usefulness materially, fallback to baseline output.

---

## 10) Object store specification

### 10.1 File naming

`objects/sha256-<64hex>.txt`

### 10.2 Write protocol

1. If object exists -> no-op
2. Else write to unique temp file in `tmp/`
3. fsync (optional but recommended where available)
4. atomic rename temp -> object path
5. if rename collision (already created by another process), discard temp and continue

### 10.3 Read protocol

- read by hash path
- missing file returns undefined

### 10.4 Concurrency

No global lock required for object writes when using atomic create/rename pattern.

---

## 11) Concurrency model for multiple pi sessions

### 11.1 Canonical state isolation

State is session-tree-derived, so separate sessions are naturally isolated.
No shared mutable session pointer table.

### 11.2 Shared resources

Only shared resource is object store blobs; writes are idempotent by hash.

### 11.3 Status metrics

Prefer deriving metrics from branch replay to avoid global mutable counters.
If global counters are added later, protect them with lock + atomic update.

---

## 12) Session-tree event handling

Correctness does not depend on events, only on replay.

Use events only for cache invalidation:
- `session_compact`
- `session_tree`
- `session_fork`
- `session_switch`

On these events:
- clear memoized replay state + in-flight overlay

Do not mutate canonical state in event handlers.

---

## 13) Resume and long idle behavior

On restart/resume:
- rebuild knowledge from current branch replay
- continue normally

No time-based invalidation required for correctness.

Provider-side cache retention or expiry does not change readcache correctness decisions.

---

## 14) Failure handling

| Failure | Behavior |
|---|---|
| path invalid/unreadable | Return read error consistent with baseline semantics |
| malformed range | clear validation error |
| strict UTF-8 decode fail | delegate baseline read |
| object store write fail | continue current response; skip optimization metadata if needed |
| object load for base hash fails | baseline full/slice fallback |
| diff generation fails | baseline fallback |
| signal aborted | abort cleanly; no partial mutation assumptions |
| metadata parse failure in replay | ignore that entry, continue replay |

Golden rule: fail-open to baseline read behavior.

---

## 15) Security and privacy requirements

1. Store directory permissions should be user-only where possible.
2. Add configurable excludes for sensitive files (recommended defaults):
   - `.env*`, `*.pem`, `*.key`, `*.p12`
3. Excluded paths bypass readcache optimization and use baseline read.
4. Do not emit sensitive path internals in marker text beyond requested path context.

---

## 16) Performance design

### 16.1 Replay memoization

Cache replay result per `(sessionId, leafId, compactionBoundaryId)` in memory.

### 16.2 Incremental overlay

Overlay current-turn updates to avoid missing immediate prior reads before persistence.

### 16.3 Diff bounds

Set conservative thresholds:
- skip diff when file bytes exceed threshold (e.g. 2 MiB)
- skip diff when line count exceeds threshold (e.g. 12k)
- skip diff if diff bytes >= selected bytes

### 16.4 Range path simplification

Default range-changed behavior: baseline full range output.
This is safer and cheaper than complex range diffing.

---

## 17) Slash commands

### `/readcache-status`

Report for current active branch context:
- tracked files/scopes in reconstructed knowledge
- counts by mode from replay window (`full`, `unchanged`, `unchanged_range`, `diff`, `full_fallback`)
- approximate token savings for current branch window
- object store stats (file count, bytes) best-effort

### `/readcache-refresh <path> [start-end]`

Force next read to return baseline full/slice for a specific scope.

Behavior:
1. Normalize input to `(pathKey, scopeKey)`.
2. Append persistent invalidation entry:
   - `appendCustomEntry("pi-readcache", { v: 1, kind: "invalidate", pathKey, scopeKey, at: Date.now() })`
3. Clear in-memory memo/overlay for current session process.

Properties:
- branch-aware: invalidation applies on the current branch path from that point onward
- durable across restart/resume (because it is in session history)
- does not delete object blobs

### `readcache_refresh` tool (model-callable, optional but recommended)

Register a small model-callable tool that performs the same persistent invalidation semantics as `/readcache-refresh`.

Parameters:
- `path: string`
- `offset?: number`
- `limit?: number`

Use this when the model explicitly needs a fresh baseline for a file/scope.

---

## 18) Compatibility constraints with pi UI/renderer

- Preserve `details.truncation` semantics where applicable.
- Keep `content` as text blocks expected by built-in renderer.
- Keep tool name `read` and argument schema unchanged.
- Never require prompt changes for model to use it.

---

## 19) Implementation modules

```text
extension/
  index.ts                  // register tool + commands + invalidation hooks
  src/
    tool.ts                 // execute algorithm
    replay.ts               // branch replay and knowledge map
    path.ts                 // path/range normalization parity
    text.ts                 // slicing, truncation helpers
    diff.ts                 // full-file diff generation
    object-store.ts         // hash object store IO
    meta.ts                 // metadata schema parse/encode
    types.ts
```

---

## 20) Pseudocode

```ts
executeRead(params, ctx, signal): ToolResult {
  baseline = getBaselineReadTool(ctx.cwd)

  norm = normalizePathAndRange(params, ctx.cwd)
  if (norm.error) return baseline.execute(...)

  file = readCurrentTextStrict(norm.path)
  if (!file.isText) return baseline.execute(...)

  currentHash = sha256(file.bytes)
  scopeKey = makeScopeKey(norm.start, norm.end, file.totalLines)

  knowledge = getKnowledgeForCurrentLeaf(ctx.sessionManager) // replay + overlay
  baseHash = knowledge.get(norm.pathKey, scopeKey) ?? (scopeKey !== "full" ? knowledge.get(norm.pathKey, "full") : undefined)

  if (!baseHash) {
    out = baseline.execute(...normalizedOffsetLimit...)
    persistObjectIfAbsent(currentHash, file.text)
    attachReadcacheMeta(out, mode="full", servedHash=currentHash)
    overlaySet(pathKey, scopeKey, currentHash)
    return out
  }

  if (baseHash === currentHash) {
    out = unchangedMarkerResult(...)
    attachReadcacheMeta(out, mode=(scopeKey==="full"?"unchanged":"unchanged_range"), servedHash=currentHash, baseHash)
    overlaySet(pathKey, scopeKey, currentHash)
    return out
  }

  baseText = loadObject(baseHash)
  if (!baseText) {
    out = baseline.execute(...)
    persistObjectIfAbsent(currentHash, file.text)
    attachReadcacheMeta(out, mode="full_fallback", servedHash=currentHash, baseHash)
    overlaySet(pathKey, scopeKey, currentHash)
    return out
  }

  if (scopeKey !== "full") {
    if (slice(baseText, start,end) === slice(file.text,start,end)) {
      out = unchangedRangeElsewhereChangedMarker(...)
      attachReadcacheMeta(out, mode="unchanged_range", servedHash=currentHash, baseHash)
      overlaySet(pathKey, scopeKey, currentHash)
      persistObjectIfAbsent(currentHash, file.text)
      return out
    }

    out = baseline.execute(...) // safe range-changed fallback
    attachReadcacheMeta(out, mode="full_fallback", servedHash=currentHash, baseHash)
    overlaySet(pathKey, scopeKey, currentHash)
    persistObjectIfAbsent(currentHash, file.text)
    return out
  }

  diff = computeUnifiedDiff(baseText, file.text)
  if (!diff.useful) {
    out = baseline.execute(...)
    attachReadcacheMeta(out, mode="full_fallback", servedHash=currentHash, baseHash)
  } else {
    out = diffResult(diff)
    attachReadcacheMeta(out, mode="diff", servedHash=currentHash, baseHash)
  }

  persistObjectIfAbsent(currentHash, file.text)
  overlaySet(pathKey, scopeKey, currentHash)
  return out
}
```

---

## 21) Test matrix (must pass before release)

### 21.1 Core behavior
1. first full read
2. unchanged full read marker
3. changed full read diff
4. changed full read fallback when diff not useful

### 21.2 Range behavior
5. first range read full slice
6. unchanged same range marker
7. file changed outside range -> unchanged_range marker
8. file changed affecting range -> full range fallback
9. insertion before range causing shift -> treated as range changed
10. malformed range rejected

### 21.3 Tree/branch behavior
11. read on branch A then `/tree` to branch B -> no stale base leakage
12. `/tree` to pre-compaction point -> replay uses historical state correctly
13. latest compaction on path -> replay starts at boundary logic
14. `/fork` then read -> independent branch replay state
15. session switch/resume -> correct replay with no sidecar dependence

### 21.4 Robustness
16. missing base object hash -> fallback full, no crash
17. object write collision under concurrency -> no corruption
18. metadata missing/invalid in old entries -> ignored safely
19. signal abort during diff -> clean abort
20. image/binary reads delegated to baseline

### 21.5 Compatibility
21. UI truncation indicators still work
22. output shape accepted by built-in renderer
23. no requirement to change system prompt/tool instructions

### 21.6 Refresh/invalidation behavior
24. `/readcache-refresh` appends `custom` invalidation entry and next read is baseline full/slice
25. `readcache_refresh` tool (if enabled) has same semantics as command
26. after restart/resume, invalidation still applies on branch replay
27. invalidating `full` scope also invalidates all range scopes for that path

---

## 22) Deployment strategy

1. Implement minimal correctness path first:
   - replay
   - full/unchanged
   - range unchanged detection by slice equality
   - object store
2. Add full-file diff mode.
3. Add status command.
4. Add exclusions and optional tuning.
5. Run full matrix and real-session shadow testing.

Release gate:
- zero correctness failures in tree/compaction/range matrix.

---

## 23) What is intentionally avoided

- Global mutable per-file/session pointer DB as canonical truth
- Event-driven state mutation for correctness
- Complex range diff semantics in MVP
- Time-based invalidation heuristics

These are intentionally avoided to prevent corner-case drift.

---

## 24) Summary

The correct implementation pattern is:

1. **Derive active read knowledge from current branch history**
2. **Use hash-addressed object store for diff bases**
3. **Fall back to baseline read whenever uncertain**

This aligns with pi’s tree model, survives compaction and navigation, and avoids architectural dead-ends.
