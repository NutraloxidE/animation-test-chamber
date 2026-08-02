# Animation Asset Foundation Hardening — Baseline Report (Phase 0)

Branch: `claude/new-session-9h6hb7`
Baseline SHA: `895815ec5f71e4e62c756312ddb797a8991bf340`
Diff vs `origin/main` (30f3972): 207 files changed, +41870 / -7087

Working tree was clean at the start of this phase (`git status --short` empty).
No user changes existed to preserve.

## Commands run

| Command | Result |
| --- | --- |
| `pnpm install` | OK |
| `pnpm typecheck` | PASS (clean) |
| `pnpm lint` | PASS (clean, `--max-warnings=0`) |
| `pnpm harness:animation-assets` | PASS — 7/7 |
| `pnpm harness:unit` | PASS — 228/228 (11 files) |
| `pnpm harness:integration` | PASS — 33/33 (2 files) |
| `pnpm harness:replay` | **FAIL** — 3 failing / 91 total (see below) |
| `pnpm build` | PASS |
| `pnpm harness:visual` | **FAIL** — 60 failed / 48 passed (108 total), 52.4 min wall clock, single worker |

## Known replay failures (3), all in `tests/replay/expectations.test.ts`

1. `attack-01-to-attack-02 > uses only authored movement for the sword attack`
   — `expected 0.463583 to be less than 0.3`
2. `attack-01-to-attack-02 > scales the measured trajectory with the forward displacement adjustment`
   — `expected -0.105 to be close to 0.07` (diff 0.175, tolerance 0.0005)
3. `regression detection > rejects a combo press made before the action input window opens`
   — expected `['attack-01','action-none']`, got `['attack-01','attack-02','action-none']`

These match the "Known limitations" section of the prior
`reports/animation-assets-one-shot-report.md`: a data-vs-test divergence dating
to `c0f4067` (`unarmed-attack-01.rootDisplacement.z ≈ 0` expected, demo data
says `0.5`). This is the exact condition Part VII / §26 of the hardening plan
requires resolving via an explicit Decision Record, not a silent snapshot
re-generation.

## Visual harness (60/108 failing)

The prior report recorded 11/147 visual failures on the authoring machine.
This container's headless Chromium (software rendering, single Playwright
worker) is materially slower, and a large fraction of the failures are
`waitForTimeout`-paced tests (keyboard input, jump/attack, sword attacks,
layer bar, repeated clip tuning) timing out before the simulation reaches the
expected state — consistent with the plan's Part VII diagnosis that these
tests depend on wall-clock/CPU throughput rather than a deterministic tick
driver. Full Playwright output retained in `/tmp/baseline_visual.log` for this
session; not attached verbatim here for size. The commit-blocking, fully
deterministic harness required by Part VII/§27-28 is intended to remove this
class of failure entirely (fixed-tick driver instead of `waitForTimeout`).

## Published asset byte-hash baseline

`reports/animation-asset-published-baseline.json` — SHA-256 of all 76 files
under `assets/animation/**/*.json`, keyed by repository-relative path. Any
phase that changes one of these hashes for a **pre-existing** version file is
an unintended modification of a published asset unless it is an explicit,
documented, generator-driven schema migration (Part IV migration allowance)
with matching justification recorded in this reports directory and 9/9 replay
byte-identity preserved.

## Scope note

This baseline capture (Phase 0) covers: `git`/branch state, published-asset
hash snapshot, and the six harness/build commands above. Full harness stages
not yet run at this checkpoint: `harness:check` (static check), `harness:repo-guard`,
`harness:one-shot` (x2), `shadow-compare.ts`. These will be run again at the
end as part of Part X's final command sequence, not duplicated here.
