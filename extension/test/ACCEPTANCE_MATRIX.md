# pi-readcache Acceptance Matrix Mapping

Date: 2026-02-15

This maps `IMPLEMENTATION_SPEC.md` Section 21 (+ items 24–27) and `IMPLEMENTATION_PLAN.md` release gates to executable evidence.

## Matrix mapping snapshot (pre-gap-closure)

| Item | Requirement | Evidence (current) | Status |
|---|---|---|---|
| 1 | first full read | `test/unit/tool.test.ts` (`delegates to baseline read...`) | ✅ Covered |
| 2 | unchanged full read marker | `test/integration/refresh-invalidation.test.ts` (`unchangedRead`) | ✅ Covered |
| 3 | changed full read diff | `test/unit/tool.test.ts` (`emits full-scope diff output...`) | ✅ Covered |
| 4 | changed full read fallback when diff not useful | `test/unit/tool.test.ts` (`oversized full-file changes`) | ✅ Covered |
| 5 | first range read full slice | No dedicated assertion yet | ❌ Gap |
| 6 | unchanged same range marker | No dedicated same-range repeat assertion yet | ❌ Gap |
| 7 | changed outside range -> unchanged_range | `test/integration/selective-range.test.ts` | ✅ Covered |
| 8 | changed affecting range -> fallback | `test/integration/selective-range.test.ts` | ✅ Covered |
| 9 | insertion before range (shift) treated as range changed | No dedicated assertion yet | ❌ Gap |
| 10 | malformed range rejected | Parser-only coverage in `test/unit/path.test.ts`; no tool-level execution check | ❌ Gap |
| 11 | branch A then `/tree` branch B has no stale leakage | `test/integration/tree-navigation.test.ts` | ✅ Covered |
| 12 | `/tree` to pre-compaction point replays history correctly | No dedicated integration assertion yet | ❌ Gap |
| 13 | compaction boundary start logic | `test/unit/replay.test.ts`, `test/integration/compaction-boundary.test.ts` | ✅ Covered |
| 14 | `/fork` independent branch replay state | No dedicated integration assertion yet | ❌ Gap |
| 15 | session switch/resume replay correctness | Resume covered in `test/integration/restart-resume.test.ts`; switch isolation not explicit | ❌ Gap |
| 16 | missing base object hash -> fallback full | No dedicated assertion yet | ❌ Gap |
| 17 | object write collision under concurrency | `test/unit/object-store.test.ts` | ✅ Covered |
| 18 | invalid/missing metadata ignored safely | `test/unit/replay.test.ts`, `test/unit/meta.test.ts` | ✅ Covered |
| 19 | abort during diff -> clean abort | No dedicated assertion yet | ❌ Gap |
| 20 | image/binary delegated baseline | Binary covered in `test/unit/tool.test.ts`; image delegation not explicit | ❌ Gap |
| 21 | UI truncation indicators still work | `src/tool.ts` preserves baseline details, but no explicit test | ❌ Gap |
| 22 | output shape accepted by renderer | Broadly exercised by unit/integration tests with valid tool result shape | ✅ Covered |
| 23 | no prompt/tool-instruction changes required | Architectural invariant; no prompt/tool-schema changes in extension/tests | ✅ Covered |
| 24 | `/readcache-refresh` appends invalidation, next read baseline | `test/integration/refresh-invalidation.test.ts` | ✅ Covered |
| 25 | `readcache_refresh` tool same semantics | `test/integration/refresh-invalidation.test.ts` | ✅ Covered |
| 26 | invalidation survives restart/resume | `test/integration/restart-resume.test.ts` | ✅ Covered |
| 27 | invalidating full wipes all range scopes | `test/unit/replay.test.ts` | ✅ Covered |

## Gaps to close next

1. Add range-first/range-repeat/range-shift/malformed tool-level coverage.
2. Add pre-compaction `/tree` replay check.
3. Add fork + session-switch isolation checks.
4. Add missing-base-object fallback check.
5. Add abort-path check during changed-read flow.
6. Add image delegation check.
7. Add explicit truncation-details preservation check.
