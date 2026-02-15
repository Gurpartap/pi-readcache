# pi-readcache Acceptance Matrix Mapping

Date: 2026-02-15
Status: Final validation pass complete.

This document maps `IMPLEMENTATION_SPEC.md` Section 21 and `IMPLEMENTATION_PLAN.md` release criteria to executable evidence.

## Final acceptance mapping

| Item | Requirement | Evidence | Status |
|---|---|---|---|
| 1 | first full read | `test/unit/tool.test.ts` (`delegates to baseline read...`) | ✅ Covered |
| 2 | unchanged full read marker | `test/integration/refresh-invalidation.test.ts` (`unchangedRead`) | ✅ Covered |
| 3 | changed full read diff | `test/unit/tool.test.ts` (`emits full-scope diff output...`) | ✅ Covered |
| 4 | changed full read fallback when diff not useful | `test/unit/tool.test.ts` (`oversized full-file changes`) | ✅ Covered |
| 5 | first range read full slice | `test/integration/selective-range.test.ts` (`first range read ... mode full`) | ✅ Covered |
| 6 | unchanged same range marker | `test/integration/selective-range.test.ts` (`second range read ... unchanged_range`) | ✅ Covered |
| 7 | changed outside range -> unchanged_range | `test/integration/selective-range.test.ts` (`changes exist outside this range`) | ✅ Covered |
| 8 | changed affecting range -> fallback | `test/integration/selective-range.test.ts` (`full_fallback` on changed range) | ✅ Covered |
| 9 | insertion before range (shift) treated as range changed | `test/integration/selective-range.test.ts` (`line insertions before range`) | ✅ Covered |
| 10 | malformed range rejected | `test/unit/tool.test.ts` (`rejects malformed path range suffixes...`) + `test/unit/path.test.ts` | ✅ Covered |
| 11 | branch A then `/tree` branch B has no stale leakage | `test/integration/tree-navigation.test.ts` (`does not leak stale base hashes...`) | ✅ Covered |
| 12 | `/tree` to pre-compaction point replays history correctly | `test/integration/compaction-boundary.test.ts` (`tree_navigation_pre_compaction_restores_precompaction_visibility`) | ✅ Covered |
| 13 | strict boundary is latest active `compaction + 1` (never `firstKeptEntryId`) | `test/unit/replay.test.ts` (`starts replay at latest compaction+1...`) | ✅ Covered |
| 14 | latest compaction wins when multiple compactions exist | `test/unit/replay.test.ts` + `test/integration/compaction-boundary.test.ts` (`latest_compaction_wins_when_multiple_compactions_exist`) | ✅ Covered |
| 15 | first post-compaction read is baseline for full/range scopes | `test/integration/compaction-boundary.test.ts` (`first_read_after_compaction_is_baseline_even_if_precompaction_anchor_exists`, `post_compaction_first_range_read_is_baseline_range`) | ✅ Covered |
| 16 | `/fork` independent branch replay state | `test/integration/tree-navigation.test.ts` (`forked sessions isolated...`) | ✅ Covered |
| 17 | session switch/resume replay correctness | `test/integration/restart-resume.test.ts` (restart + session isolation) | ✅ Covered |
| 18 | stale range trust does not override fresher full trust | `test/integration/compaction-boundary.test.ts` (`prefers_fresher_full_trust_over_older_exact_range_trust_when_selecting_baseHash`) | ✅ Covered |
| 19 | missing base object hash -> fallback full | `test/unit/tool.test.ts` (`base object hash is missing`) | ✅ Covered |
| 20 | object write collision under concurrency | `test/unit/object-store.test.ts` (`parallel writes`) | ✅ Covered |
| 21 | invalid/missing metadata ignored safely | `test/unit/replay.test.ts`, `test/unit/meta.test.ts` | ✅ Covered |
| 22 | abort during diff -> clean abort | `test/unit/tool.test.ts` (`aborts cleanly during changed-read flow`) | ✅ Covered |
| 23 | image/binary delegated baseline | `test/unit/tool.test.ts` (`image reads ...`, `non-UTF8 ...`) | ✅ Covered |
| 24 | UI truncation indicators still work | `test/unit/tool.test.ts` (`preserves baseline truncation details...`) | ✅ Covered |
| 25 | output shape accepted by renderer | Unit/integration suite validates read tool result shape across modes | ✅ Covered |
| 26 | no prompt/tool-instruction changes required | `src/tool.ts` keeps `read` name + schema; no prompt file changes | ✅ Covered |
| 27 | `/readcache-refresh` appends invalidation, next read baseline | `test/integration/refresh-invalidation.test.ts` | ✅ Covered |
| 28 | `readcache_refresh` tool same semantics | `test/integration/refresh-invalidation.test.ts` | ✅ Covered |
| 29 | invalidation survives restart/resume | `test/integration/restart-resume.test.ts` (includes persisted JSONL assertions) | ✅ Covered |
| 30 | invalidating full wipes all range scopes | `test/unit/replay.test.ts` (`full_invalidation_clears_all_scopes`) | ✅ Covered |

## Plan release-gate closure

- ✅ `npm run typecheck` passes.
- ✅ `npm test` passes.
- ✅ Targeted suites pass:
  - `npm test -- test/unit/replay.test.ts`
  - `npm test -- test/integration/compaction-boundary.test.ts`
  - `npm test -- test/integration/tree-navigation.test.ts`
  - `npm test -- test/integration/selective-range.test.ts`
  - `npm test -- test/integration/refresh-invalidation.test.ts`
  - `npm test -- test/integration/restart-resume.test.ts`
- ✅ Manual QA checklist completed (`test/MANUAL_QA.md`).

## Residual risk

- No unresolved correctness-critical blocker remains.
- Remaining risk profile is low and bounded to future upstream behavior changes in pi core read semantics.
