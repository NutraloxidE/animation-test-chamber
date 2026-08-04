# Handoff — Route-Scoped Editor Finalization (continuation)

Work package: `WP_ROUTE_SCOPED_EDITOR_FINALIZATION_AND_HARDENING.md`
Branch: `claude/edit-rig-scene-controllable-character`

```text
Continuation start SHA:  d126b93db3a98664d2c3bba13b33a4a3f7c7642c
Current SHA:             4aa107c   (22 commits ahead of origin/main, 0 behind)
Base preserved:          yes — merge-base with origin/main is still 2e5b2a2
removed-world-alt:       never fetched, merged or read
```

**Implementation state: HOLD.** Phase 11A is done. 11B–11F are not started.

Written to be picked up on another machine. **Section 3 is the part to read first.**

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
