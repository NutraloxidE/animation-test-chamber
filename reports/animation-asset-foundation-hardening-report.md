# Animation Asset Foundation Hardening — Completion Report

Base branch and SHA: `claude/new-session-7d9k61` intent, actually started from
`claude/new-session-9h6hb7` at `895815ec5f71e4e62c756312ddb797a8991bf340`
(per user instruction — see Scope Decision below).

Final branch and SHA: `claude/new-session-9h6hb7` at `e0a64a9ccb1bfde2e2e572021bed7e270660c806`.

## Scope decision (recorded, not silent)

The plan's Part 0/Part II specify starting from `claude/new-session-7d9k61`
and working on a new branch `fix/animation-asset-foundation-hardening`. At the
start of this session the user was asked how to scope this large plan and
which branch to use, and explicitly chose: work through the phases
sequentially, and develop directly on `claude/new-session-9h6hb7` (already
checked out) rather than creating the plan's suggested branch. All work below
proceeds from that instruction. `895815e` (the tip of `claude/new-session-9h6hb7`
at session start) is therefore the baseline this report compares against.

## Changed files

67 files changed, +7979 / −1771 across 11 commits (`895815e..e0a64a9`):

```
9c166b1 test: freeze animation asset hardening baseline
465288c feat: add crash-safe repository file-set transactions
2df4144 fix: enforce immutable published asset references
56b16ff refactor: make behavior variants parent-plus-patch only
71666ce fix: persist every staged animation change explicitly
a9796ac fix: preserve static character drafts and isolate domain logic
4560aea test: resolve the 3 baseline replay failures and a narrow-viewport overlay bug
7943a86 fix: deterministic tick-driven visual tests and reload/duplicate-mount bugs
b7842cb fix: make chamber tests and narrow-viewport overlays work on mobile-landscape
4a6aa16 fix: full visual determinism across desktop, mobile-landscape and 320px
e0a64a9 build: regenerate schemas and Unity export; add transaction-recovery stage
```

New packages/files of note: `packages/repository-transaction/` (full package),
`packages/schema/src/animation-save.ts`, `apps/web/src/test-driver.ts`,
`harness/check-transaction-recovery.ts`, `DECISIONS/0008-unarmed-root-displacement-baseline.md`.

No file under `assets/animation/**/1.0.0.json` was touched — the published
asset set is byte-identical to Phase 0's baseline (verified below).

## Architecture decisions

Recorded in full in `ARCHITECTURE.md` (new sections) and `DECISIONS/0008-*.md`.
Summary:

- **Repository transactions are generic and Animation-agnostic**
  (`packages/repository-transaction`, no `@atc/schema` import). A caller
  supplies planned writes, an optimistic-concurrency expectation, and a
  validator over the *prepared* view; the package handles staging,
  validation, backup, atomic promotion-by-rename, and crash-safe recovery.
- **A variant is parent + patches, never a payload snapshot.** The behavior
  asset schema is a discriminated union; `variant` cannot carry a payload at
  the type level. Parent contract additions reach every variant automatically
  through resolution, not migration.
- **Save destinations are named per domain, not defaulted.** Graph and clip
  changes each get their own destination choice; an incompatible pairing
  (a clip patch aimed at a tuning profile) is refused, not silently dropped
  or merged.
- **A static host gets a real save.** Character-override saves work with no
  API server — same code path, persisted to `localStorage`, never applied
  across a stale revision without explicit confirmation.
- **Domain decisions never read UI state.** Variant/base classification is a
  direct registry lookup; the asset library's search/filter state cannot
  influence it.
- **Visual determinism comes from a fixed-tick test driver
  (`window.__ATC_TEST__`)**, dev-only and tree-shaken from production builds,
  not from tuned `waitForTimeout` values.

## Transaction state machine

`preparing → prepared → promoting → committed`, with `rolling-back →
rolled-back` on any failure from `prepared` onward. Journal written at each
transition to `.chamber-transactions/<id>/journal.json`. Recovery
(`recoverRepository`) resolves `preparing`/`prepared` and `committed` by
cleanup, and `promoting`/`rolling-back` by re-running rollback from the
journal; a transaction that cannot be fully rolled back marks the repository
`readOnly` and the API refuses further writes until it is resolved.

## Fault injection matrix (`tests/integration/repository-transaction/transaction.test.ts`, 25 tests)

Failure injected before/after each promotion point (first asset, second
asset, all-assets-before-project, during project rename, during hash
verification), plus: process-crash-simulation with `journal.state=promoting`
recovered on next startup, recovery run twice (idempotent), write-lock
contention and stale-lock takeover, two concurrent publishes racing the same
next version, stale project revision, stale referenced asset hash, and
report-write failure not affecting a completed commit. All 25 pass; every
case verifies canonical project and existing published assets are
byte-identical to pre-transaction state after rollback.

## Crash recovery result

PASS. `harness/check-transaction-recovery.ts` runs `recoverRepository`
against the live repository twice in the one-shot harness; both passes
report zero unresolved transactions and `readOnly: false` on this branch.

## Concurrency result

PASS. Two concurrent publish attempts against the same next version: one
succeeds, one is refused with a conflict (`tests/integration/repository-transaction/transaction.test.ts`).
Lock acquired by exclusive create; a stale lock (dead pid, past the age
threshold) is taken over only after recovery, never on a live contention.

## Hash contract result

PASS. `AssetReference.contentHash` (`PublishedContentHash`) rejects the empty
string at the schema level; the registry's `checkReference()` always compares
in full, with no bypass. `AnimationAssetMetadata.contentHash`
(`DraftContentHash`) still permits empty only pre-seal. Duplicate asset keys,
wrapper/document metadata mismatches, and file-path/metadata mismatches are
all rejected at registry load.

## Variant inheritance result

PASS. `VariantAnimationBehaviorAsset` has no payload field in its schema.
Unit tests (`tests/unit/animation-assets/derivation-and-resolution.test.ts`)
cover: a parent gaining an optional slot/replay fixture later reaching an
existing variant automatically, required-slot removal rejected, protection
weakening rejected, circular variant chains rejected, a fork remaining fully
resolvable after its origin is deleted, and duplicate-as-base independence.

## Patch persistence matrix

`tests/unit/animation-assets/save-classification.test.ts` (12 tests) and
`tests/integration/animation-assets/transaction.test.ts` (10 tests) cover:
graph-only to each of the four graph destinations, clip-only to each of the
two clip destinations (including per-binding precision for a contextual
clip), two clip assets changed in one save, mixed graph+clip in one
transaction, a clip patch aimed at an incompatible destination refused
explicitly, and no patch lost between request and persisted result on a
successful save.

## Static draft result

PASS. `tests/visual/chamber.spec.ts` (`static character drafts` describe
block): an offline character-override save applies immediately, persists
through a page reload, shows the exact required status text, and leaves
`project.json` untouched; a draft recorded against a revision the project has
since moved past never auto-applies and is discardable.

## Replay hashes / regression policy

The 3 replay failures present at Phase 0 baseline are resolved and
documented in `DECISIONS/0008-unarmed-root-displacement-baseline.md` — the
cause was two independent instances of a test's expected value predating a
later, deliberate human tuning of `unarmed-attack-01.rootDisplacement.z`
(`0 → 0.5`) and a fixture-timing assumption that no longer held; runtime
Feel was not changed. `tests/replay/expectations.test.ts` is 42/42,
`tests/replay/determinism.test.ts` 23/23,
`tests/replay/animation-assets/shared-behavior.test.ts` 26/26 (91/91 total).
The Legacy Shadow Replay comparison (`shadowRuntimeStage`, backed by
`harness/shadow-compare.ts` against the frozen pre-migration traces) passes:
all fixtures byte-identical to the pre-split runtime.

## Visual test result

PASS, 114/114 (38 tests × desktop / mobile-landscape / 320px narrow).
Five tests were converted from wall-clock waiting to the fixed-tick driver
(keyboard input, jump-and-attack, sword attacks, the combo-timing layer-bar
test, and the live-replay-progress check in repeated-clip-tuning). Beyond
the timing conversion, three real UI bugs were found and fixed along the
way, not worked around: `SaveDestinationDialog` mounted twice when the Asset
Library dock and the Chamber's own copy were both present; a Vite dev-server
full-reload triggered by the app's own project.json write could beat the
save confirmation message to the screen (now suppressed for the app's own
writes, with a `sessionStorage` fallback if it still wins); and three
distinct z-index/width overlays on a narrow viewport (the Hierarchy dock
covering its own toggle button, a stale-draft banner hidden under the
viewport-controls panel, and the bottom sheet overflowing 100px past a
320px viewport because a narrow-breakpoint rule reset position but not the
base rule's fixed width).

## Published asset byte comparison

PASS. All 76 files under `assets/animation/**/*.json` match the Phase 0
baseline SHA-256 hash exactly (`reports/animation-asset-published-baseline.json`).
No published version was modified in place; the repo guard's
`no published asset version modified in place` check passes on every stage
run in this report.

## All commands and exit codes

| Command | Result |
| --- | --- |
| `pnpm typecheck` | PASS (0) |
| `pnpm lint` | PASS (0) |
| `pnpm harness:check` (static) | PASS (0) |
| `pnpm harness:animation-assets` | PASS (0) — 7/7 |
| `harness/check-transaction-recovery.ts` | PASS (0) |
| `pnpm harness:unit` | PASS (0) — 247/247 |
| `pnpm harness:integration` | PASS (0) — 61/61 |
| `pnpm harness:replay` | PASS (0) — 91/91 |
| `npx tsx harness/shadow-compare.ts` (via `shadowRuntimeStage`) | PASS (0) |
| `pnpm harness:repo-guard` | PASS (0) — 8/8 |
| `pnpm build` | PASS (0) |
| `npx playwright test` | PASS (0) — 114/114 |
| `pnpm harness:one-shot` (run 1, clean checkout) | PASS (0) — 26/26 stages |
| `pnpm harness:one-shot` (run 2, immediately after) | PASS (0) — 26/26 stages, zero file drift |
| Published-asset baseline hash check | PASS — 76/76 unchanged |

## Known limitations

- **Visual suite wall-clock sensitivity outside the 5 named tests.** The plan
  named 5 tests for fixed-tick conversion; all 5 (plus the one additional
  wall-clock-reliant assertion inside `repeated clip tuning`) were converted.
  The remaining visual tests that do not depend on live simulation timing
  (dialogs, panels, forms) were left on Playwright's normal auto-waiting,
  which is not wall-clock-fragile in the same way and is currently 100%
  green across all three viewports — but they are not immune to a
  sufficiently overloaded host the way any Playwright suite is not.
- **Container performance varied significantly across this session** (a
  single test occasionally took 2-3x longer under load than in isolation).
  Every fix in this report was verified passing multiple times, including a
  full 114-test three-viewport run and two consecutive full one-shot runs,
  specifically because single-run passes were not trusted as sufficient
  evidence under these conditions.
- **`.chamber-fake-git/` and `.chamber-transactions/`** are gitignored,
  locally-regenerated scratch state; they were reset between verification
  runs in this session but are not part of the committed repository.

## Final declaration

```
Animation Asset Foundation Hardening: PASS

Generic Repository Transaction: PASS
Crash Recovery: PASS
Concurrent Write Protection: PASS
No Lost Fine-Tuning Data: PASS
Strict Asset References: PASS
True Variant Inheritance: PASS
Static Character Draft: PASS
Domain Logic Isolation: PASS
Replay Compatibility: PASS
Visual Determinism: PASS
Published Asset Protection: PASS
One-shot Harness Run 1: PASS
One-shot Harness Run 2: PASS
```
