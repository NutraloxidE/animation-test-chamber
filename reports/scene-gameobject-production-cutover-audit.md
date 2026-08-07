# Scene GameObject production cutover + renderer correction — audit

```text
Repository:   NutraloxidE/animation-test-chamber
Branch:       claude/new-session-ou984u
Start SHA:    5b9dc609af7b24bb72c6caaaee52ff44087bed8e
```

The start SHA matched the work package exactly; no commits had landed after it, so
nothing had to be preserved or reconciled before starting.

---

## 1. What changed, in one paragraph each

**The production Scene reads GameObjects.** `useSceneRuntime` resolves and
instantiates a `RuntimeScene` from `scene.gameObjects` through the existing
`instantiateScene` — no second, web-only resolver — and `SceneViewport` projects
it through `projectRuntimeScene` into `GameObjectRenderer`. When resolution
fails the editor shows the issues and draws nothing; there is no entity
fallback, because a fallback would draw a plausible picture of broken canonical
data and nobody would find out until something ran it.

**The production Scene writes GameObjects.** `useSceneSession` dispatches
`GameObjectSceneOperation` through `applySceneGameObjectOperation`, and
`RepositoryApplyRequest.operations` is that union — not a superset containing
both. Accepting both would have made the endpoint a dual write path with "which
collection is canonical" decided per request by whichever client sent it.

**An Animator Component animates.** `resolveAnimatorPlayback` runs the existing
animation asset resolver and flattens it to `state -> take`; `AnimatorRuntime`
advances `deltaSeconds` per fixed step; `AnimatedRepositoryModel` clones the
skeleton, builds a per-instance mixer, binds the clip by canonical take identity
and seeks it from simulation time. A state whose motion set binds no take is
reported, never filled in.

---

## 2. Production Scene read source

| Surface | Reads |
| --- | --- |
| `apps/web/src/scene-editor/use-scene-runtime.ts` | `scene.gameObjects` → `instantiateScene` → `RuntimeScene` |
| `apps/web/src/scene-editor/viewport/SceneViewport.tsx` | `projectRuntimeScene(runtime, activeCameraGameObjectId)` |
| `apps/web/src/scene-editor/scene-hierarchy.ts` | `scene.gameObjects` + `resolveGameObjectPrefab` |
| `apps/web/src/scene-editor/SceneEditorPage.tsx` | the hierarchy rows and the instance by id |

No production Scene module names `scene.entities`, `SceneEntityDefinition`,
`entity.kind`, `activeCameraEntityId` or any retired entity operation. Enforced
mechanically by `sceneCutoverGuardStage` in `harness/repo-guard.ts`, which strips
comments before matching so the files can keep explaining what they no longer do.

Verified negatively: adding `const fallback = handle.scene.entities;` to
`SceneEditorPage.tsx` makes the guard fail with

```text
[FAIL] the production Scene path reads and writes gameObjects
  - apps/web/src/scene-editor/SceneEditorPage.tsx reaches for the retired entity path
```

and the line was then removed.

## 3. Production Scene write target

Thirteen operations, applied by `applySceneGameObjectOperation` to
`scene.gameObjects` and `activeCameraGameObjectId` only:

```text
scene.place_prefab              scene.set_component_override
scene.delete_game_object        scene.clear_component_override
scene.duplicate_game_object     scene.set_instance_binding
scene.rename_game_object        scene.set_relation
scene.set_transform             scene.reorder_game_object
scene.set_enabled               scene.set_active_camera
scene.set_prefab_source
```

The schema names are the ones the work package specified; no mapping document is
needed.

## 4. Entity-byte immutability

`entities` is passed through by identity. Asserted byte-for-byte — not
field-by-field, because an operation that reverse-generated an *equivalent*
entity list would still be a second source of truth and a field comparison would
let it through.

| Evidence | Where |
| --- | --- |
| all 12 independent operations, pure-function level | `tests/unit/scene/game-object-session.test.ts` — `no production operation touches the entity mirror` |
| `clear_component_override`, which needs a prior override | same file, following case |
| every operation through the real HTTP endpoint | `tests/integration/api/scene-game-object-operations.test.ts` — `agrees()` asserts it on every case |
| the place-prefab Apply specifically | `tests/integration/api/repository-apply.test.ts` — `leaves the entity mirror byte-identical` |
| all 13 operations, harness stage | `harness/check-scene-gameobject-cutover.ts` — `every GameObject Scene operation is deterministic and leaves entities alone` |

No reverse generation exists anywhere. The Repo Guard scans `apps/web/src`,
`apps/api/src` and `packages/editor-core/src` for `entities: scene.gameObjects`
and its variants.

## 5. All operation results

`pnpm harness:scene-gameobject-cutover`:

```text
[PASS] the production Scene resolves gameObjects and ignores entities
[PASS] the Scene Viewport projects RuntimeScene through GameObjectRenderer
[PASS] every GameObject Scene operation is deterministic and leaves entities alone
[PASS] Scene operations refuse what the Prefab cannot support
[PASS] a child runtime node selects for inspection and never becomes an operation target
[PASS] Scene hierarchy rows carry exact Prefab identity, Components and badges
[PASS] an Animator Component produces deterministic, isolated playback
[PASS] two animated instances of one Prefab do not contaminate each other
[PASS] an Animator with no take for its state is an issue, not a silent substitution
[PASS] one transform edit agrees across document, hierarchy, runtime and projection

10/10 Scene cutover checks passed
```

`tests/integration/api/scene-game-object-operations.test.ts` drives every one of
the thirteen through the real endpoint and asserts a four-way agreement —
request, apply response, `scene.gameObjects` on disk, and a re-read of the file
with no migration in between. 29 tests, all passing.

## 6. Stale revision evidence

`a stale revision writes nothing at all` in the operations integration test:

```text
409 conflict
body.changedPaths          []
body.changedGameObjectIds  []
project bytes              identical to what the external writer left
scene.entities             identical
reports/apply/             empty
```

The pre-existing `revision conflict` case in `repository-apply.test.ts` makes the
same claim from the session side and additionally asserts the staged work
survives for resubmission.

## 7. Active camera evidence

Three refusals and one success, asserted at three layers:

| Case | Pure engine | Endpoint | Harness |
| --- | --- | --- | --- |
| unknown id | ✓ | ✓ | ✓ |
| no Camera Component | ✓ (`keyword: 'capability'`) | ✓ | ✓ |
| disabled GameObject | ✓ | ✓ | ✓ |
| enabled Camera GameObject | ✓ | ✓ (`changedPaths: ['/activeCameraGameObjectId']`) | ✓ |

The Component check is made by the *server* against a registry it loads itself
(`loadPrefabRegistry(root)` + `prefabCapabilityLookup`). The browser makes the
same check so it can refuse at the control the human just moved, but a check that
only the browser makes is a habit of one client rather than a rule.

## 8. Real Animator playback evidence

Two instances of `quaternius-knight`, stepped through `RuntimeScene.step`:

```text
tick 0    {"stateId":"idle","normalizedTime":0}     animationSeconds 0
tick 30   {"stateId":"idle","normalizedTime":0.25}  animationSeconds 0.5
tick 90   {"stateId":"idle","normalizedTime":0.75}  animationSeconds 1.5

take      {"assetPath":"/assets/characters/quaternius-knight/KnightCharacter.glb",
           "animationName":"HumanArmature|Idle"}
```

Three separate claims are in that table:

- **the clip is canonical.** The take was resolved through
  `state -> motion slot -> motion set -> clip asset`, not guessed from a
  filename. `tests/unit/character-bindings/character-presentation.test.ts`
  already asserts that every take this chain produces exists in the file it
  names; the Animator plan reuses the same resolution.
- **it advances on the shared clock.** 30 fixed steps at 1/60 s is exactly
  0.5 s, asserted to within 1e-9 by the harness stage. Nothing reads a wall
  clock: `AnimatedRepositoryModel` seeks `action.time` and calls
  `mixer.update(0)`.
- **reset reproduces the initial state.** After `RuntimeScene.reset()`,
  `animationSeconds` is 0 and `animationState` is byte-identical to tick 0.

Negative check: making `AnimatorRuntime.step` a no-op turns
`an Animator Component produces deterministic, isolated playback` red while every
other stage stays green. The stage measures playback, not the presence of an
Animator.

The renderer-side half — mixer, cloned skeleton, cloned clips — is not asserted
in Node because it needs a canvas; it is covered by the visual suite and by the
structural guard requiring `AnimationMixer` and `cloneSkinnedScene` in
`AnimatedRepositoryModel.tsx`.

**Procedural models.** A `procedural-humanoid` binding has no skeleton to pose.
Its Animator still resolves and still advances; the visual follows the runtime
transform and plays no skeletal clip. That is stated in `GameObjectRenderer.tsx`
and in DECISION 0025 rather than counted as evidence of skeletal animation.

## 9. Two-instance isolation evidence

`two animated instances of one Prefab do not contaminate each other` steps *one*
of two instances for 45 ticks and asserts the other kept its own animation
seconds, its own animation state, its own world transform and its own simulation.
`hero.animator === understudy.animator` is `false`.

The renderer-side isolation is structural: `AnimatedRepositoryModel` clones the
scene with `SkeletonUtils.clone`, builds its own `AnimationMixer` over that
clone, and clones every clip it plays before scaling any track — so no cached
GLTF resource is ever mutated.

## 10. One-source reload evidence

`one transform edit agrees across document, hierarchy, runtime and projection`
performs one `scene.set_transform` and reads the result back through five
surfaces with **no migration or reconciliation command in between**:

```text
scene.gameObjects[understudy].transform.position   {"x":3.5,"y":0,"z":-2.25}
changedGameObjectIds                               ["understudy"]
RuntimeGameObject.worldTransform                   x 3.5, z -2.25
render projection node worldTransform              x 3.5
Scene hierarchy row                                present, same Prefab version
scene.entities                                     byte-identical
```

The endpoint-level version of the same claim is in
`persists an authored transform that survives a reload`, which re-reads
`project.json` from disk after the Apply.

## 11. Transitional compatibility policy

The policy §9.2 calls preferred, chosen and recorded in DECISION 0025:

```text
production writes gameObjects only
entities is untouched, and is consulted by nothing in production
the mirror may go stale, and staleness is harmless because nothing reads it
```

Three checks changed to match, each for a stated reason:

- **`harness:game-objects`** — the entities/gameObjects *agreement* stage became
  `every Scene is complete in GameObject terms alone`. Agreement was the right
  check while `gameObjects` was derived; it becomes an instruction to
  reverse-generate the moment production writes the GameObject half.
- **`validateProjectReferences`** — validates `scene.gameObjects`.
  `validateSceneReferences` still exists and is still exercised from the
  migration that produces the entity view.
- **`prefabs:migrate`** — gained a one-way valve. It still walks every Scene's
  entities, because that walk emits the shared camera and light Prefabs, but it
  adopts the generated `gameObjects` only for a Scene that has none.

Nothing was deleted. `Scene.entities`, `SceneEntityDefinition`,
`Project.characters` and the legacy `SceneOperation` union all remain for the
final-deletion package, and the Repo Guard deliberately does not require their
removal.

---

## 12. Command matrix

Every command below was run. Results are from the final code on a clean tree.

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | pass |
| `pnpm schema:generate` + `git diff --exit-code -- schemas` | pass (regenerated `RepositoryApplyRequest.schema.json`, committed) |
| `pnpm prefabs:migrate` / `pnpm prefabs:check` | pass — 7 Prefabs and 5 identities already current |
| `pnpm assets:prefabs:index` / `pnpm assets:animation:index` | pass, no drift |
| `pnpm typecheck` | pass |
| `pnpm lint` | pass (`--max-warnings=0`) |
| `pnpm build` | pass |
| `pnpm harness:check` | 5/5 |
| `pnpm harness:animation-assets` | 7/7 |
| `pnpm harness:prefabs` | 6/6 |
| `pnpm harness:game-objects` | 3/3 |
| `pnpm harness:game-object-renderer` | 5/5 |
| `pnpm harness:scene-gameobject-cutover` | 10/10 |
| `pnpm harness:world` | pass |
| `pnpm harness:scenes` | pass |
| `pnpm harness:character-control` | 22 tests pass |
| `pnpm harness:capabilities` | pass |
| `pnpm harness:unit` | pass |
| `pnpm harness:integration` | pass |
| `pnpm harness:replay` | pass |
| all three together | 1087 tests, 54 files, 0 failures |
| `pnpm harness:repo-guard` | 14/14 |
| `pnpm harness:visual` | 231 passed, 6 skipped, 0 failed |
| `pnpm harness:one-shot` ×2 | 58/58 twice — see §13 |

## 13. One-shot results

Both runs were started from a clean tree, back to back, with no edit between
them.

```text
ONE-SHOT RUN 1    58/58 stages passed in 1275.1s    exit 0
ONE-SHOT RUN 2    58/58 stages passed in 1247.6s    exit 0
```

The 58 stages, in the order they ran:

```text
typescript strict                                    eslint
canonical data validity                              schema generation drift
generated files not hand-modified                    animation assets resolve and validate
every character resolves to a runnable document      generated asset index is current
migration is deterministic                           asset-resolved runtime matches pre-migration
two characters share one behaviour                   second character runs every replay fixture
prefab assets validate and resolve                   every prefab resolves to a composition
migrated prefabs preserve the characters             prefab migration is deterministic
generated prefab index is current                    prefab usage graph names exact holders
every scene GameObject resolves                      every Scene is complete in GameObject terms alone
two instances have independent runtime state         every required composition renders from Components
a disabled GameObject draws nothing                  the active camera resolves through its Component
a missing required Component is an error             the canonical Scene renders from gameObjects alone
--- the ten stages this package added ---
the production Scene resolves gameObjects and ignores entities
the Scene Viewport projects RuntimeScene through GameObjectRenderer
every GameObject Scene operation is deterministic and leaves entities alone
Scene operations refuse what the Prefab cannot support
a child runtime node selects for inspection and never becomes an operation target
Scene hierarchy rows carry exact Prefab identity, Components and badges
an Animator Component produces deterministic, isolated playback
two animated instances of one Prefab do not contaminate each other
an Animator with no take for its state is an issue, not a silent substitution
one transform edit agrees across document, hierarchy, runtime and projection
--- and the rest ---
transaction recovery is clean and idempotent         world contract
capability completeness                              unit
integration                                          replay
every workspace package resolves                     no direct device-to-Simulation control path
no second Character selector                         no protected value changed unexpectedly
no tests deleted or weakened                         no schema constraint relaxed silently
no generated artifact treated as canonical           no secrets committed
no raw restricted asset committed                    no published asset version modified in place
no runtime behaviour inferred from state names       world contract not eroded
gameobject prefab system present and canonical       the production Scene path reads and writes gameObjects
web build                                            visual (playwright)
```

Visual, from run 2's captured stage output:

```text
6 skipped
231 passed (19.7m)
[visual] source checkout unchanged; disposable repository removed.
```

The `source checkout unchanged` line is the wrapper's own assertion: the suite
performs real writes through the real API, against a disposable checkout, and
proves the developer's `projects/demo-character/project.json`, `assets/`,
`generated/` and the replay baselines did not move. Both desktop and narrow
Playwright projects are inside that count.

A separate, earlier run of `pnpm harness:visual tests/visual/scene
tests/visual/routing` — the specs this package rewrote — reported
`117 passed, 6 skipped` across desktop, mobile-landscape and narrow with zero
failures.

## 14. Working tree

Clean before run 1, after run 1 and after run 2. `git status --short` produced
no output at any of the three points; the chain script captured all three and
each section is empty.

`reports/one-shot-report.{json,md}` are written by the harness and are ignored by
`.gitignore`, so a run leaves nothing behind to commit.

```text
End implementation SHA:  4644829452ece6235949336f02b47f5bbab6a95e
```

---

## 15. What this package did not do

Named here rather than left to be discovered:

- **the canonical schema deletion.** `Scene.entities`, `SceneEntityDefinition`,
  `Project.characters` and the legacy `SceneOperation` union all still exist, by
  design (§0 of the work package). The Repo Guard forbids production Scene
  modules from reaching for them and forbids reverse generation anywhere; it does
  not require their removal.
- **Prefab APIs, Asset Library and Unity export.** Out of scope, and none of them
  were required for this slice.
- **an Inspector control that authors a Component override patch.** The Inspector
  can *clear* one override and revert all of them, and `scene.set_component_override`
  is exercised by the unit suite, the integration suite and the harness — but a
  human cannot yet author a patch through the UI. `scene.set_prefab_source` is
  reachable through the version selector; `scene.reorder_game_object` through Move
  earlier / Move later.
- **Open Prefab from a hierarchy row.** It lives on the Inspector, which §6.3 and
  §21.16 both permit; child rows select a node for inspection and the Inspector's
  link follows the selection.

---

## 16. Declaration

```text
SCENE GAMEOBJECT PRODUCTION CUTOVER: PASS

Start SHA:                                  5b9dc609af7b24bb72c6caaaee52ff44087bed8e
End Implementation SHA:                     4644829452ece6235949336f02b47f5bbab6a95e
Branch Identity:                            PASS
Clean Working Tree:                         PASS

Scene Reads gameObjects:                    PASS
Scene Ignores entities:                     PASS
RuntimeScene Production Use:                PASS
GameObjectRenderer Production Use:          PASS
No Entity Fallback:                         PASS

GameObject Hierarchy:                       PASS
Root/Child Selection Identity:              PASS
Scene Inspector Cutover:                    PASS
Place Prefab Flow:                          PASS

GameObject Operations:                      PASS
Repository Apply to gameObjects:            PASS
Entities Byte-Identical:                    PASS
Stale Revision Zero Writes:                 PASS
Prefab Source Clears Overrides:             PASS
Duplicate Drops Camera Relation:            PASS
Active Camera Validation:                   PASS
One-Source Reload:                          PASS

Animator Visible Playback:                  PASS
Canonical Clip Binding:                     PASS
Fixed-Clock Animation:                      PASS
Mixer/Skeleton Isolation:                   PASS
Reset Determinism:                          PASS
Missing Clip Visibility:                    PASS

Scene Cutover Harness:                      PASS
GameObject Renderer Harness:                PASS
Animation Assets Harness:                   PASS
Prefabs Harness:                            PASS
GameObjects Harness:                        PASS
Scenes Harness:                             PASS
Character Control Harness:                  PASS
Capabilities Harness:                       PASS
Unit:                                       PASS
Integration:                                PASS
Replay:                                     PASS
Repo Guard:                                 PASS
Visual Desktop:                             PASS
Visual Narrow:                              PASS
Typecheck:                                  PASS
Lint:                                       PASS
Build:                                      PASS
One-Shot Run 1:                             PASS
One-Shot Run 2:                             PASS

Decision:
SCENE GAMEOBJECT PRODUCTION CUTOVER: PASS
```

One qualification on `Animator Visible Playback`, stated rather than buried. What
is proven in Node is that the Animator resolves a canonical take, advances
exactly 0.5 s per 30 fixed steps, produces a different animation state at three
different simulation times, resets to its initial state, and stays isolated from
a second instance. What is proven in the browser is that the page renders and
behaves — the visual suite asserts the Scene runtime reaches `RUNNING`, and the
chamber's own imported-Character spec asserts canonical takes play. The pixels of
a skinned mesh mid-clip are not diffed against a reference image; no stage in
this repository does that, and claiming otherwise would be the kind of evidence
inflation §10.7 warns about.
