# pi-readcache — Detailed Implementation Plan

This plan is the execution blueprint for implementing `pi-readcache` from `IMPLEMENTATION_SPEC.md`.

Primary goal: deliver correctness under pi session tree branching, compaction, and selective reads with zero behavioral regressions for built-in `read` semantics.

---

## 0) Success criteria (release gate)

`pi-readcache` is ready only when all are true:

1. `read` override is drop-in compatible (same schema/behavior envelope).
2. Correct under `/tree`, `/fork`, `/resume`, compaction, and restart.
3. Selective-line logic is scope-correct (`full` + `r:start:end`).
4. Unknown/unsafe states fall back to baseline read.
5. No shared mutable pointer DB is used as canonical truth.
6. Test matrix in this plan passes in full.

---

## 1) Deliverables

1. Extension source package
2. Canonical architecture docs (already: `IMPLEMENTATION_SPEC.md`)
3. Test suite (unit + integration)
4. Manual QA checklist and reproducible scripts
5. Operational notes (limits, exclusions, troubleshooting)

---

## 2) Repository layout

Create this structure:

```text
pi-readcache/
  IMPLEMENTATION_SPEC.md
  IMPLEMENTATION_PLAN.md
  extension/
    package.json
    tsconfig.json
    index.ts
    src/
      constants.ts
      types.ts
      meta.ts
      path.ts
      text.ts
      object-store.ts
      replay.ts
      diff.ts
      tool.ts
      commands.ts
      telemetry.ts
    test/
      unit/
        path.test.ts
        replay.test.ts
        diff.test.ts
        meta.test.ts
        text.test.ts
      integration/
        tree-navigation.test.ts
        compaction-boundary.test.ts
        selective-range.test.ts
        refresh-invalidation.test.ts
        restart-resume.test.ts
```

---

## 3) Tooling and dependencies

## 3.1 package.json (extension)

Dependencies:
- `@mariozechner/pi-coding-agent`
- `@sinclair/typebox`

Optional (only if needed):
- small diff lib (if custom diff implementation is not used)

Scripts:
- `typecheck`
- `test`
- `lint` (optional)

## 3.2 TypeScript settings

- strict mode on
- no implicit any
- ESM compatible
- target current node runtime

---

## 4) Constants and versioning decisions

Create `src/constants.ts`:

- `READCACHE_META_VERSION = 1`
- `READCACHE_CUSTOM_TYPE = "pi-readcache"`
- scope keys:
  - `SCOPE_FULL = "full"`
  - `scopeRange(start,end) => "r:start:end"`
- limits:
  - `MAX_DIFF_FILE_BYTES` (e.g. 2 MiB)
  - `MAX_DIFF_FILE_LINES` (e.g. 12k)
  - `MAX_DIFF_TO_BASE_RATIO` (e.g. 1.0)
- object store paths:
  - `.pi/readcache/objects`
  - `.pi/readcache/tmp`

Versioning policy:
- keep metadata forward-compatible
- unknown `readcache.v` values ignored in replay

---

## 5) Module-by-module implementation

## 5.1 `types.ts`

Define strict interfaces:

- `ReadCacheMetaV1`
- `ReadCacheInvalidationV1`
- parsed replay event union:
  - `ReadKnowledgeEvent`
  - `ReadInvalidationEvent`
- `KnowledgeMap`:
  - `Map<pathKey, Map<scopeKey, servedHash>>`
- `NormalizedReadRequest`

Acceptance:
- zero `any`
- exhaustive discriminated unions

---

## 5.2 `meta.ts`

Functions:

- `isReadCacheMetaV1(x): x is ReadCacheMetaV1`
- `isReadCacheInvalidationV1(x): x is ReadCacheInvalidationV1`
- `buildReadCacheMetaV1(...)`
- `buildInvalidationV1(...)`

Replay extractors:
- `extractReadMetaFromSessionEntry(entry)`
- `extractInvalidationFromSessionEntry(entry)`

Acceptance:
- resilient to malformed historical entries
- invalid entries never throw in replay

---

## 5.3 `path.ts`

Implement exact path normalization parity with built-in read path behavior.

Functions:
- `normalizeInputPath(rawPath, cwd)`
- `parseTrailingRangeIfNeeded(rawPath, explicitOffset, explicitLimit, cwd)`
- `normalizeOffsetLimit(offset, limit, totalLines)`
- `scopeKeyForRange(start,end,totalLines)`

Critical behavior:
- preserve raw path if it exists as-is
- parse `:n` / `:n-m` only when safe
- do not break `:` in paths
- strict malformed range rejection

Acceptance:
- test coverage for all ambiguous path/range variants

---

## 5.4 `text.ts`

Functions:
- `splitLines(text)`
- `sliceByLineRange(text,start,end)`
- `compareSlices(oldText,newText,start,end)`
- `estimateTokens(text)` (for status only)
- truncation helpers for custom outputs using pi exports

Acceptance:
- consistent line indexing (1-based external, 0-based internal)

---

## 5.5 `object-store.ts`

Responsibilities:
- hash generation (`sha256` full hex)
- object path mapping
- atomic persist-if-absent
- read-by-hash

Functions:
- `hashBytes(buf): string`
- `ensureStoreDirs(repoRoot)`
- `persistObjectIfAbsent(hash,text)`
- `loadObject(hash)`
- `getStoreStats()`

Concurrency:
- temp file + rename
- handle collision race gracefully

Acceptance:
- no corruption under parallel writes

---

## 5.6 `diff.ts`

Functions:
- `computeUnifiedDiff(baseText,currentText,pathDisplay)`
- `isDiffUseful(diffText, selectedBaseText, selectedCurrentText, limits)`

Policy:
- only for `full` scope by default
- if diff unusable -> fallback full baseline

Acceptance:
- deterministic output
- bounded output

---

## 5.7 `replay.ts`

Core correctness engine.

Functions:
- `buildKnowledgeForLeaf(sessionManager, memoCache, overlay)`
- `findReplayStartIndex(branchEntries)`
- `applyReadMeta(knowledge, meta)`
- `applyInvalidation(knowledge, invalidation)`

Replay boundary algorithm:
1. get branch root->leaf
2. find latest compaction on path
3. start at:
   - index(firstKeptEntryId) if present
   - else compaction index + 1
   - else 0
4. replay read metadata and invalidations from start->leaf

Overlay merge:
- apply in-memory overlay after replay

Acceptance:
- no stale knowledge across leaf changes
- no dependence on global pointer tables

---

## 5.8 `telemetry.ts`

Optional lightweight metrics from replay window:
- counts by mode (`full`, `unchanged`, `unchanged_range`, `diff`, `full_fallback`)
- estimated savings for current active context window

Do not make correctness depend on telemetry.

---

## 5.9 `commands.ts`

Register:

1. `/readcache-status`
   - show active-context stats + object store stats

2. `/readcache-refresh <path> [start-end]`
   - normalize request
   - append invalidation entry via `pi.appendEntry(READCACHE_CUSTOM_TYPE, invalidation)`
   - clear memo/overlay for process

Optional model-callable tool:
- `readcache_refresh` with `{path, offset?, limit?}`
- same semantics as command

Acceptance:
- refresh persists across restart/resume via branch replay

---

## 5.10 `tool.ts`

Implements authoritative read decision flow.

Dependencies:
- baseline read tool from `createReadTool(cwd)`
- path normalization
- replay knowledge
- object store
- diff generator

Algorithm steps:
1. normalize input (path/range)
2. get current file bytes/text (or baseline fallback)
3. compute `currentHash`, range, scope
4. build knowledge for current leaf
5. resolve `baseHash` from exact scope else full scope fallback
6. no base -> baseline full/slice + meta mode `full`
7. same hash -> unchanged marker + mode `unchanged`/`unchanged_range`
8. changed:
   - missing base object -> baseline fallback
   - range scope:
     - compare exact slices
     - equal -> unchanged_range marker
     - different -> baseline fallback
   - full scope:
     - useful diff -> diff mode
     - else baseline fallback
9. persist current object if absent
10. attach readcache metadata
11. overlay update

Critical notes:
- baseline fallback must keep builtin semantics and truncation behavior
- if baseline produced special first-line-over-limit behavior, preserve it

Acceptance:
- every uncertain condition routes to baseline safely

---

## 5.11 `index.ts`

Extension entry point:
- initialize shared runtime state (memo cache + overlay)
- register overridden `read`
- register commands (and optional refresh tool)
- subscribe to events for cache invalidation only:
  - `session_compact`
  - `session_tree`
  - `session_fork`
  - `session_switch`
- on `session_shutdown`, clear in-memory caches

Acceptance:
- event handlers do not mutate canonical read state

---

## 6) Data flow diagrams (operational)

## 6.1 Normal read

`model -> read -> normalize -> replay knowledge -> decide -> result(meta) -> persisted in session history by pi`

## 6.2 Refresh

`model/user -> refresh -> append custom invalidation entry -> next replay sees invalidation -> next read returns baseline`

## 6.3 Tree navigation

`/tree changes leaf -> replay source path changes -> knowledge changes automatically`

---

## 7) Edge-case handling checklist (implementation-time)

1. Path exists with literal `:` and no explicit offset/limit.
2. Path shorthand parse only when safe.
3. `offset` beyond EOF uses built-in error behavior.
4. Empty file, single-line file, trailing newline differences.
5. Insertions before a range shift line positions.
6. File changed outside range.
7. Full scope base present, range scope absent.
8. Invalid metadata in old session entries.
9. Missing object blob for base hash.
10. Compaction boundary where `firstKeptEntryId` missing from path.
11. Leaf reset (`null`) behavior when user rewinds to before first entry.
12. Concurrent writes of same hash object from multiple sessions.
13. Abort signal during read/diff.
14. Non-text files delegated safely.
15. Very large files skip diff path.

---

## 8) Test plan (full matrix)

## 8.1 Unit tests

- `meta.test.ts`
  - valid/invalid metadata parsing
  - invalidation parsing

- `path.test.ts`
  - `@`, `~`, unicode spaces
  - safe `:start-end` parsing
  - malformed ranges

- `text.test.ts`
  - range slicing and equality
  - token estimate

- `diff.test.ts`
  - diff generation and usefulness gating

- `replay.test.ts`
  - compaction boundary logic
  - invalidation replay semantics
  - full-scope invalidation wipes range scopes

## 8.2 Integration tests

- `selective-range.test.ts`
  - exact sequence:
    1) read 160-249
    2) edit outside range
    3) read 160-249 unchanged_range
    4) read 100-349 changed handling

- `tree-navigation.test.ts`
  - read on branch A, /tree branch B, read correctness

- `compaction-boundary.test.ts`
  - pre/post compaction replay boundary correctness

- `refresh-invalidation.test.ts`
  - refresh command + tool invalidation durability

- `restart-resume.test.ts`
  - close/reopen/resume and replay-derived correctness

## 8.3 Concurrency tests

- parallel sessions writing same object hash
- parallel sessions reading/updating overlay independently (same process and multi-process best-effort)

---

## 9) Manual QA checklist

1. Load extension project-locally.
2. Verify `read` appears as overridden tool.
3. Run repeated reads on unchanged file.
4. Edit file outside requested range and verify unchanged_range marker.
5. Edit inside range and verify fallback full slice.
6. Read full file with changes and verify diff path.
7. Trigger `/tree` branch switch and verify no stale unchanged results.
8. Trigger compaction then verify boundary-safe behavior.
9. Run `/readcache-refresh` then verify next read is full baseline.
10. Restart pi, resume session, verify replay behavior unchanged.

---

## 10) Rollout phases

### Phase A — Skeleton + compatibility
- scaffold modules
- baseline read delegation
- metadata attachment

### Phase B — Replay correctness
- replay engine
- compaction boundary
- overlay merge

### Phase C — Decision engine
- full/unchanged/range slice compare
- full diff mode

### Phase D — Refresh controls
- status command
- refresh command
- optional refresh tool

### Phase E — Hardening
- non-text/large-file guardrails
- concurrency and robustness tests

Ship only after Phase E tests pass.

---

## 11) Operational defaults (initial)

- Diff enabled only for `full` scope
- Range changes use baseline fallback
- Strict fail-open to baseline on any uncertainty
- Object store persists indefinitely (GC optional in later version)

Future optional improvements (post-ship):
- object GC
- richer range diffing
- configurable excludes/limits via extension flags

---

## 12) Anti-footgun constraints for implementers

1. Do not create a global mutable session pointer table as source of truth.
2. Do not make correctness depend on event ordering.
3. Do not skip branch replay in favor of cached memo without leaf key checks.
4. Do not emit unchanged markers without verified base hash from replay knowledge.
5. Do not alter built-in `read` schema.
6. Do not break image read behavior.

---

## 13) Definition of done (strict)

All items required:

- [ ] All modules implemented and typechecked.
- [ ] Unit and integration test matrix complete and passing.
- [ ] Manual QA checklist complete.
- [ ] No known correctness gaps in tree/compaction/range behavior.
- [ ] Baseline fallback proven for all failure paths.
- [ ] `readcache-refresh` invalidation durable across restart/resume.

If any box is unchecked, do not call implementation complete.
