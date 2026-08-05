# Phase 11B acceptance closure

Work package: `WP_PHASE_11B_ACCEPTANCE_CLOSURE_AND_VISUAL_GATE_RECOVERY.md`
Branch: `claude/edit-rig-scene-controllable-character`

```text
Start SHA:               0b4070602bbdfc9d2417804953955b779b0d39fe
Merge base with main:    2e5b2a21a269f41aad7f14c00b0cded91233f33f   (verified, unchanged)
removed-world-alt:       never fetched, merged or read
main:                    never merged or rebased into this branch
```

Every result below was observed on this container. Nothing is projected from a
diff, and manual browser observation is recorded as manual, never as a passing
automated test.

---

## 1. What each workstream changed

### B — the complete Apply request is runtime-schema validated

The endpoint parsed JSON and then read it through
`raw as Partial<RepositoryApplyRequestBody>`. Only each `SceneOperation` went
through a runtime schema; `target`, `expected`, `actor`, `intent` and the
approval metadata were checked by a cast.

`packages/schema/src/repository-apply.ts` now declares
`RepositoryDocumentTarget`, `RepositoryApplyExpected`, `ProtectionApproval`,
`RepositoryApplyRequest` and the `RepositoryApplyStatus` union, every object
boundary `additionalProperties: false`. The TypeScript types are `Static<>`
derivations of those schemas — not a parallel set of interfaces —
and `RepositoryDocumentTarget` moved out of `@atc/editor-core`, which now
re-exports it.

`parseRepositoryApplyRequest` (`packages/editor-core/src/apply-request.ts`)
checks outermost-first, because a failed Ajv union reports every member's
failure at once: a request with one misspelled field came back as a dozen
complaints, none of which named the misspelling.

`unlockedPaths` and `approved` are **removed from the network contract**. A
local UI unlock is a gesture in front of one control in one browser, not a
server authorization artifact; a bare `approved: true` names nothing, so it
cannot be checked against what the operations turned out to do. Both are now
refused rather than ignored — a caller that believes it is authorising
something has to be told it is not.

### C — exact-path human protection approval

The server replays each operation against the document as it stood **before**
that operation, resolves the protection level of every changed path, and
collects the ones requiring an unlock or an approval.

```text
actor = ai                          approval must be absent; any protected path refused
actor = human, none protected       approval must be absent
actor = human, some protected       approval required, exactly equal to the server's set
invariant                           refused unconditionally, whatever the approval says
```

Comparison is on sorted, deduplicated lists. Missing, extra, prefix and
unrelated approvals are refused; duplicates are refused earlier by the schema's
`uniqueItems`. The Apply report records `protectionApproval: { approvedPaths,
reason }` and never `approved: true`.

### D — prepared-view validation, and outcomes that are not all conflicts

`validatePreparedView` was `() => ({ issues: [] })`, justified on the grounds
that the in-memory candidate had already been validated. The hole: what was
validated is the object the process holds; what gets promoted is bytes that were
serialised, written and fsynced.

It now reads `projects/demo-character/project.json` and the report **through the
prepared view**, parses both, validates the project and its references, resolves
the changed scene by stable id, validates its references, and cross-checks the
report's `applyId`, target, base and new revision against the prepared project
and the request. No canonical file moves before that passes.

Transaction states map to distinct outcomes rather than collapsing to 409:

| Transaction state | Status | HTTP |
| --- | --- | --- |
| `committed` | `applied` | 200 |
| (no canonical byte changes) | `no-change` | 200 |
| `conflict-refused` | `conflict` | 409 |
| `validation-refused` | `invalid` | 422 |
| protection / approval refusal | `invalid` | 403 |
| `rolled-back` | `rolled-back` | 500 |
| `fatal`, or `repository-unresolved` | `repository-read-only` | 503 |

The `repository-unresolved` row was found while building the fault tests. A
repository holding an unresolved transaction is reported by the lock as
`conflict-refused`, and the endpoint was turning that into a 409 — telling the
one user who must stop that they should reload and retry.

### E — no-change, from the operation to the status line

`DocumentEditSession.dispatch` refuses to record an operation that produces the
document already there: no history entry, no pending operation, no dirty state,
nothing staged. Compared semantically (stable-key JSON), not by reference,
because the operation helpers rebuild objects with spread even when every leaf
is unchanged.

The server answers `status: 'no-change'` with no project write, no report, no
transaction directory and no revision bump. The UI renders `NO CHANGE`, never
`APPLIED`.

### A — the browser adopts the returned canonical Project

`useSceneSession` moved the session's private revision and left the store's
`canonicalProject` holding pre-Apply data. Every direct `DocumentEditSession`
test still passed, because the session was correct; the *application* held a
document that was no longer on disk.

`adoptAppliedProject(project)` takes the exact `ProjectDefinition` the server
returned, makes it canonical and rebuilds the resolved project in one
synchronous `set`. It is called in the same turn as `acceptApplied`, so no
render observes one baseline moving without the other. The Scene toolbar now
shows both revisions side by side — two numbers that must always match are much
harder to get wrong than one number nobody can see.

### F — one history model

Undo/redo/staging were three parallel arrays related by object identity.
`rebuildStagedPaths` looked an operation up in `pendingPaths` with `===`, so an
undone operation contributed no paths and two structurally identical operations
were indistinguishable.

One entry per operation now carries `staged` and `stagedBeforeUndo`. Redo
restores the staged status the operation had before Undo. `acceptApplied`
requires the revision — a caller that omits it fails typecheck.

### G — collision-safe Apply reports

Report paths were derived from the new content revision and written with
`mode: create`. Content revisions legitimately repeat (A → B → A → B reaches
bytes that already existed), so the third Apply collided with the first report
and failed. Reports carry `applyId = randomUUID()`; the project stays identified
by its content. `applyId` is not an input to the revision hash.

### H — the real endpoint under faults

Sixteen cases through `POST /api/repository/apply` against real temporary
checkouts, with faults injected into the same `transactionOptions.fs` seam the
production runtime uses. Two of them — corrupting the prepared project bytes,
and contradicting the prepared report — commit cleanly under the old no-op
validator, which is what makes them worth having.

### I — the Playwright navigation failure

Diagnosed rather than worked around. Findings, in order:

```text
pathname changes                    history.pushState is called by react-router's Link
no page reload                      load event count unchanged
no console or page error            nothing logged at all
useLocation() does not update       a probe inside BrowserRouter never re-rendered
history.listen IS subscribed        popstate registered twice (StrictMode mount/remount)
StrictMode is not the cause         disabling it changes nothing
useTransitions={false} fixes it     probe re-renders, route target updates
```

React Router v7 commits the location inside `React.startTransition`. That is the
right default when routes suspend, but this app has no lazy routes and no
route-level Suspense — and the chamber polls the engine into React state every
100 ms (`App.tsx:71`) while a full chamber render under software-rendered WebGL
takes longer than that. Every poll preempted the in-flight transition and
restarted it, so the location update never committed while the address bar had
already moved.

`useTransitions` is a typed, documented prop on `BrowserRouterProps`. Client-side
navigation is unchanged; only the priority of the location update moved. No
`window.location.href`, and no test rewritten to `page.goto`.

### J — visual repository isolation

`pnpm harness:visual` runs `harness/visual.ts`, which seeds a throwaway
checkout, picks a free port pair, starts the API with `ATC_REPO_ROOT` pointed at
it, runs Playwright, and then proves the source checkout did not move. Nothing
is mocked: the production code path, the transaction engine and the file writes
are all real.

Free ports rather than 8787/5173, and `reuseExistingServer` off when isolated —
otherwise the isolated run finds the developer's own API already listening and
reuses it, writing through the real endpoint into the repository the isolation
exists to protect. The clean-tree check also covers `.chamber-transactions/`,
which is gitignored: a leak there is invisible to `git status` and makes the
next API process start read-only.

`harness:one-shot` runs the wrapper, not `playwright test`, because the visual
stage was corrupting the inputs of the stages that ran before it.

---

## 2. Status of every acceptance item

Legend: **tested** = an automated check fails if it regresses. **implemented** =
in the code, covered indirectly. **manual** = observed by hand only.

| # | Item | State | Evidence |
| --- | --- | --- | --- |
| 1 | Branch identity | tested | §0 checks re-run; tip and merge base match |
| 2 | Complete request runtime-schema validated | tested | `request schema` (28 cases) |
| 3 | Every object boundary rejects unknown properties | tested | unknown top-level / target / expected / approval / operation |
| 4 | Client `unlockedPaths` removed from the contract | tested | legacy `unlockedPaths` and `approved` both 400 |
| 5 | Protected paths computed by the server | tested | `exact-path protection approval` |
| 6 | AI cannot attach approval | tested | AI request carrying approval → 403 |
| 7 | Human approval is exact-path and reasoned | tested | exact approval accepted; blank reason 400 |
| 8 | Extra / missing / duplicate / unrelated approvals refused | tested | five cases, all 400 or 403 |
| 9 | Reports record exact approval evidence | tested | report equals `{approvedPaths, reason}`; no `approved` |
| 10 | Prepared-view reads and validates project bytes | tested | truncated prepared project → 422, no promotion |
| 11 | Prepared-view reads and cross-checks report bytes | tested | contradictory report revision → 422 |
| 12 | Outcomes not collapsed into generic conflict | tested | applied / no-change / conflict / invalid / rolled-back / read-only |
| 13 | No-change has explicit server and client status | tested | integration + `apply-round-trip.spec.ts` |
| 14 | Empty / no-op Apply writes nothing | tested | no project, report or transaction directory |
| 15 | Same-value local operations create no history | tested | `an operation that changes nothing is not history` |
| 16 | `canonicalProject` becomes the returned Project | tested | repository and base revision agree after Apply |
| 17 | Route re-entry after Apply resolves the applied Scene | tested | client-side out and back via history |
| 18 | Two Applies succeed without reload | tested | integration + browser |
| 19 | External movement produces a real conflict | tested | integration + browser |
| 20 | Staged Undo removes the operation from Apply | tested | `undo, redo and staging agree` |
| 21 | Redo restores the prior staged status | tested | staged and unstaged round trips, both directions |
| 22 | Unrelated staged operations survive Undo | tested | A staged, B undone, A intact |
| 23 | `acceptApplied` requires a revision | tested | compile-time; omitting it fails typecheck |
| 24 | Report identity cannot collide | tested | A→B→A→B, three unique reports, one revision |
| 25 | Fault tests call the real HTTP endpoint | tested | 16 cases, all through `app.request` |
| 26 | Report-promotion failure restores the project | tested | byte-identical, no report |
| 27 | Uncertifiable rollback → read-only | tested | 503, lock held, next write refused |
| 28 | Client-side router navigation passes | tested | `client-side-navigation.spec.ts` |
| 29 | Asset Library select navigation passes | tested | same file, plus the original failing test |
| 30 | Visual tests use a disposable repository root | tested | `harness/visual.ts` |
| 31 | Visual tests leave the source checkout unchanged | tested | wrapper fails the run if not |
| 32 | Replay and animation-assets green after visual | tested | see §3 |

---

## 3. Command evidence

Two `pnpm harness:one-shot` runs, back to back, no edit to the tree between
them. The second started from a fully committed, clean checkout.

```text
run 1   31/31 stages passed in 1220.0s     exit 0
run 2   31/31 stages passed in 1292.6s     exit 0

typecheck / lint                          pass
schema generation drift                   pass   (4 new schemas committed)
canonical data validity                   pass
transaction recovery                      pass
world contract / capability completeness  pass
unit                20 files    450 passed
integration         15 files    221 passed
replay               5 files    129 passed
repo guard                      11/11
web build                       pass
visual                          174 passed   (19.2m / 20.5m)
                                desktop + mobile-landscape + narrow

[visual] source checkout unchanged; disposable repository removed.

git status --short after run 1    clean
git status --short after run 2    clean
```

Three lines there were not true at `0b40706`:

- **174 passed**, where it was 144 passed / 3 failed. The three failures were
  the same client-side navigation test on all three projects. The suite also
  grew by 27 cases (12 navigation, 15 Apply round-trip), so the number moved for
  two reasons.
- **`source checkout unchanged`.** The visual stage used to write through the
  real API into the canonical demo project, turning `replay` and
  `animation-assets` red for every later run. Both are green *inside the same
  one-shot*, after the visual stage, with nothing restored by hand.
- **Clean tree after both runs.** §17 is explicit that a passing one-shot which
  leaves canonical fixtures modified is not a pass.

An earlier one-shot attempt was abandoned rather than reported: a source file
was edited while its visual stage was running, and the dev server hot-reloads,
so the result would not have been evidence of anything. It is not counted above.

The full declaration matrix is in
`agents/handoffs/route-scoped-editor-finalization.md` §6.3.

---

## 4. Known limitations

- **The browser seeds `canonicalProject` from a compile-time import.**
  `store.ts` imports `@chamber/project` directly, so a fresh page load starts
  from the bundled snapshot rather than from the repository. After an Apply the
  store is correct (that is workstream A), but a *reload* returns to the seed,
  and a change applied by someone else is not visible until something triggers
  `reloadAssets`. This is pre-existing and out of scope for 11B; it is why
  `apply-round-trip.spec.ts` restores the disposable project between tests. It
  is worth a decision in its own right.

- **`apps/api/src/routes/animation-assets.ts` calls `loadProject()` with no
  root**, falling back to the module-level `REPO_ROOT`. Correct under
  `ATC_REPO_ROOT` (which sets that constant), but a test that constructs an app
  with an explicit `repoRoot` gets the real checkout from that route. Not
  touched here because no acceptance item depends on it.

- **`useTransitions={false}` is a deliberate trade.** If route-level Suspense is
  introduced later, the previous screen will no longer be held while the next
  one loads, and that decision should be revisited then rather than rediscovered.

- The independent final architecture review (Task I) is **not** performed here.
  This package is an implementation task.
