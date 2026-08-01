# PR #12 Critical Integrity Finalization

Base SHA (PR base, `main`): `30f39724e6eb544520c7c39598acc7dbffd22104`
Starting head SHA (PR #12, "last reviewed"): `e0a64a9ccb1bfde2e2e572021bed7e270660c806`
Session-start head SHA (one docs-only commit ahead): `21cf0ff946a2e0fa062446a6e01a3c2bc6399e11`
Final head SHA: `ede232721927317eb8955014ca33c3712cb8ded0`
Branch: `claude/new-session-9h6hb7` (PR #12's actual head branch)

## Commit sequence

```
ee597d4 fix: make PR12 transaction journals atomic and corruption-safe
116a453 fix: make PR12 transaction point-of-no-return recoverable and rollback ownership-safe
d394537 fix: refuse unsupported tuning patches in PR12 saves
a380435 fix: remove unused imports from journal.test.ts
42dfae8 test: verify PR12 critical integrity paths end to end
ede2327 fix: make commit-path lock release best-effort; track baseline evidence
```

The work package's suggested order was WP-01 (reproduce) → WP-02 → WP-03 →
WP-04 → WP-05 → WP-06 → WP-07. In practice WP-04's atomic-journal write
(`journal.json.next` + rename) is the mechanism WP-02's fault-injection tests
target (failing the journal write whose *content* says `state: "committed"`
only makes sense once that write goes through a distinguishable temp file),
so the journal/atomic-write fix and its dedicated tests landed first, then
the point-of-no-return and ownership-safe-rollback fix with its tests
(WP-02 + WP-03 together — both live in `transaction.ts`/`rollback.ts` and
share `tests/integration/repository-transaction/transaction.test.ts`), then
the tuning-patch refusal (WP-05), then the end-to-end WP-06 tests. Every
commit above passes the full `pnpm typecheck && pnpm harness:unit &&
pnpm harness:integration` on its own — this is "equivalent narrowly scoped
commits" per §4/§5 of the work package, not a reordering of intent. Each new
test was verified to fail against the pre-fix code (by `git stash`-ing the
fix and re-running) before being verified to pass with it; see "Fault
injection matrix" below.

## WP matrix

| WP | Status | Commit(s) |
| --- | --- | --- |
| WP-01 Reproduce remaining fatal paths | done | tests folded into the fix commits below (see rationale above) |
| WP-02 Point-of-no-return transaction safety | done | `116a453` |
| WP-03 Ownership-safe create rollback | done | `116a453` |
| WP-04 Atomic and corruption-safe journal | done | `ee597d4` |
| WP-05 Explicit tuning patch refusal | done | `d394537` |
| WP-06 Integrated recovery and HTTP verification | done | `42dfae8` |
| WP-07 Harness, reports, PR sync | done | this report + PR body + `ede2327` |

## Exact files changed

```
 apps/api/src/context.ts                                          |  11 +
 apps/api/src/server.ts                                           |   3 +-
 apps/web/src/store.ts                                            |  18 +-
 packages/animation-asset-runtime/src/save.ts                     |  33 ++-
 packages/repository-transaction/src/filesystem.ts                |  23 ++
 packages/repository-transaction/src/index.ts                     |   5 +
 packages/repository-transaction/src/journal.ts                   |  49 +++-
 packages/repository-transaction/src/lock.ts                      |  26 +-
 packages/repository-transaction/src/recovery.ts                  |  43 ++-
 packages/repository-transaction/src/rollback.ts                  |  33 ++-
 packages/repository-transaction/src/transaction.ts                |  60 +++-
 packages/repository-transaction/src/types.ts                     |  20 +-
 tests/integration/animation-assets/save-destination.test.ts      | 324 +++++++++++
 tests/integration/repository-transaction/journal.test.ts         | 282 +++++++++
 tests/integration/repository-transaction/transaction.test.ts     | 262 ++++++++-
 tests/unit/animation-assets/save-classification.test.ts          |  76 +++
 .gitignore                                                       |   3 +
```

No file under `assets/animation/**/*.json` or `projects/demo-character/project.json`
was touched by source changes — repo-guard's "no published asset version
modified in place" and "no protected value changed unexpectedly" checks
confirm this on every run below.

## The four defects, and what closes each

### P1-A — final journal write outside the recoverable window

`runRepositoryTransaction`'s `state=committed` journal write (and, more
narrowly, the `state=promoting` write before it) sat **outside** the
promotion try/catch. A throw there — with canonical files already renamed
into place — fell through to the outer catch, which deleted the transaction
directory and returned `validation-refused`: the repository had changed,
the API said nothing had, and the evidence rollback would have needed to
fix it was gone.

Fix: an explicit `promotionStarted` flag, declared before the outer `try` so
it survives into the outer `catch`. Every journal write from `state=promoting`
through the final `state=committed` write now lives inside one rollback-capable
guard. Once promotion starts, every exit is `committed` / `rolled-back` /
fatal — the outer catch only deletes the transaction directory and returns
`validation-refused` while `promotionStarted` is still `false`.

### P1-B — rollback could delete a file it didn't create

Create-mode rollback did `if (current !== null) fs.remove(canonicalAbs)` —
deleting whatever it found at the target path with no ownership check at
all, `entry.promoted` included.

Fix: rollback now deletes a create target only when
`entry.promoted === true` **and** the current on-disk hash matches
`entry.preparedSha256`. An unpromoted target with something present, or a
promoted target whose content no longer matches, is left untouched, marked
unrestorable, and given a typed reason (`ownership-unknown` /
`content-changed-after-promotion`) carried in the journal's `fatal.reasons`
and the transaction's `report.json`.

### P1-C — a torn journal.json could crash recovery

`writeJournal` overwrote `journal.json` in place; `readJournal` did a raw
`JSON.parse()`. A process dying mid-write left a torn file that the next
process's `recoverRepository()` — called at API startup, before any request
is served — would throw on.

Fix: `writeJournal` now writes to `journal.json.next`, fsyncs it, and lands
it with an atomic same-filesystem rename onto `journal.json` (with a
best-effort directory fsync after). `readJournal` returns
`{status: 'missing' | 'valid' | 'corrupt'}` and never throws. `recoverRepository`
treats a corrupt primary, or an ambiguous `.next` (present with no matching
valid primary, or next to a corrupt one), as fatal: preserve the directory,
mark the repository read-only, never guess. A valid primary with a stale
`.next` beside it (a write that got the temp file down but never renamed)
discards the leftover temp; the primary is authoritative. A stale write lock
pointing at a corrupt or previously-fatal transaction is refused
(`blocked-by-unresolved-transaction`) rather than stolen.

### P1-D — tuning-profile saves silently dropped structural patches

`planSaveAnimationChanges`'s `tuning-profile` case did
`graphPatches.filter((patch) => patch.op === 'set')` before publishing — an
`append`/`remove` staged alongside a value edit vanished from the published
tuning asset with `plan.ok === true` and no issue anywhere.

Fix: every staged patch is now tried against the resolved behaviour graph
with the same rule the resolver already enforces on read
(`valuesOnly: true, requireExistingPath: true`, `resolver.ts`) before
anything is published. Any `append`/`remove`, or a `set` to a path the
parent does not have, refuses the *whole* request with 409
(`tuning-changes-structure` / `invalid-patch-path`) — no partial success, no
asset created, no character assignment changed. The Save Destination
dialog's tuning-profile option is also disabled client-side when a
structural change is staged (`apps/web/src/store.ts`), so a human doesn't
pick an option the server will refuse; the server-side refusal remains the
actual contract.

## Fault injection matrix

Every row: fails against pre-fix code (confirmed by `git stash`-ing the fix
and re-running), passes with it.

| Scenario | Test | Pre-fix result |
| --- | --- | --- |
| `state=promoting` journal write throws | `transaction.test.ts` › point of no return | previously fell to outer catch (behaviour existed but untested; now explicitly covered) |
| `state=committed` journal write throws after all files promoted | `transaction.test.ts` › "failure writing the final state=committed journal…" | `validation-refused`, canonical files left promoted |
| per-entry promoted-journal write throws mid-promotion | `transaction.test.ts` › "failure writing a promoted-entry journal…" | `validation-refused` |
| foreign file created at a create target between prepare and promote | `transaction.test.ts` › "never deletes a foreign create target…" | foreign file deleted by rollback |
| unpromoted create target has something present (crash-recovery path) | `transaction.test.ts` › "an unpromoted, foreign create target survives recovery…" | file deleted, no ownership check |
| promoted create target modified after promotion (crash-recovery path) | `transaction.test.ts` › "a promoted create modified afterward…" | file deleted despite hash mismatch |
| torn `journal.json` | `journal.test.ts` › torn/corrupt journal | `JSON.parse()` throws out of `recoverRepository` |
| `.next` orphaned (no matching primary) | `journal.test.ts` › ".next handling on recovery" | not previously distinguishable — no `.next` mechanism existed |
| `.next` beside a corrupt primary | `journal.test.ts` › ".next handling on recovery" | same |
| stale lock pointing at a corrupt/fatal transaction | `journal.test.ts` › "stale lock cannot bypass…" | lock stolen, corrupt/fatal transaction bypassed |
| `append` patch staged for a tuning profile | `save-classification.test.ts` › "an append patch is refused…" | silently dropped, `plan.ok === true` |
| `remove` patch staged for a tuning profile | `save-classification.test.ts` › "a remove patch is refused…" | silently dropped, `plan.ok === true` |
| mixed `set` + `append` staged for a tuning profile | `save-classification.test.ts` › "a mixed set + append request…" | the `set` published, the `append` silently dropped |
| `set` to a non-existent path staged for a tuning profile | `save-classification.test.ts` › "a set to a path the parent does not have…" | published anyway (no path check existed) |
| mixed real save (behaviour+clip+motion-set), final journal write throws | `save-destination.test.ts` › Scenario 1 | same as the unit-level case, exercised through a real `planSaveAnimationChanges` plan and on-disk transaction |
| foreign file at a real new-clip-version path | `save-destination.test.ts` › Scenario 2 | same |
| corrupt journal at (simulated) API startup | `save-destination.test.ts` › Scenario 3 | `recoverRepository` throws |
| structural patch via a real tuning-profile save request | `save-destination.test.ts` › Scenario 4 | silently dropped |

### Individual result detail

- **Final journal failure**: canonical files absent after rollback,
  `project.json` byte-identical, `result.state !== 'validation-refused'`,
  transaction-directory evidence preserved.
- **Foreign create collision**: foreign bytes byte-identical after the
  attempt, `result.issues` contains `rollback-incomplete`.
- **Corrupt journal**: `recoverRepository` does not throw,
  `result.readOnly === true`, corrupt directory preserved, message contains
  `journal-corrupt`.
- **Tuning refusal**: `plan.ok === false`, `status === 409`, no asset in
  `plan.assets` (the refusal shape has no `assets`/`assignment` field at
  all), tuning directory on disk unchanged.

## All command exit codes (final head)

| Command | Exit | Result |
| --- | --- | --- |
| `pnpm typecheck` | 0 | clean |
| `pnpm lint` | 0 | clean |
| `pnpm schema:generate` | 0 | 38 files, no drift |
| `pnpm assets:animation:index` | 0 | 76 asset versions, index hash unchanged |
| `pnpm unity:export` | 0 | 25 files |
| `pnpm harness:check` | 0 | 5/5 |
| `pnpm harness:animation-assets` | 0 | 7/7 |
| `pnpm harness:unit` | 0 | 252/252 |
| `pnpm harness:integration` | 0 | 87/87 |
| `pnpm harness:replay` | 0 | 91/91 |
| `npx tsx harness/shadow-compare.ts` | 0 | 9/9 identical |
| `pnpm harness:repo-guard` | 0 | 8/8 |
| `pnpm build` | 0 | pass |
| `pnpm harness:visual` (standalone, see note) | 1 | 112/114 |
| `pnpm harness:one-shot` (run 1) | 0 | 26/26 stages, including visual 114/114 |
| `pnpm harness:one-shot` (run 2) | see below |
| `git diff --check` | 0 | clean |
| `git status --short` | — | clean except intended report/PR-evidence files |

**Note on the standalone visual run vs. one-shot's internal visual stage:**
a standalone `pnpm harness:visual` run failed 2/114
(`chamber.spec.ts:232 editing a transition updates the preview and the
diff` on mobile-landscape, `animation-assets.spec.ts:37 lists the migrated
assets and filters by type` on narrow); the very next run, as the last
stage of a clean `harness:one-shot`, passed all 114. Neither failing test
touches the repository-transaction or animation-save code this work package
changes (chamber's transition-preview panel and the asset library's
list/filter view). This matches the existing foundation-hardening report's
documented observation that this container's performance varies
significantly run to run and that not every visual test was converted to
the fixed-tick driver — treated as flaky/environment-sensitive, not a
regression from this work, and not masked: both runs are reported here in
full, not just the passing one.

## One-shot run 1

Started 2026-08-01T06:27:48.788Z, duration 1033.6s (~17.2 min), **26/26
stages passed**, including `visual (playwright)` 114/114 in 984.6s. Report:
`reports/one-shot-report.md` (regenerated on every run — see run 2 below).

## One-shot run 2

**PENDING at this commit.** Run 1 above passed cleanly (26/26 stages); a
second, immediately-following run was started in the background to satisfy
the "two consecutive one-shot runs must pass" requirement before this work
is declared complete. This section, and the Final Declaration below, will
be updated with the result — and this notice removed — in a follow-up
commit on this same branch once that run finishes (~15-20 minutes for the
visual/Playwright stage). No PASS is claimed here until it does.

## Generated-artifact drift check

A second generator pass (`pnpm schema:generate && pnpm assets:animation:index
&& pnpm unity:export`) after run 1 produced **zero** `git status` diff:
same 38 schema files, same asset-index hash (`7e24da4dc7d7`), same 25 Unity
export files.

## Known non-blocking limitations

1. **Two visual tests are flaky under this container's load**, per the note
   above — pass in the one-shot run recorded here, failed in a standalone
   run minutes earlier under otherwise-identical code. Not caused by this
   work package (neither touches `packages/repository-transaction`,
   `packages/animation-asset-runtime/src/save.ts`, or the tuning-profile UI
   guard). Consistent with the foundation-hardening report's own note on
   container performance variance.
2. **Commit-history bisectability**: tests for a given WP occasionally land
   in the same commit as that WP's fix rather than a strictly preceding
   red-test-only commit, where the test's fault-injection mechanism itself
   depends on the fix under test (see "Commit sequence" above for the
   specific case — WP-02's fault injection targets the `.next` temp file
   WP-04 introduces). Every new test was independently confirmed to fail
   against the pre-fix source via `git stash` before being confirmed to
   pass with it; this is recorded per-scenario in the fault injection
   matrix above.

## Vercel

GitHub commit status on this branch's head: **failure** — context
`Vercel`, deployment `dpl_8JMDKbQZG4BHSup2FxFGb5QLkVvy` under the Vercel
project **`animation-test-chamber-api`**
(`vercel.com/nutraloxides-projects/animation-test-chamber-api`).

Investigated, not fixed from the repository — reasons:

- The repository's only `vercel.json` (root) builds and deploys
  **`apps/web`** as a static bundle (`buildCommand: pnpm build`,
  `outputDirectory: apps/web/dist`) — confirmed passing locally in every
  run in this report (`pnpm build`, exit 0).
- `apps/api` (`@hono/node-server`, `serve()` bound to a persistent process)
  has **no** `vercel.json`, **no** `build` script in its `package.json`,
  and **no** serverless-function adapter (`export default`, `@vercel/node`,
  or an `api/` handler directory) anywhere in the package — it is not
  structured to run as a Vercel deployment at all.
- `README.md`'s own "Deploying to Vercel" section is explicit: *"Vercel
  serves static files only; there is no Hono server behind the
  deployment."* Publish/write/commit/export features are documented as
  disabled on that deployment by design, with the reason on the button —
  not a gap this work is meant to close.
- The failing check's target project is literally named
  `animation-test-chamber-api` — a second Vercel project, distinct from
  whichever one is correctly building `apps/web`, apparently pointed at
  this same repository without a compatible build configuration for
  `apps/api`. Vercel's dashboard/API were not reachable from this session
  (`vercel.com/.../8JMDKbQZG4BHSup2FxFGb5QLkVvy` returned 403 — Vercel
  authentication, unavailable here) to confirm the exact Root
  Directory/Framework setting, but every signal available from the
  repository points at the same conclusion: this is a Vercel *project*
  configuration issue, external to the repository, not a source or build
  defect.

Per the work package's own rule (§7.6): "do not redesign deployment." Adding
a serverless adapter to `apps/api` so a second Vercel project could deploy
it would be exactly that — a deployment-architecture change beyond this
work package's scope, and contrary to the repository's documented design
(static-only Vercel deployment, full API only via `pnpm dev`/self-hosting).

**Recommended external fix** (for whoever holds the Vercel dashboard): either
delete/disconnect the `animation-test-chamber-api` project, or fix its Root
Directory and build settings so it also deploys `apps/web` the same way the
correctly-configured project does — nothing in the repository needs to
change for either option.

**Vercel: EXTERNALLY BLOCKED WITH DOCUMENTED REASON.**

## Final declaration

**PENDING** — withheld until one-shot run 2 (above) completes and confirms
a second consecutive clean pass. Every other section in this report reflects
real, already-completed command runs (nothing here is fabricated ahead of
its evidence); only the final declaration line waits on run 2. See the
follow-up commit on this branch for the completed declaration.
