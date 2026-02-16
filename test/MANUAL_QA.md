# pi-readcache Manual QA Reproduction Log

Date: 2026-02-15

This log executes the `IMPLEMENTATION_PLAN.md` manual checklist with reproducible evidence from the integration harness and extension wiring tests.

## Commands executed

```bash
cd /Users/gurpartap/Projects/github.com/Gurpartap/pi-readcache/extension
npm run typecheck
npm test -- test/unit/replay.test.ts
npm test
npm test -- test/integration/tree-navigation.test.ts
npm test -- test/integration/compaction-boundary.test.ts
npm test -- test/integration/selective-range.test.ts
npm test -- test/integration/refresh-invalidation.test.ts
npm test -- test/integration/restart-resume.test.ts
```

All commands passed.

## Checklist outcomes

| Plan checklist item | Evidence | Result |
|---|---|---|
| 1) Load extension project-locally | `test/unit/index.test.ts` (extension entrypoint wiring executes and registers all controls) | ✅ PASS |
| 2) Verify `read` is overridden | `test/unit/index.test.ts` asserts tool registration includes `read` | ✅ PASS |
| 3) Repeated reads on unchanged file | `test/integration/refresh-invalidation.test.ts` (`unchangedRead`), `test/unit/tool.test.ts` repeated full read paths | ✅ PASS |
| 4) Edit outside requested range -> `unchanged_range` | `test/integration/selective-range.test.ts` (`changes exist outside this range`) | ✅ PASS |
| 5) Edit inside requested range -> fallback slice | `test/integration/selective-range.test.ts` (`baseline_fallback` for changed ranges and shifted ranges) | ✅ PASS |
| 6) Full-file changes -> diff path | `test/unit/tool.test.ts` (`emits full-scope diff output...`) | ✅ PASS |
| 7) `/tree` branch switch has no stale base leakage | `test/integration/tree-navigation.test.ts` (`does not leak stale base hashes...`) | ✅ PASS |
| 8) Compaction boundary handling is context-safe | `test/integration/compaction-boundary.test.ts` (strict barrier + multi-compaction + range + tree cases) | ✅ PASS |
| 9) `/readcache-refresh` forces next baseline read | `test/integration/refresh-invalidation.test.ts` (`/readcache-refresh appends...`) | ✅ PASS |
| 10) Restart/resume preserves replay behavior | `test/integration/restart-resume.test.ts` (persistent invalidation replay after reopen) | ✅ PASS |

## Notes

- Persistence-sensitive scenarios are seeded with an assistant entry in tests so session JSONL flushing behavior matches real interactive usage.
- No manual blocker remains from the plan checklist.
