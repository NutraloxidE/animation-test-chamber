# Handoff — Route-Scoped Editor Finalization (continuation)

Work package: `WP_ROUTE_SCOPED_EDITOR_FINALIZATION_AND_HARDENING.md`
Branch: `claude/edit-rig-scene-controllable-character`

```text
Continuation start SHA:  d126b93db3a98664d2c3bba13b33a4a3f7c7642c
Current SHA:             see section 6 — this document has been continued twice
Base preserved:          yes — merge-base with origin/main is still 2e5b2a2
removed-world-alt:       never fetched, merged or read
```

**Sections 1–5 describe the state at `4aa107c` and are kept as written.**
Phase 11B has since been completed; **section 6 is the current record** and
supersedes the declaration in section 4.

Written to be picked up on another machine.

---

## 1. What this continuation completed

### Phase 11A — trace baseline resolution: DONE

The two harnesses that had been red since `2e5b2a2`, and which blocked Phase 11
for the whole of the previous work package, are green:

```text
pnpm harness:replay              129/129 tests, 5 files
pnpm harness:animation-assets    7/7 checks
```

Causality was proven in four isolated worktrees *before* the oracle was touched
(full detail in `reports/trace-baseline-resolution.md`):

| State | Configuration | Result |
| --- | --- | --- |
| A | `d4be2df` + committed oracle | 26/26 pass |
| B | `2e5b2a2` + committed oracle | 1 fail |
| C | `2e5b2a2` minus *only* the two overrides | 26/26 pass |
| D | `d4be2df` plus *only* the two overrides | byte-identical to B |

Invariants that did **not** move, across all 9 replays: `tickCount`,
`locomotionSequence`, `actionSequence`, and non-foot event identity and order.
Only foot-contact counts and travel distance changed, in the 6 replays that
travel — the direction both overrides (>1) predict.

New: `harness/generate-legacy-traces.ts`, `pnpm traces:generate`,
`pnpm traces:check`, `DECISIONS/0016-*.md`.

### Everything else on this branch (prior package, phases 0–10)

Routes, Scene schema + migration, `ControllableCharacter`, `SceneRuntime`,
`DocumentEditSession` + typed `SceneOperation`, `POST /api/repository/apply`,
three capability groups, Unity `IChamberScene`, World UI removed.

---

## 2. Full suite status at `4aa107c`

Run on this container, all passing:

```text
pnpm typecheck                    PASS
pnpm lint                         PASS
pnpm harness:check                PASS
pnpm harness:scenes               PASS
pnpm harness:character-control    PASS   22 tests
pnpm harness:capabilities         PASS   5 capabilities
pnpm harness:animation-assets     PASS   7/7
pnpm harness:unit                 PASS   437 tests
pnpm harness:integration          PASS   155 tests
pnpm harness:replay               PASS   129 tests
pnpm harness:repo-guard           PASS   11/11
pnpm harness:world                PASS
pnpm build                        PASS
pnpm harness:one-shot             every stage through `web build` passed,
                                  then stalled on the visual stage (§3.1)
```

`pnpm harness:visual` — **NOT RUN.** See §3.1. Do not record it as PASS.

---

## 3. Start here on your machine

### 3.1 First: run the visual suite (blocks several gates)

The one thing this container could not do. It gates `harness:one-shot`,
Visual Desktop and Visual 320px.

```bash
pnpm install --frozen-lockfile
npx playwright install chromium     # failed here: proxy blocks the CDN
npx playwright test --reporter=line
```

Observed here, so you can tell a real failure from this environment's problem:

- `npx playwright install chromium` fails downloading Chrome for Testing
  151.0.7922.34 — network, not config;
- `/opt/pw-browsers/chromium` exists and is a valid symlink to a Chromium 1194
  binary, and `playwright.config.ts` already points at it when present;
- driving the same pages manually with that Chromium works fine and fast (all
  22 flows in §3.2 pass, ~2s per page);
- but `npx playwright test` produces **no reporter output at all** within 15
  minutes, even scoped to one spec and one project. Both web servers come up
  (`web:200`, `api:200`) and the process stays alive.

Likely browser launch or WebGL-under-swiftshader inside this container, not the
specs. On real hardware this should just run. If it does not, that is a genuine
finding worth reporting.

`tests/visual/scene/scene-authoring.spec.ts` is new on this branch and has
**never been executed by the runner** — it was written by migrating
`tests/visual/world/world-authoring.spec.ts` assertion-for-assertion.

### 3.2 What was verified manually instead (evidence, not a substitute)

Driven against the production build with the container's Chromium. All passed,
no page errors. Listed so you know what should already work:

```text
/ redirects to /edit/rig/demo-humanoid
/edit/rig/<id> and /edit/scene/<id> render their exact target id
unknown ids render not-found with the URL intact, no fallback
hierarchy click routes the Inspector by entity kind
edit -> PREVIEW -> Stage -> STAGED -> Apply -> APPLIED
Apply wrote project.json (3 -> 4 entities) and an apply report
drag a character onto the viewport lands it at the raycast hit, not the origin
no World tab, no World-mode toggle, Scenes link present
rig preview moves 5.379m over 60 ticks through ControllableCharacter
```

### 3.3 Then: Phase 11B — Apply and session hardening (highest value)

The continuation package's §0.1 is correct that the previous handoff overstated
these. Each is a real gap in current code:

1. **`apps/api/src/routes/repository-apply.ts` casts request JSON straight to
   `SceneOperation`.** No runtime schema. Needs §6.1: discriminated operation
   union, `additionalProperties: false`, unknown kinds → structured 400.
2. **The server does not enforce protection.** Only the browser
   `DocumentEditSession` checks it, so a direct POST bypasses it. Needs §6.2,
   including that `actor: 'ai'` can never carry an approval.
3. **Apply calls `saveProject()` then `writeRepositoryReport()` — two sequential
   `writeFileSync` calls.** Not atomic. Needs `@atc/repository-transaction`
   (§6.3) so project + report commit or roll back together, plus §6.4 faults.
4. **`revisionOf(project)` hashes the whole project including `revisionId`.**
   Needs §6.5, plus explicit no-change behaviour.
5. **`acceptApplied(document)` takes no revision.** The session keeps its old
   `baseRevisionId`, so a second Apply without reload sends a stale revision.
   Needs §6.6 — **this is the one a user hits first.**
6. **Undo/redo and staged operations can disagree** (§6.7).

### 3.4 Then: 11C / 11D / 11E / 11F

- **11C** — delete `packages/world-runtime/**` (and `scene-compat.ts`), remove
  `ProjectDefinition.world`, retire `world.*` commands, make `CommandContext` a
  discriminated union, migrate `harness/check-world.ts` and the remaining World
  tests onto `SceneRuntime`, then drop `harness:world`.
  Dead but still present: `WorldPanel.tsx`, `WorldViewport.tsx`, the store's
  world state — no longer referenced by any UI.
- **11D** — dirty-navigation guard, Scene Play/Pause/Step/Stop, viewport camera
  tools, repository prop/model catalog, 320px coverage.
- **11E** — one-shot twice from a clean tree, fresh clone, Vercel nested routes.
- **11F** — `agents/reviews/19-route-rig-scene-final-review.md`, which **must
  not be written by the implementing agent.**

---

## 4. Declaration (WP §18)

```text
Route-Scoped Editor Finalization WP: FAIL (incomplete — 11A only)

Continuation Start SHA:                       d126b93db3a98664d2c3bba13b33a4a3f7c7642c
Continuation End SHA:                         4aa107c
Original Main Base Preserved:                 PASS
Removed-World-Alt Excluded:                   PASS

Trace Override Causality:                     PASS
Trace Baseline Generation:                    PASS
Replay Harness:                               PASS   129/129
Animation Asset Harness:                      PASS   7/7

Apply Runtime Request Schema:                 FAIL   not started
Server-Side Protection:                       FAIL   not started
AI Approval Refusal:                          FAIL   not started
Atomic Project + Report Transaction:          FAIL   not started
Transaction Fault Injection:                  FAIL   not started
Fatal Read-Only Transition:                   FAIL   not started
Revision Identity:                            FAIL   not started
No-Change Behavior:                           FAIL   not started
Repeated Apply Without Reload:                FAIL   not started
External Revision Conflict:                   PASS   409 refusal exists and is tested
Undo / Redo / Stage Consistency:              FAIL   not started

ProjectDefinition.world Removed:              FAIL   still declared (deprecated)
World Runtime Package Retired:                FAIL   still present
World Capabilities Retired:                   FAIL   world.* still registered
Legacy Migration Preserved:                   PASS
CommandContext Discriminated Union:           FAIL   optional fields
World UI / Store Dead Code Removed:           PARTIAL  UI surface gone, files remain

Rig Dirty Navigation:                         FAIL   not started
Scene Dirty Navigation:                       FAIL   not started
Scene Play / Pause / Step / Stop:             FAIL   not started
Runtime Inspector:                            FAIL   not started
Viewport Camera Tools:                        FAIL   not started
Repository Prop / Model Catalog:              FAIL   not started
Prop Placement Persistence:                   FAIL   not started

Schema Generation Stability:                  PASS
Unity Generation Stability:                   PASS   export twice, no diff
Typecheck / Lint:                             PASS
Unit:                                         PASS   437
Integration:                                  PASS   155
Replay:                                       PASS   129
Capabilities:                                 PASS   5 capabilities
Repo Guard:                                   PASS   11/11
Build:                                        PASS
Visual Desktop:                               NOT RUN  runner never produced output here
Visual 320px:                                 NOT RUN
One-Shot Run 1:                               FAIL   stalled at the visual stage
One-Shot Run 2:                               NOT RUN
Fresh Clone:                                  NOT RUN
Local Nested Routes:                          PASS   manual, production preview
Vercel Nested Routes:                         NOT VERIFIED

Implementation State:
HOLD

Independent Final Review:
NOT PERFORMED BY IMPLEMENTATION AGENT
```

## 5. Limitations of this handoff

- Every PASS above was observed on this container at `4aa107c`. Nothing is
  projected from a diff.
- Manual browser observations are labelled as such and are counted as Visual
  PASS nowhere.
- `reports/repository-apply-hardening.md`, `reports/world-runtime-retirement.md`
  and `reports/scene-editor-runtime-closure.md` are required by §15 but are not
  written, because the work they would describe has not been done. Empty
  reports would be worse than their absence.
- `reports/*.md` is gitignored in this repository while every existing report is
  tracked; new reports need `git add -f`.

---

# 6. Phase 11B acceptance closure — current record

Work package: `WP_PHASE_11B_ACCEPTANCE_CLOSURE_AND_VISUAL_GATE_RECOVERY.md`
Full report: `reports/phase-11b-acceptance-closure.md`
Decision added: `DECISIONS/0018-the-location-is-a-default-priority-update.md`

```text
Start SHA:               0b4070602bbdfc9d2417804953955b779b0d39fe
End SHA:                 689fe5c
Base preserved:          yes — merge-base with origin/main is still 2e5b2a2
removed-world-alt:       never fetched, merged or read
main:                    never merged or rebased into this branch
```

## 6.1 What section 4 got wrong

Two entries in the declaration above were recorded on reasoning that did not
hold, and both are corrected here rather than quietly overwritten.

**"Visual Desktop: NOT RUN — client-side navigation is an environment
artifact."** It was an application defect. React Router v7 commits the location
inside `React.startTransition`, and this app polls the engine into React state
every 100 ms while a chamber render under software-rendered WebGL takes longer
than that — so every poll preempted the in-flight transition and it never
committed. Manual clicking kept clearing it because on a fast machine the render
finishes inside one poll interval. "It works when I do it by hand" was exactly
the evidence the failure was shaped to produce.

**"The visual suite writing to the real repository is out of scope."** It was
the reason the gate could not be run at all: the visual stage corrupted the
canonical project that `harness:replay` and `harness:animation-assets` had
already validated, so a one-shot could never pass twice. Fixed by running the
suite against a disposable checkout.

## 6.2 Two couplings the isolation exposed

Neither was known before the API stopped writing to the source checkout, and
both had been silently load-bearing:

1. `chamber.spec.ts` resolved the canonical project from its own file location,
   so it asserted against the developer's checkout while the server wrote to the
   disposable one.
2. While the API wrote to the source `project.json`, **Vite's watcher reloaded
   the page**, so the browser re-synced after every write. Nothing documented
   that. Without it, the second write in any spec is refused as a stale-revision
   conflict — the server being correct about a baseline that really had moved.

Both are now explicit: `tests/visual/repository.ts` resolves the root the API is
bound to, and restores the seed between tests that write.

## 6.3 Declaration (WP §20)

```text
Phase 11B Acceptance Closure: PASS

Start SHA:                                  0b4070602bbdfc9d2417804953955b779b0d39fe
End Implementation SHA:                     689fe5c
Branch Identity:                            PASS

Complete Apply Request Schema:              PASS
Closed Object Boundaries:                   PASS
Exact Human Protection Approval:            PASS
AI Approval Refusal:                        PASS
Approval Report Evidence:                   PASS

Prepared Project Validation:                PASS
Prepared Report Validation:                 PASS
Atomic Project + Report:                    PASS
Apply Endpoint Fault Injection:             PASS   16 cases
Rollback Outcome:                           PASS
Fatal Read-Only Outcome:                    PASS

Content Revision Identity:                  PASS
No-Change Server Status:                    PASS
No-Change Browser Status:                   PASS
No-Op Local History:                        PASS
Browser Canonical Project Adoption:         PASS
Repeated Apply Without Reload:              PASS
Route Re-entry After Apply:                 PASS
External Conflict Refusal:                  PASS

Undo Removes Staged Operation:              PASS
Redo Restores Prior Staged Status:          PASS
Unrelated Stage Preservation:               PASS
Mandatory acceptApplied Revision:           PASS   compile-time

Collision-Safe Apply Reports:               PASS
Repeated Content Revision Flow:             PASS

Client-Side Link Navigation:                PASS   3 projects
Asset Library Select Navigation:            PASS   3 projects
Visual Disposable Repository:               PASS
Source Checkout Clean After Visual:         PASS
Visual Desktop:                             PASS
Visual Mobile-Landscape:                    PASS
Visual Narrow / 320px:                      PASS

Typecheck:                                  PASS
Lint:                                       PASS
Build:                                      PASS
Unit:                                       PASS   450
Integration:                                PASS   221
Replay Before Visual:                       PASS   129
Visual:                                     PASS   174 (19.2m / 20.5m)
Replay After Visual:                        PASS   129
Animation Assets After Visual:              PASS   7/7
Capabilities:                               PASS   5 capabilities
Repo Guard:                                 PASS   11/11
One-Shot Run 1:                             PASS   31/31 stages, 1220.0s
One-Shot Run 2:                             PASS   31/31 stages, 1292.6s
Clean Working Tree:                         PASS   clean after both runs

Decision:
PHASE 11B ACCEPTANCE CLOSURE: PASS
```

## 6.5 Command evidence

Two `pnpm harness:one-shot` runs, back to back, with no edit to the tree between
them. The second started from a fully committed, clean checkout.

```text
run 1   31/31 stages passed in 1220.0s     exit 0
run 2   31/31 stages passed in 1292.6s     exit 0

unit                20 files    450 passed
integration         15 files    221 passed
replay               5 files    129 passed
visual                          174 passed   (19.2m / 20.5m)
                                desktop + mobile-landscape + narrow

[visual] source checkout unchanged; disposable repository removed.

git status --short before run 1   only an uncommitted handoff edit
git status --short after run 1    clean
git status --short after run 2    clean
```

Three things in that block are the ones that were not true at `0b40706`:

**174 passed, not 144 passed / 3 failed.** The three failures were the same
client-side navigation test on all three projects. The suite has also grown by
27 cases — 12 navigation, 15 Apply round-trip — so the number moved for two
reasons and both are load-bearing.

**`source checkout unchanged`.** The visual stage used to write through the real
API into the canonical demo project, which turned `replay` and
`animation-assets` red for every later run and made a second one-shot
impossible. Those two stages are now green *inside the same run*, after the
visual stage, without anything being restored by hand.

**Clean tree after both.** §17 is explicit that a passing one-shot which leaves
canonical fixtures modified is not a pass, and that is exactly what the previous
state produced.

An earlier one-shot attempt was abandoned rather than reported: a source file
was edited while its visual stage was running, and the dev server hot-reloads,
so its result would not have been evidence of anything. It is not counted above.

## 6.4 What is still open

- **The browser seeds `canonicalProject` from a compile-time import.** A reload
  returns to the bundled snapshot rather than to the repository, and a change
  applied by someone else is invisible until something triggers `reloadAssets`.
  Pre-existing, out of scope for 11B, and worth its own decision.
- **`routes/animation-assets.ts` calls `loadProject()` with no root.** Correct
  under `ATC_REPO_ROOT`, wrong for a test that constructs an app with an
  explicit `repoRoot`. No acceptance item depends on it.
- **Phase 11C (World retirement) is not started**, and per §0 must not begin
  until this package is green.
- The independent final architecture review (Task I) is **not** performed here.
