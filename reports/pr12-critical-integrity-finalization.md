# PR #12 critical integrity finalization

Four failure modes the foundation-hardening pass left open, and the evidence
that they are closed. Nothing here redesigns the asset model, the transaction
architecture, the runtime or the replay fixtures; every change is inside the
boundary those already drew.

| | |
| --- | --- |
| Repository | `NutraloxidE/animation-test-chamber` |
| Pull request | #12 |
| Base SHA | `30f39724e6eb544520c7c39598acc7dbffd22104` |
| Starting head SHA | `21cf0ff946a2e0fa062446a6e01a3c2bc6399e11` |
| Final head SHA | `1c885b9cb558fa862739ce67c35deadf7ff37ae9` |
| Branch | `claude/pr-12-continuation-0cpio7`, branched from PR #12's head |
| Baseline | `reports/pr12-critical-finalization-baseline.md` |

The work package named `e0a64a9` as the last reviewed head; the remote had
moved on to `21cf0ff`, which was taken as canonical without reset or force
push.

## Work package matrix

| WP | Subject | Result |
| --- | --- | --- |
| WP-01 | Reproduce remaining fatal paths | **done** — 4 failure modes, each red before its fix |
| WP-02 | Point-of-no-return transaction safety | **done** |
| WP-03 | Ownership-safe create rollback | **done** |
| WP-04 | Atomic and corruption-safe journal | **done** |
| WP-05 | Explicit tuning patch refusal | **done** |
| WP-06 | Integrated recovery and HTTP verification | **done** |
| WP-07 | Harness, reports, PR synchronisation | **done** |

## What was wrong, and what it is now

### P1-A — a failure after the point of no return reported that nothing had happened

`runRepositoryTransaction` guarded the renames and the hash verification, and
left two journal writes outside that guard: `state=promoting`, which is what
makes a crash recoverable at all, and `state=committed`, which is what makes
the promotion true. A failure in either fell to the outer catch, which deleted
the transaction directory and returned `validation-refused` — a state whose
meaning is "the repository is exactly as you left it", asserted at the one
moment that cannot be said. Rollback's own journal write then failed the same
way, so the evidence went with it.

Both writes are inside the guard now, behind a single `promotionStarted` flag
that is the only expression of the boundary in the code. After it is set the
outcomes are `committed`, `rolled-back` or `fatal`; the outer catch no longer
cleans up or refuses. `fatal` — rollback reported unrestored paths, or threw
partway — keeps the transaction directory, because it is the only record of
which files are in doubt, and keeps the write lock, because the next writer
must not build on a repository nobody can describe.

### P1-B — create rollback deleted files it did not own

Undoing a create means deleting a file: the one rollback action that destroys
data rather than restoring it. The check guarding it was that *something* was
at the path. That is true of a file another process created in the window
between the prepare-time absence check and promotion, and true of one we
promoted that has since been rewritten.

A create target is now removed only where the transaction can prove the bytes
are its own — it recorded promoting them, and sha256 of what is there still
matches the prepared hash it wrote. Everything else is left alone and recorded
as unrestored, so the outcome is fatal, the repository goes read-only, and the
file survives for whoever it belongs to. `TransactionFatal.reasons` carries a
code per path (`ownership-unknown`, `content-changed-after-promotion`,
`backup-missing`, `restore-hash-mismatch`, `remove-failed`,
`replace-without-original`); it is optional, so existing consumers are
unaffected.

### P1-C — a torn journal crashed startup recovery

The journal was written straight over itself and read back through a bare
`JSON.parse`. A crash inside that write left a prefix of JSON at the path
recovery reads first — so the one situation the journal exists for was the
situation in which recovery threw and the server could not boot.

Writes now go to `journal.json.next`, are fsynced, and are renamed over the
primary, so a reader sees the old journal or the new one and never half of
either. `readJournal` returns `missing | valid | corrupt` instead of
`null | object`, and never throws. Recovery treats every ambiguity
conservatively and preserves the evidence:

| On disk | Outcome |
| --- | --- |
| corrupt primary | fatal, read-only, directory untouched |
| no primary, `.next` present | fatal — whether the rename happened is exactly what is unknown |
| corrupt primary + valid `.next` | fatal, both preserved, no auto-promotion |
| valid primary + `.next` | the temp file is a write that never landed; dropped |

A stale write lock is no longer taken over when the transaction holding it is
corrupt, fatal, or rolls back to fatal.

### P1-D — a tuning save dropped structural patches and called it success

`planSaveAnimationChanges` ran `graphPatches.filter(p => p.op === 'set')` and
published whatever survived. An append or a remove was dropped and the request
reported as a success.

A tuning-profile save is now checked before anything is built. A patch it
cannot store refuses the whole request with 409 and one issue per offending
patch (`unsupported-tuning-patch`); publishing only the storable subset would
be saving an edit nobody asked for. `set` is checked too, by trial-applying the
patches to the resolved behaviour on top of the profile's existing patches with
the same `requireExistingPath` the resolver uses — a path that does not exist
is refused as `invalid-patch-path`. Refusal happens before any asset is
constructed, so no version is created and no transaction is started. The
dialog disables the tuning destination when the staged edit is structural, as a
courtesy; the server refusal is the authority.

## Fault injection matrix

Every row is a test that fails on the pre-fix code and passes after it.

| Injected failure | Point | Expected | File |
| --- | --- | --- | --- |
| journal write, `state=promoting` | before any rename | not `validation-refused`; repository unchanged | `transaction.test.ts` |
| journal write, first promoted entry | after 1 of 3 renames | prior promoted file rolled back | `transaction.test.ts` |
| journal write, `state=committed` | after every rename and hash check | `rolled-back`; project byte-identical; new files absent | `transaction.test.ts` |
| journal write + destroyed backup | after promotion | evidence preserved; not `validation-refused` | `transaction.test.ts` |
| foreign file created at a create target | between prepare and promote | foreign bytes byte-identical; not deleted; read-only | `transaction.test.ts` |
| create target rewritten after promotion | during rollback | not deleted; `content-changed-after-promotion`; read-only | `transaction.test.ts` |
| post-promotion hash mismatch | verification | replace restored; create left; fatal | `transaction.test.ts` |
| temp journal write fails | any journal update | previous primary journal still valid | `journal.test.ts` |
| torn `journal.json` | startup recovery | no throw; read-only; `journal-corrupt`; directory preserved | `journal.test.ts` |
| orphan `.next`, three combinations | startup recovery | conservative in each case | `journal.test.ts` |
| stale lock over a corrupt transaction | lock acquisition | not stolen; repository unchanged | `journal.test.ts` |
| journal write, `state=committed` | real mixed publication | every new version file gone; project byte-identical | `save-destination.test.ts` |
| foreign file at a planned version path | real mixed publication | foreign bytes survive; read-only | `save-destination.test.ts` |

Named outcomes:

```text
final committed journal failure   rolled-back, project byte-identical, no new version files
foreign create collision          foreign bytes untouched, recovery readOnly = true
corrupt journal                   recoverRepository returns readOnly = true, outcome fatal,
                                  message contains journal-corrupt, directory preserved
tuning structural refusal         HTTP 409, unsupported-tuning-patch, no asset, no transaction
```

## Files changed

```text
packages/repository-transaction/src/transaction.ts    point of no return, fatal outcome, single lock release
packages/repository-transaction/src/rollback.ts       ownership-safe create removal, per-path fatal reasons
packages/repository-transaction/src/journal.ts        atomic write, structured read, journalNextFilePath
packages/repository-transaction/src/recovery.ts       corrupt and orphan-.next handling
packages/repository-transaction/src/lock.ts           stale lock cannot bypass an unresolved transaction
packages/repository-transaction/src/filesystem.ts     fsyncDirectory
packages/repository-transaction/src/types.ts          fatal state, TransactionFatal reasons
packages/repository-transaction/src/index.ts          exports
packages/animation-asset-runtime/src/save.ts          tuning refusal replaces the silent filter
packages/schema/src/animation-assets.ts               unsupported-tuning-patch issue code
apps/api/src/read-only-guard.ts                       extracted so the 503 rule is testable
apps/api/src/server.ts                                uses it
apps/web/src/store.ts                                 structural-patch count, tuning option disabled
.vercelignore                                         stop excluding a build input
tests/integration/repository-transaction/transaction.test.ts
tests/integration/repository-transaction/journal.test.ts
tests/integration/animation-assets/save-destination.test.ts
tests/unit/animation-assets/save-classification.test.ts
```

## Verification

Every command run on the finalized head, with its exit code.

| Command | Exit | Result |
| --- | --- | --- |
| `pnpm typecheck` | 0 | clean |
| `pnpm lint` | 0 | clean |
| `pnpm schema:generate` | 0 | no drift |
| `npx tsx harness/generate-animation-asset-index.ts` | 0 | no drift |
| `pnpm unity:export` | 0 | no drift |
| `pnpm harness:check` | 0 | 5/5 |
| `npx tsx harness/check-animation-assets.ts` | 0 | 7/7 |
| `npx tsx harness/check-transaction-recovery.ts` | 0 | clean and idempotent |
| `pnpm harness:unit` | 0 | **253/253**, 12 files |
| `pnpm harness:integration` | 0 | **90/90**, 6 files |
| `pnpm harness:replay` | 0 | **91/91**, 3 files |
| `npx tsx harness/shadow-compare.ts` | 0 | 9 replays identical to the legacy runtime |
| `pnpm harness:repo-guard` | 0 | 8/8 |
| `pnpm build` | 0 | `apps/web/dist` written |
| `pnpm harness:visual` | 0 | **114/114** (38 tests × desktop / mobile-landscape / 320px) in 13.2m |
| `pnpm harness:one-shot` (run 1) | 0 | **26/26 stages** in 782.0s |
| `pnpm harness:one-shot` (run 2) | 0 | **26/26 stages** in 763.6s |
| `git diff --check` | 0 | clean |

434 headless tests, up from 379 at `21cf0ff` — 55 added across the four failure
modes and the end-to-end scenarios. None deleted, skipped or weakened;
repo-guard's "no tests deleted or weakened" stage passes.

One pre-existing test changed its expectation rather than its strength:
`failure surfaced during post-promotion hash verification…` asserted that a
create target whose bytes no longer match what we promoted is deleted and the
transaction reports `rolled-back`. Under the ownership rule that file is not
ours to delete, so it now asserts the stronger outcome — the replace is restored
byte-for-byte, the create survives, the result is `fatal` and recovery reports
read-only.

**Two consecutive one-shot runs passed**, both 26/26. After each, the working
tree contained only this pass's uncommitted documentation edits — no canonical
data drift.

**Second generator pass**: running `pnpm schema:generate`,
`harness/generate-animation-asset-index.ts` and `pnpm unity:export` again
produces no change to any tracked file.

## Vercel

The PR's only reported check is a Vercel deployment on the project
`animation-test-chamber-api`, failing since the PR opened. PR #11 (`c0f4067`)
succeeded on the same project, so the failure arrived with this branch rather
than with the deployment configuration — which made it worth diagnosing rather
than attributing to the environment.

The cause is in this repository. This branch made the chamber import
`generated/animation-assets/library-index.json` as `@chamber/animation-assets`,
so it resolves assets on a static host with no API. `.vercelignore` excluded
`generated/` wholesale, on the reasoning that nothing under it is read by
`pnpm build` — true when that line was written, false once the import existed.
The file became a build input while still being treated as an output. Local
builds never showed it, because locally the file is simply there; only the
deploy upload was missing it.

Reproduced by moving `generated/` aside and building, which fails with the same
ENOENT vite reports, and verified by building a copy of the tree pruned exactly
as `.vercelignore` prunes it — which fails before the change and succeeds
after. `generated/unity/` stays excluded; that really is output nothing reads
at build time.

The fix is one line and no deployment configuration was touched. Whether the
`-api` Vercel project should be building the web bundle at all is a separate
question, external to this repository, and is left alone.

## Follow-up — fatal same-process lockdown

A second pass on branch `claude/new-session-taf91p`, after the work above had
landed. The transaction engine's half of the fatal contract was already
correct: an incomplete rollback returns `state: 'fatal'`, keeps its journal and
does not release the write lock. What was not established is what the *running
API* did with that.

### What was still open

```text
transaction returns fatal
  -> journal preserved, write lock preserved
  -> but the API's read-only flag was `startupRecovery.readOnly`, a boot-time const
  -> so the same process still believed it could write
  -> and the next POST was refused only by the lock, one layer too late
```

The refusal by lock is real, but it happens *after* a second transaction has
started, and it is reported as an ordinary 409 conflict — advice to retry, at
the one moment retrying is wrong. Restarting the process was the only thing
that produced an honest read-only API.

### What it is now

`apps/api/src/repository-health.ts` holds one mutable `RepositoryHealth` per
process: `readOnly`, `reason`, `fatalTransactionId`. It is seeded from startup
recovery and flipped by `markRepositoryFatal` the moment a transaction returns
`fatal`. The flip is one-way — only a human resolving
`.chamber-transactions/`, and the next startup recovery, can clear it.

The marking lives in the transaction adapter (`apps/api/src/transaction.ts`),
not in each route, so no write endpoint can return a fatal outcome without the
process actually having gone read-only. `TransactionResult` now carries the
engine's `state` through, and `transactionStatus` maps `fatal` to 503 rather
than 409.

The read-only middleware reads that object per request instead of a constant,
so the write after a fatal transaction is refused before a route runs, before a
plan is built, and before a second transaction directory exists. Its body names
the fatal transaction and the reason; `GET /api/health` reports the same three
fields. GET is untouched: a repository nobody can write to is exactly the one a
human needs to be able to look at.

Route construction moved from `server.ts` into `createApp` (`apps/api/src/app.ts`).
`server.ts` binds a port as a side effect of import, which made the middleware
untestable — and whether a process that just went fatal refuses the next write
is not a claim worth making against a mock.

### One defect found while testing

`listTransactionIds` derived transaction ids from the first path segment of
every file under `.chamber-transactions/`. `write.lock` lives directly in that
root, so recovery saw it as a transaction directory with no journal, classified
it as abandoned and removed it. **The next startup after a fatal transaction
deleted the very lock that transaction was holding.** Only nested paths name a
transaction now, and the restart test asserts the lock survives recovery.

### Evidence

| Claim | Where |
| --- | --- |
| fatal keeps the lock, pointed at the fatal transaction id | `tests/integration/repository-transaction/transaction.test.ts` — *fatal lockdown* |
| a second transaction is refused with `write-lock-held` | same |
| the stale-lock timeout does not steal a fatal lock | same |
| committed / validation-refused / clean rollback all release the lock | same |
| a fatal save answers 503 with `state: fatal` and a transaction id | `tests/integration/api/repository-read-only.test.ts` |
| health flips read-only in the same process, no restart | same |
| the next POST is 503, with no new transaction directory | same |
| POST/PUT/PATCH/DELETE blocked across `/api/*` write routes | same |
| GET health, project and resolved-project stay 200 | same |
| a fresh process over the same checkout starts read-only, lock intact | same |
| a clean save and a refused save leave the process writable | same |

Fault shape: a second writer publishes its own *valid* version at a path the
transaction has already promoted. Post-promotion verification catches the
mismatch and rollback refuses to delete bytes that are not its own — the real
route to `fatal`, not a thrown error standing in for one. The foreign document
is valid on purpose, so "reads still work afterwards" is proven rather than
sidestepped by a file that would break them anyway.

### Follow-up verification

Every command run on `3cb9512` + the follow-up head, with its exit code.

| Command | Exit | Result |
| --- | --- | --- |
| `pnpm typecheck` | 0 | clean |
| `pnpm lint` | 0 | clean |
| `pnpm harness:check` | 0 | 5/5 |
| `pnpm harness:animation-assets` | 0 | 7/7 |
| `pnpm harness:unit` | 0 | **253/253**, 12 files |
| `pnpm harness:integration` | 0 | **98/98**, 7 files |
| `pnpm harness:replay` | 0 | **91/91**, 3 files |
| `npx tsx harness/shadow-compare.ts` | 0 | 9 replays identical to the legacy runtime |
| `pnpm harness:repo-guard` | 0 | 8/8 |
| `pnpm build` | 0 | `apps/web/dist` written |
| `pnpm harness:visual` | 0 | **114/114** in 15.6m |
| `pnpm harness:one-shot` (run 1) | 0 | **26/26 stages** in 1013.0s |
| `pnpm harness:one-shot` (run 2) | 0 | **26/26 stages** in 1060.1s |
| `git diff --check` | 0 | clean |
| `git status --short` | — | clean after every run above |

Integration goes from 90 to 98: eight tests added, none deleted, skipped or
weakened. Three cover the lock contract at the package level and five the
same-process API lockdown.

Two earlier visual attempts are recorded rather than dropped. The first was
killed by a 900-second cap this pass put on it — the suite takes longer than
that on this machine, so that was an operator error, not a result. The second
exited 1 with 24 passed and the remainder failing `ERR_CONNECTION_REFUSED`
against the Vite dev server on `127.0.0.1:5173`: the harness's own server died
partway through the run. Before re-running, `npx tsx apps/api/src/server.ts` was
started on its own and confirmed to boot and listen after the `createApp`
refactor, so the dead server was not this change. The third run, uncapped, was
114/114, and both one-shot runs — each of which runs the visual suite again —
passed 26/26.

### Follow-up files changed

```text
packages/repository-transaction/src/journal.ts   write.lock is not a transaction id
apps/api/src/repository-health.ts                mutable per-process read-only state
apps/api/src/runtime.ts                          repo root + health + transaction options
apps/api/src/read-only-guard.ts                  refusal body carries transaction id and reason
apps/api/src/app.ts                              routes as a value; live read-only middleware
apps/api/src/server.ts                           process entry point only
apps/api/src/transaction.ts                      state passthrough, fatal marking, 503 mapping
apps/api/src/routes/animation-assets.ts          runtime-scoped, fatal-aware status
apps/api/src/context.ts                          loaders accept a repository root
tests/integration/repository-transaction/transaction.test.ts
tests/integration/api/repository-read-only.test.ts
```

## Known non-blocking limitations

1. **The visual suite can rewrite canonical data.** Playwright starts the real
   API server, and the commit test drives `POST /api/commit`, which calls
   `saveProject`. During this pass that rewrote
   `projects/demo-character/project.json` to a new revision once — observed
   after the baseline run, restored, and not reproduced on the two subsequent
   runs from the same starting state, so what triggers it is not established
   here. It is enough to say that `git status --short` cannot be assumed clean
   after `pnpm harness:visual`, and that the tree was checked and restored after
   every run in this pass. The committed `project.json` on this branch is
   byte-identical to PR #12's head. Not fixed here: the fix is a decision about
   whether that test should drive the real commit path or a temporary checkout,
   which changes what the test covers.

2. **A `fatal` transaction holds the write lock deliberately.** Nothing in the
   same process can write afterwards, by design: the repository is in a state
   nobody can describe. As of the follow-up pass this is enforced by the API
   itself and not only by the lock — the process goes read-only immediately and
   the next write is refused with 503 before a transaction starts. Recovery at
   the next startup reaches the same verdict. There is no in-process "clear the
   fatal state" path, and adding one would mean deciding on a human's behalf
   that the files are fine.

3. **`Simulation.rootLocked()`** still uses the global recovery default when a
   clip authors none, as recorded in the earlier report. Unchanged here.

4. **Agent orchestration.** As recorded in
   `reports/animation-assets-one-shot-report.md`, the plan's subagent process
   was not followed on the original pass, and this pass did not use subagents
   either. Stated rather than papered over.

## Declaration

```text
PR #12 Critical Integrity Finalization: PASS

Point-of-No-Return Safety:            PASS
Ownership-safe Create Rollback:       PASS
Atomic Journal:                       PASS
Corruption-safe Recovery:             PASS
No Silent Tuning Patch Loss:          PASS
Integrated Fatal-path Verification:   PASS
Schema / Generated Artifacts:         PASS
Replay Compatibility:                 PASS
Visual Harness:                       PASS — 114/114
One-shot Run 1:                       PASS — 26/26
One-shot Run 2:                       PASS — 26/26
PR Evidence Synchronization:          PASS
Vercel:                               PASS — cause found in this repository and fixed
```

`PASS` is written only where the command was run and passed. The baseline
one-shot recorded in `reports/pr12-critical-finalization-baseline.md` failed
its visual stage 111/114; those three tests pass on the finalized head and
passed on both one-shot runs, and that baseline run overlapped this pass's own
edits and CPU load. The failures were load-sensitivity, not a defect on
`21cf0ff` — stated rather than quietly dropped.

The Vercel line reads PASS on the evidence available from inside the
repository: the failure is reproduced locally, the cause is a `.vercelignore`
entry in this repository, and the fix is verified by building a tree pruned
exactly as the deploy upload is pruned. It has not yet been observed green on
Vercel itself, which cannot happen until this branch is pushed and the
deployment re-runs.

## Follow-up declaration

```text
PR #12 Fatal-state Lockdown: PASS

Explicit Fatal State:            PASS — pre-existing on this branch, now covered by tests
Fatal Lock Preservation:         PASS
Runtime Read-only Transition:    PASS
Same-process Write Rejection:    PASS
Startup Recovery Rejection:      PASS
Read API Availability:           PASS
Fatal-path Integration Test:     PASS
Typecheck / Lint:                PASS
Unit / Integration / Replay:     PASS — 253 / 98 / 91
Shadow / Repo Guard / Build:     PASS
Visual Harness:                  PASS — 114/114
One-shot Run 1:                  PASS — 26/26
One-shot Run 2:                  PASS — 26/26
PR Evidence Synchronization:     PASS — these reports
Vercel Latest Head:              NOT VERIFIED
```

`PASS` is written only where the command was run and passed on this head.

Two lines are deliberately not `PASS`:

**Vercel latest head.** No deployment has run against this branch, so there is
nothing to observe. It is not reported green on the strength of the previous
pass's fix.

**Branch.** This work is on `claude/new-session-taf91p`, branched from
`a235603`. PR #12's head is `claude/new-session-9h6hb7` at `ce98520`, a
*different* line: the two have diverged (13 commits against 10) and implement
the earlier work package differently, so this branch is not PR #12's head and
PR #12's body was not edited to describe code that is not on it. The work
package asked for a push to `9h6hb7`; that was not done, because pushing to a
branch other than the designated one is not something this pass may decide on
its own.
