# PR #12 Critical Integrity Finalization — Baseline

timestamp: 2026-08-01T06:06:32Z
head SHA: `21cf0ff946a2e0fa062446a6e01a3c2bc6399e11` (PR #12's head at session start,
one commit ahead of the work package's "last reviewed" `e0a64a9` — the extra
commit, `21cf0ff`, is docs-only: "docs: record animation asset foundation
hardening")
working tree status: clean (`git status --short` empty)

## Commands

| Command | Exit code | Notes |
| --- | --- | --- |
| `pnpm typecheck` | 0 | clean |
| `pnpm lint` | 0 | clean |
| `pnpm harness:check` | 0 | 5/5 static checks |
| `pnpm harness:animation-assets` | 0 | 7/7 |
| `pnpm harness:unit` | 0 | 247/247 |
| `pnpm harness:integration` | 0 | 61/61 |
| `pnpm harness:replay` | 0 | 91/91 |
| `npx tsx harness/shadow-compare.ts` | 0 | 9/9 replays identical |
| `pnpm harness:repo-guard` | 0 | 8/8 |
| `pnpm build` | 0 | web build succeeds |
| `pnpm harness:visual` | 1 | 112/114 passed, 2 failed (see below) |
| `pnpm harness:one-shot` | not captured as a clean pre-fix baseline — see note |

No failing stage among typecheck/lint/harness:check/harness:animation-assets/
harness:unit/harness:integration/harness:replay/shadow-compare/harness:repo-guard/build.
None of the four P1 defects this work closes are caught by the *existing*
suite — that is exactly what WP-01 adds tests for.

## Visual harness (pre-fix code)

112/114 passed, 2 failed:

- `chamber › editing a transition previews the preview and the diff` (mobile-landscape)
- `animation-assets › lists the assets and filters by type` (narrow)

Both are pre-existing, environment/timing-sensitive failures on this
container (the PR's own foundation-hardening report already notes visual
suite wall-clock sensitivity outside the 5 tests converted to the fixed-tick
driver, and container performance varying 2-3x under load across a session).
Neither touches the repository-transaction or animation-save code this work
package changes. Re-checked after the fix — see the finalization report.

## Note on run ordering

`pnpm harness:visual` and `pnpm harness:one-shot` were started in the
background immediately after the fast checks above (typecheck through
build) confirmed clean, to avoid blocking investigation and implementation
on a ~20-30 minute Playwright run. By the time `harness:visual` finished,
implementation (WP-02 through WP-06) was already committed to the working
tree, so `harness:one-shot` — kicked off automatically right after — ran
against the *fixed* code, not the pre-fix baseline. It is reported as
"One-shot Run 1" in the finalization report instead, followed by a genuine
second run for the required two-consecutive-clean-runs check.

## Known Vercel status at baseline

GitHub commit status for `21cf0ff...`: **failure** — context `Vercel`,
target Vercel project `animation-test-chamber-api`
(`https://vercel.com/nutraloxides-projects/animation-test-chamber-api/...`).
Investigated in the finalization report (§ Vercel).
