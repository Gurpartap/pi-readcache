# EVOLUTION_PLAN_2 — Strict Compaction Barrier for Trust Replay

## Status
Draft v1

## Objective
Fix post-compaction behavior so pi-readcache does **not** return `diff`/`unchanged` using pre-compaction trust evidence.

## Problem Statement
Current replay boundary can include pre-compaction trust history via `firstKeptEntryId`. This can yield post-compaction `diff`/`unchanged` responses that are hash-consistent but practically unhelpful for “fresh context after compaction” expectations.

## Policy Decision (authoritative)
Adopt a **strict compaction barrier** on the active branch path:

- Replay trust starts at `latestCompactionIndex + 1`.
- Ignore `firstKeptEntryId` for trust reconstruction.
- Pre-compaction trust is never used to establish post-compaction base.

This is branch-local and compaction-local:
- If multiple compactions exist, use the nearest ancestor compaction on current active path.
- If current leaf is before compaction (via `/tree`), barrier is absent for that branch view.

---

## Expected Behavior After Fix

1. First `read` after the latest active compaction for a file/scope:
   - `mode = full` or `full_fallback`
   - never `unchanged`/`diff` purely from pre-compaction evidence.

2. Subsequent reads on same branch after post-compaction anchor:
   - normal guarded trust logic applies (`unchanged`, `diff`, `unchanged_range` as valid).

3. `/tree` navigation:
   - moving to a pre-compaction node removes that barrier from active path.
   - moving to another branch uses that branch’s latest compaction barrier.

4. `/readcache-refresh` remains unchanged and still forces baseline for target scope.

---

## Hard Invariants

1. No pre-compaction trust may be used after active compaction barrier.
2. Trust remains replay-derived, branch-local, and scope-aware.
3. Guarded mode transitions remain unchanged.
4. Fail-open fallback behavior remains intact.
5. Tool contract (`read`, params, output shape) remains unchanged.

---

## Code Changes (exact)

## 1) `src/replay.ts`

### Change
Update `findReplayStartIndex(branchEntries)`:
- current: prefers `firstKeptEntryId`, fallback `compaction+1`
- target: **always** `compaction+1` for latest compaction on active path

### Required return semantics
```ts
if (latestCompactionFound) {
  return { startIndex: min(compactionIndex + 1, branchEntries.length), boundaryKey: `compaction:${id}` };
}
return { startIndex: 0, boundaryKey: "root" };
```

### Notes
- Keep boundary key stable for memo cache behavior.
- Keep trust transition engine untouched (anchor/derived guards still required).

## 2) `src/telemetry.ts`

### Change
No logic changes expected except behavior naturally follows updated boundary.
Confirm replay window count is computed from new start index.

## 3) `src/tool.ts`

### Change
No algorithmic changes needed if replay boundary is fixed.
Verify first post-compaction read resolves no base and returns baseline output.

## 4) `src/commands.ts`

### Change
No logic change required.
`/readcache-status` should reflect reduced replay window after compaction.

---

## Test Plan Updates (mandatory)

## Unit: `test/unit/replay.test.ts`

1. Replace/adjust old expectation:
   - remove expectation that replay can start at `firstKeptEntryId`.
   - assert latest-compaction boundary starts at `compaction+1`.

2. Keep existing guarded transition tests.

## Integration: `test/integration/compaction-boundary.test.ts`

Add/adjust scenarios:

1. `first_read_after_compaction_is_baseline_even_if_precompaction_anchor_exists`
   - pre: full anchor + unchanged/diff before compaction
   - compact
   - post: first read must be `full`/`full_fallback`

2. `latest_compaction_wins_when_multiple_compactions_exist`
   - create two compactions on active path
   - verify replay starts after latest one

3. `tree_navigation_pre_compaction_restores_precompaction_visibility`
   - branch to node before compaction
   - verify behavior follows that path’s boundary (may allow unchanged if valid there)

4. `post_compaction_first_range_read_is_baseline_range`
   - first range read after compaction cannot be `unchanged_range` from pre-compaction trust

## Regression checks to retain
- non-anchor cannot bootstrap trust
- freshness selection (`seq`) between range/full
- refresh invalidation durability

---

## Documentation Updates

## 1) `IMPLEMENTATION_SPEC.md`

Update sections:
- boundary selection: remove `firstKeptEntryId` trust replay usage
- formal state machine: add explicit compaction barrier rule
- test matrix: add “first post-compaction read is baseline” requirement

## 2) `IMPLEMENTATION_PLAN.md`

Update sections:
- replay boundary algorithm now strict `compaction+1`
- edge cases and tests aligned to new policy
- remove references that imply `firstKeptEntryId` replay trust path

---

## Migration Risks and Mitigations

1. **Reduced token savings after compaction**
   - Expected tradeoff for stronger correctness/usability.

2. **Existing tests tied to old boundary logic fail**
   - Update tests to new policy and preserve guarded transition tests.

3. **Potential confusion with buildSessionContext using firstKept for LLM context**
   - Clarify: context reconstruction and readcache trust reconstruction now intentionally diverge by policy.

---

## Rollout Sequence

1. Update replay boundary logic.
2. Update failing tests first for strict boundary.
3. Run targeted tests.
4. Run full typecheck + test suite.
5. Update spec + plan docs.
6. Re-run full suite to ensure doc/code lockstep.

---

## Required Verification Commands

From repo root:

1. `npm run typecheck`
2. `npm test -- test/unit/replay.test.ts`
3. `npm test -- test/integration/compaction-boundary.test.ts`
4. `npm test -- test/integration/tree-navigation.test.ts`
5. `npm test -- test/integration/selective-range.test.ts`
6. `npm test -- test/integration/refresh-invalidation.test.ts`
7. `npm test -- test/integration/restart-resume.test.ts`
8. `npm test`

---

## Final Acceptance Matrix

- [ ] Replay boundary always starts at latest active `compaction+1`.
- [ ] Pre-compaction trust is not used post-compaction.
- [ ] First post-compaction read is baseline (`full`/`full_fallback`) for requested scope.
- [ ] Guarded trust-state transitions still pass all tests.
- [ ] Tree navigation behavior remains branch-correct.
- [ ] Docs (`IMPLEMENTATION_SPEC.md`, `IMPLEMENTATION_PLAN.md`) match implemented policy exactly.
- [ ] Full suite and typecheck pass.

---

## One-line implementation prompt

Implement `EVOLUTION_PLAN_2.md` exactly: enforce strict compaction trust barrier (`latest compaction + 1`), update tests and docs accordingly, and stop only when the final acceptance matrix is fully green.
