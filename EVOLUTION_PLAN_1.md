# pi-readcache Trust-State-Machine Migration Plan

This plan defines the exact migration from the current extension implementation to a correctness-safe replay trust model that prevents false `unchanged` after compaction/tree navigation.

It is intentionally exhaustive and implementation-directed.

---

## 1) Why this migration is required

### 1.1 Observed failure class

A post-compaction read can return:
- `[readcache: unchanged, ...]`

when the model no longer has a proven base in active context.

### 1.2 Root cause in current code

Current `src/replay.ts` applies read metadata unconditionally:
- `applyReadMeta(...)` always writes `knowledge[path][scope] = servedHash`
- this includes modes: `unchanged`, `unchanged_range`, `diff`

Current knowledge model stores only hash strings (no proof freshness/state), so replay cannot distinguish:
- anchor evidence (`full`/`baseline_fallback`) from
- derived evidence (`unchanged`/`diff`) that requires prior trust.

Result: replay can incorrectly bootstrap trust from non-anchor entries inside post-compaction replay window.

---

## 2) Non-negotiable migration goals

1. `unchanged`/`diff` must never create trust without validated base.
2. Trust must be branch-local and replay-derived only.
3. Compaction replay boundary logic must remain deterministic.
4. `read` tool contract and baseline fallback behavior must not regress.
5. Persistent invalidation semantics must continue to work.

---

## 3) Desired trust model

Trust is per `(pathKey, scopeKey)` and includes freshness sequence.

### 3.1 New trust state types

```ts
interface ScopeTrust {
  hash: string;
  seq: number; // replay sequence index (monotonic within replay window)
}

type ScopeTrustMap = Map<ScopeKey, ScopeTrust>;
type KnowledgeMap = Map<string, ScopeTrustMap>; // pathKey -> scope trusts
```

### 3.2 Scope hierarchy

- Full scope key: `full`
- Range scope key: `r:<start>:<end>`

Range reads may derive base from either:
- exact range scope trust
- full scope trust

When both exist, choose the fresher trust (`max(seq)`).

---

## 4) Canonical transition rules (the most important bit)

For each replayed `ReadCacheMetaV1` event in order (`seq++`):

Let:
- `S = scopeKey`
- `M = mode`
- `H = servedHash`
- `B = baseHash`
- `Tfull = trust(path, full)`
- `Trange = trust(path, S)` if S is range

### 4.1 Anchor events (can establish trust)

If `M in {"full", "baseline_fallback"}`:
- set `trust(path, S) = { hash: H, seq }`

### 4.2 Derived full-scope unchanged

If `M == "unchanged"` and `S == "full"`:
- apply only if:
  - `B` exists
  - `Tfull` exists
  - `Tfull.hash == B`
  - `H == B` (sanity)
- then set `trust(path, full) = { hash: H, seq }`
- else ignore event

### 4.3 Derived full-scope diff

If `M == "diff"` and `S == "full"`:
- apply only if:
  - `B` exists
  - `Tfull` exists
  - `Tfull.hash == B`
- then set `trust(path, full) = { hash: H, seq }`
- else ignore event

### 4.4 Derived range unchanged

If `M == "unchanged_range"` and `S` is a range:
- apply only if `B` exists and one of:
  - `Trange` exists and `Trange.hash == B`
  - `Tfull` exists and `Tfull.hash == B`
- then set `trust(path, S) = { hash: H, seq }`
- else ignore event

### 4.5 All other mode/scope combos

Ignore (no trust mutation).

---

## 5) Invalidation transitions

For replayed invalidation entry `{ kind: "invalidate", pathKey, scopeKey }`:

1. If `scopeKey == full`:
   - delete full trust for path
   - delete all range trusts for path
2. Else:
   - delete only that specific range trust
   - if no scopes remain, remove path from map

This remains branch-aware and durable through history replay.

---

## 6) Replay boundary behavior (unchanged but verified)

Maintain current boundary algorithm:

1. Build active branch with `sessionManager.getBranch()`.
2. Find latest `compaction` on active path.
3. Start replay from:
   - index of `firstKeptEntryId` if present on path
   - else `compaction index + 1`
   - else `0`

Important migration check:
- boundary logic stays same
- trust derivation changes to guarded transitions

---

## 7) Base selection at read time (tool integration)

In `tool.ts`, for request scope `Sreq`:

- If `Sreq == full`:
  - candidate = `trust(path, full)`
- If `Sreq` is range:
  - candidateExact = `trust(path, Sreq)`
  - candidateFull = `trust(path, full)`
  - choose candidate with greater `seq`

Then:
- `baseHash = candidate?.hash`

Do not use unsequenced map preference; freshness tie-break is required.

---

## 8) File-by-file migration tasks

## 8.1 `src/types.ts`

### Changes
1. Add `ScopeTrust` type `{ hash: string; seq: number }`.
2. Change `KnowledgeMap` from `Map<string, Map<ScopeKey, string>>` to `Map<string, Map<ScopeKey, ScopeTrust>>`.
3. Keep `ReadCacheMetaV1` schema stable (no breaking change required).

### Risks
- Downstream compile failures where string hash was expected.

### Required updates
- replay, tool, telemetry, tests.

---

## 8.2 `src/replay.ts`

### Changes
1. Replace unconditional `applyReadMeta` with guarded transition function:
   - `applyReadMetaTransition(knowledge, meta, seq)`
2. Add trust helpers:
   - `getTrust(path, scope)`
   - `setTrust(path, scope, hash, seq)`
3. Replay loop must pass monotonic `seq`.
4. Keep invalidation processing; adjust to trust-map values.
5. `mergeKnowledge` must merge `ScopeTrust` values.

### Critical implementation detail
- Guard logic must exactly match Section 4.

### Pitfall to avoid
- Accidentally allowing `unchanged` to set trust when `baseHash` missing.

---

## 8.3 `src/tool.ts`

### Changes
1. Update base selection logic for range scope to choose freshest trust by `seq`.
2. Replace direct hash map reads with trust-object reads.
3. Preserve all fallback behavior unchanged.
4. Keep metadata writing unchanged (still write `readcache` block).

### Pitfall to avoid
- Reintroducing exact-scope-preferred static precedence without `seq` comparison.

---

## 8.4 `src/meta.ts`

### Changes
1. Strengthen validation:
   - modes `unchanged`, `unchanged_range`, `diff` require non-empty `baseHash`.
   - modes `full`, `baseline_fallback` may omit `baseHash`.
2. Keep parser fail-open (invalid entries ignored by replay).

### Backward compatibility
- Older malformed entries are ignored; no throws.

---

## 8.5 `src/telemetry.ts`

### Changes
1. Adjust `summarizeKnowledge` iteration for trust objects.
2. Ensure mode counting remains replay-meta based (unchanged logic).

---

## 8.6 `src/commands.ts`

### Changes
- No semantic changes required.
- Ensure status still works with new `KnowledgeMap` structure.

---

## 8.7 `index.ts`

### Changes
- No semantic change required.
- Keep event-based runtime cache invalidation only.

---

## 9) Test migration plan (mandatory)

## 9.1 New/updated unit tests (`test/unit/replay.test.ts`)

Add/adjust to cover transitions:

1. `applies_full_anchor_without_prior_trust`
2. `ignores_unchanged_without_full_anchor`
3. `applies_unchanged_with_matching_full_anchor`
4. `ignores_diff_without_matching_full_anchor`
5. `applies_diff_with_matching_full_anchor`
6. `applies_unchanged_range_with_matching_range_anchor`
7. `applies_unchanged_range_with_matching_full_anchor`
8. `full_invalidation_clears_all_scopes`
9. `range_invalidation_clears_only_range_scope`

## 9.2 Critical regression integration test (`test/integration/compaction-boundary.test.ts`)

Add exact scenario:

1. read file => `mode=full`
2. read same file => `mode=unchanged`
3. append compaction with `firstKeptEntryId` pointing to unchanged entry
4. read again
5. assert next mode is `full` (or `baseline_fallback` if baseline path required), **not** `unchanged`

This proves non-anchor entries cannot bootstrap trust post-boundary.

## 9.3 Base selection freshness integration test

Scenario:
1. establish full trust at hash H1
2. establish exact range trust at older hash H0
3. request same range
4. assert chosen base is H1 (fresher seq)

## 9.4 Existing suites to rerun

- `tree-navigation`
- `selective-range`
- `refresh-invalidation`
- `restart-resume`
- `compaction-boundary`

---

## 10) Execution order (strict)

1. Add failing tests for compaction/non-anchor bootstrap.
2. Refactor types and replay trust transitions.
3. Update tool base selection by freshness.
4. Tighten metadata validation.
5. Update telemetry/status compile points.
6. Get unit tests green.
7. Get integration tests green.
8. Run full test suite + typecheck.
9. Only then update `IMPLEMENTATION_SPEC.md` and `IMPLEMENTATION_PLAN.md`.

---

## 11) Verification commands

From repo root:

1. `npm run typecheck`
2. `npm test -- test/unit/replay.test.ts`
3. `npm test -- test/integration/compaction-boundary.test.ts`
4. `npm test -- test/integration/tree-navigation.test.ts`
5. `npm test -- test/integration/selective-range.test.ts`
6. `npm test -- test/integration/refresh-invalidation.test.ts`
7. `npm test -- test/integration/restart-resume.test.ts`
8. `npm test`

All must pass before docs are updated.

---

## 12) Documentation update requirements (after code is green)

Update both files to exactly match implemented behavior:

1. `IMPLEMENTATION_SPEC.md`
   - Add explicit guarded transition rules and freshness selection
   - Clarify anchor vs derived modes

2. `IMPLEMENTATION_PLAN.md`
   - Add migration tasks and test IDs
   - Add regression gate for compaction/non-anchor bootstrap

No doc drift allowed.

---

## 13) Risks and mitigations

### Risk A: Over-strict replay drops too much trust
Mitigation:
- full anchor always establishes trust
- unchanged/diff only advance from proven base
- tests for expected unchanged behavior where full anchor exists

### Risk B: Freshness selection bug for range scope
Mitigation:
- explicit seq-based candidate selection test

### Risk C: Metadata validation breaks old sessions
Mitigation:
- invalid entry ignored, never fatal
- fallback to baseline remains intact

### Risk D: Hidden regressions in UI/tool rendering
Mitigation:
- preserve result shape and details.truncation behavior
- rerun compatibility tests and manual smoke reads

---

## 14) Definition of done for this migration

Complete only when all are true:

- [ ] Transition state machine implemented with guarded mode rules.
- [ ] Non-anchor post-compaction bootstrap regression test passes.
- [ ] Freshness (`seq`) base selection implemented and tested.
- [ ] Full suite + typecheck green.
- [ ] Spec and plan docs updated to exact behavior.
- [ ] No fallback/contract regressions detected.

If any item is unchecked, migration is not complete.
