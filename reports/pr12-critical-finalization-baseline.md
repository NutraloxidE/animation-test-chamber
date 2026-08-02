# PR #12 critical integrity finalization — baseline

Captured before any change in this pass, against the branch as it stood.

| | |
| --- | --- |
| Repository | `NutraloxidE/animation-test-chamber` |
| Pull request | #12 — *Split animation into reusable assets referenced by characters* |
| PR head branch | `claude/new-session-9h6hb7` |
| Head at capture | `21cf0ff946a2e0fa062446a6e01a3c2bc6399e11` |
| Base | `30f39724e6eb544520c7c39598acc7dbffd22104` (main, merge of #11) |
| Working branch for this pass | `claude/pr-12-continuation-0cpio7`, branched from `21cf0ff` |
| Captured | 2026-08-01 06:01–06:18 UTC |
| Working tree at capture | clean (`git status --short` empty) |

The work package named `e0a64a9` as the last reviewed head. The remote branch
had moved on to `21cf0ff`; per its own guard the newer remote head is taken as
canonical, with no reset and no force push.

## Stage results

| Stage | Command | Exit | Result at baseline |
| --- | --- | --- | --- |
| Typecheck | `pnpm typecheck` | 0 | clean |
| Lint | `pnpm lint` | 0 | clean |
| Static checks | `pnpm harness:check` | 0 | 5/5 |
| Animation assets | `npx tsx harness/check-animation-assets.ts` | 0 | 7/7 |
| Transaction recovery | `npx tsx harness/check-transaction-recovery.ts` | 0 | clean and idempotent |
| Unit | `pnpm harness:unit` | 0 | 247/247, 12 files |
| Integration | `pnpm harness:integration` | 0 | 61/61, 4 files |
| Replay | `pnpm harness:replay` | 0 | 91/91, 3 files |
| Shadow comparison | `npx tsx harness/shadow-compare.ts` | 0 | 9 replays identical to the legacy runtime |
| Repo guard | `pnpm harness:repo-guard` | 0 | 8/8 |
| Build | `pnpm build` | 0 | `apps/web/dist` written |
| One-shot | `pnpm harness:one-shot` | **1** | **25/26 stages — visual blocked the commit** |

`pnpm harness:animation-assets` and `pnpm assets:animation:index` do not exist
as package scripts on this branch; the underlying harness entry points
(`harness/check-animation-assets.ts`, `harness/generate-animation-asset-index.ts`)
were run directly instead. Nothing was skipped.

## The one-shot failure

```text
25/26 stages passed in 998.4s
COMMIT BLOCKED by: visual (playwright)

  111 passed, 3 failed of 114
    [mobile-landscape] chamber.spec.ts:518 a replay plays back and reports a before/after comparison
    [mobile-landscape] chamber.spec.ts:596 timing curve control points can be dragged directly
    [narrow]           chamber.spec.ts:430 an offline character-override save persists as a
                                           browser-only draft and survives reload
```

This contradicts the completion report and PR body at `21cf0ff`, both of which
state **114/114 visual** and **26/26 one-shot stages on two consecutive clean
runs**. Recorded here as found rather than reconciled; attribution and the
re-run on the finalized head are in
`reports/pr12-critical-integrity-finalization.md`.

Two caveats on this particular number, stated so it is not read as more than it
is:

1. The baseline run was started as a background job at 06:01 and reached its
   one-shot stage at ~06:03, finishing at ~06:18. Source changes for WP-02
   through WP-04 landed in the working tree during that window, so the one-shot
   and visual stages of this baseline ran against a mixed tree. Every stage
   above it (through `pnpm build`) completed before the first edit and is
   unaffected.
2. The visual suite drives the real app against the real API server, and one of
   its tests commits a tuning change through `POST /api/commit`, which calls
   `saveProject`. Running it therefore rewrites
   `projects/demo-character/project.json` to a new revision. That is
   pre-existing behaviour on this branch, and it means `git status --short` is
   not clean after `pnpm harness:visual`.

## Known external status

The PR's only reported check is a Vercel deployment on the project
`animation-test-chamber-api`, failing at `21cf0ff`. PR #11 (`c0f4067`)
succeeded on the same project, so the failure arrived with this branch rather
than with the deployment configuration. Diagnosis and fix are recorded in the
finalization report.
