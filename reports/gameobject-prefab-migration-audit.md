# GameObject Prefab Asset System — migration audit

**Decision: GAMEOBJECT PREFAB ASSET SYSTEM: HOLD.**

The canonical spine is built, migrated, tested and green. The production
switchover is not: the renderer, the Scene runtime, the editor routes and the API
still read the entity view. §8 below lists exactly what is outstanding and why.

Only observed evidence is recorded here. Every command in §7 was run; commands
that were not run are marked as such rather than assumed.

- Start SHA: `671cce03236de84daa75f80ceaa8d868150d854a`
- Branch: `claude/new-session-j71ojl`
- Merge base with `origin/main`: unchanged (no merge or rebase performed)

---

## 1. Prefab matrix

Read from the repository by resolving each Prefab through
`resolveGameObjectPrefab`, not from the migration's own intentions.

| Prefab | Derivation | Parent | Components (resolved) | Behavior | Motion Set | Rig | Tuning | Scene instances |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `humanoid-character-base` | base, **abstract** | — | animator + character-motor + capsule-collider + tags | `humanoid-third-person-base` | `demo-humanoid-motion-set` | `demo-humanoid-rig` | `demo-default-tuning` | — |
| `navigator` | variant | `humanoid-character-base` | + model-renderer | `humanoid-third-person-base` | `demo-humanoid-motion-set` | `demo-humanoid-rig` | `demo-default-tuning` | `controlled-humanoid`, `scripted-humanoid` |
| `relay` | variant | `humanoid-character-base` | + model-renderer | `humanoid-third-person-base` | `alternate-humanoid-motion-set` | `demo-humanoid-rig` | `alternate-humanoid-tuning` | — |
| `sentinel` | variant | `humanoid-character-base` | + model-renderer | `humanoid-third-person-base` | `demo-humanoid-motion-set` | `demo-humanoid-rig` | `demo-default-tuning` | — |
| `quaternius-knight` | variant | `humanoid-character-base` | + model-renderer + equipment-sockets | `humanoid-third-person-base` | `quaternius-knight-motion-set` | `quaternius-knight-rig` | `demo-default-tuning` | — |
| `quaternius-universal-base` | variant | `humanoid-character-base` | + model-renderer + equipment-sockets | `humanoid-third-person-base` | `quaternius-universal-motion-set` | `quaternius-universal-rig` | `demo-default-tuning` | — |
| `default-scene-camera` | base | — | camera | n/a | n/a | n/a | n/a | `scene-camera` |

Content hashes (first 12): `41e7ef9bf81a`, `e5ea5de669c3`, `8f29fdbac374`,
`8928bda7d392`, `c7a7366ec8f7`, `fe72de039d63`, `47249ec3a544`.

No concrete Prefab stores a root payload — `tests/unit/prefabs/migration.test.ts`
asserts `'root' in asset === false` for all five, which is what makes them
variants rather than snapshots.

---

## 2. Migration evidence

### Old → new identity map

| Old Character id | New Prefab id | Derivation |
| --- | --- | --- |
| `demo-humanoid` | `navigator` | variant of `humanoid-character-base` |
| `alternate-humanoid-character` | `relay` | variant |
| `sentinel` | `sentinel` | variant |
| `quaternius-knight` | `quaternius-knight` | variant |
| `quaternius-universal-base` | `quaternius-universal-base` | variant |

Old Scene entities → GameObject instances, ids preserved:
`controlled-humanoid`, `scripted-humanoid`, `scene-camera`.

### Files created

```text
packages/schema/src/assets.ts            common versioned-asset primitives
packages/schema/src/transform.ts         TransformDefinition, split out of scene.ts
packages/schema/src/prefab.ts            Prefab contract
packages/schema/src/prefab-save.ts       adoption request contract
packages/prefab-runtime/**               registry, validation, resolution, usage, adoption
packages/game-object-runtime/**          resolved definitions, RuntimeGameObject, RuntimeScene
harness/prefabs.ts                       Node-side Prefab loading
harness/migrate-character-prefabs.ts     the migration
harness/generate-prefab-asset-index.ts   the generated index
harness/check-prefabs.ts                 6 stages
harness/check-game-objects.ts            3 stages
assets/prefabs/**                        7 Prefab versions
generated/prefab-assets/library-index.json
generated/unity/prefabs/**               7 Prefab exports + manifest
tests/unit/prefabs/**                    4 suites
tests/unit/game-objects/**               2 suites
DECISIONS/0020, 0021, 0022
```

### Old canonical fields removed

**None yet.** `Project.characters`, `activeCharacterId` and
`SceneEntityDefinition` are all still present and still production-read. This is
the reason for the HOLD; see §8.

### Legacy adapters retained

- `SceneDefinition.entities` — still the field the runtime, renderer and Unity
  scene export read. `gameObjects` is derived from it by `pnpm prefabs:migrate`.
- `project.ts`'s `CharacterModelBinding` — deliberately **not** aliased to
  `RenderableModelBinding`. The legacy type still carries `rightHandBone` and
  `weaponGrips`; the new one does not, because those moved to
  `EquipmentSocketsComponent`. Aliasing two differently-shaped types under one
  name would make the migration look finished while the grips had two homes.

### Effective-equivalence results

`pnpm harness:prefabs` stage "migrated prefabs preserve the pre-migration
characters": **PASS**, 5 characters. Compared per character, through the
resolver, against `project.characters`:

- model binding (preset id, or asset path + scale + rotationYRad)
- Behavior / Motion Set / Rig / Tuning references, exactly
- `instanceOverrides`, exactly
- capsule radius and height
- every authored grip: bone name, local position, local rotation

`tests/unit/prefabs/migration.test.ts` asserts the same 5 × 5 matrix
independently (37 assertions).

Socket mapping, stated explicitly because it is the one shape change:

| Old | New |
| --- | --- |
| `model.rightHandBone: "Palm.R"` + `weaponGrips.sword` | socket `right-hand-sword`, `boneName: "Palm.R"`, `acceptedItemTags: ["sword"]` |
| `model.rightHandBone: "hand_r"` + `weaponGrips.sword` | socket `right-hand-sword`, `boneName: "hand_r"`, position `[0,-0.035,0]`, rotation `[0,1.5707963267948966,-0.18]` |

### Replay-equivalence results

`pnpm harness:replay`: **PASS**, 129 tests, 5 files. `pnpm harness:animation-assets`:
**PASS**, 7/7 — including the shadow-compare stage that asserts the asset-resolved
runtime still reproduces the pre-migration traces exactly.

Replay traces were *not* re-projected through the migration id map, because the
replay path still runs the entity view: the GameObject runtime is additive in
this commit and no replay fixture drives it. That is an outstanding item, not a
passing one.

### Generated-output drift

`pnpm harness:check` stage "generated files not hand-modified": **PASS** after
`pnpm unity:export`. `pnpm prefabs:migrate` run twice: second run writes nothing
(`[OK] 7 Prefab(s) … already current`). `pnpm prefabs:check`: clean.

---

## 3. Save-semantics evidence

Implemented as a **pure planning procedure** plus the request contract. The HTTP
route is not built (§8), so the evidence below is from
`tests/unit/prefabs/adoption.test.ts` (12 tests, PASS) rather than from a live
route.

| Case | Displayed / request targets | Planned changed | Untouched holders | Outcome |
| --- | --- | --- | --- | --- |
| publish Behavior, targets `[navigator]` | `navigator` | `navigator` | 5 | plan, no conflicts |
| publish Behavior, targets `[navigator, relay, sentinel]` | those 3 | exactly those 3 | 3 | plan, no conflicts |
| publish Behavior, targets `[]` | — | — | 6 | version only, nothing re-pointed |
| publish Prefab `navigator@1.0.0`, target 1 Scene instance | `two-humanoids-shared-animation/controlled-humanoid` | that one | `scripted-humanoid` | plan, no conflicts |
| stale holder snapshot (`expected.prefabReferences: []`) | — | — | — | `stale-holder-snapshot`, refuse |
| stale project revision | — | — | — | `stale-holder-snapshot`, refuse |
| target that does not hold the source (`default-scene-camera`) | — | — | — | `target-does-not-hold-source`, refuse |
| request carrying `updateScope: 'shared'` | — | — | — | schema refusal |

For every case above, `plan.targets` equals `request.targetPrefabIds` by
construction and by assertion.

One real defect was found and fixed while writing these tests: the usage graph
read *stored* Prefab payloads, so it reported the shared Behavior as held by
`humanoid-character-base` alone while five variants inherited it — a blast radius
smaller than the truth. It now resolves before counting.

---

## 4. Runtime isolation evidence

`pnpm harness:game-objects` stage "two instances of one Prefab have independent
runtime state": **PASS**. `tests/unit/game-objects/isolation.test.ts`: **PASS**,
9 tests.

| Case | Assertion | Result |
| --- | --- | --- |
| same Prefab, two instances (`controlled-humanoid`, `scripted-humanoid` on `navigator@1.0.0`) | 60 ticks on one leaves the other's `transformState` byte-identical | PASS |
| same Prefab, two instances | distinct `ControllableCharacter`, distinct `resolvedProject` | PASS |
| same Prefab, two instances | every component runtime distinct by `componentId` | PASS |
| same Prefab, two instances | distinct intent sources | PASS |
| shared Animator assets, two Prefabs (`navigator`, `sentinel`) | identical `motionBindings` and `clips`; distinct simulations; 30 ticks on one does not move the other | PASS |
| runtime spawn/despawn | canonical Scene byte-identical before and after | PASS |
| runtime spawn of an abstract Prefab | throws `abstract-prefab-placed` | PASS |

Not asserted at this layer, and deliberately: GLTF scene cloning, skeleton
cloning and `AnimationMixer` independence are Three.js concerns owned by
`apps/web/src/three`, and that isolation is inherited from the pre-existing
per-character work rather than re-proven here. The GameObject runtime is
engine-agnostic and reads no browser global.

---

## 5. Nested Prefabs

No nested Prefab appears in the migrated demo data, so nesting is exercised by
fixtures in `tests/unit/prefabs/derivation.test.ts`: expansion into the resolved
tree with composed transforms, an override scoped to one nested instance, and a
refused nesting cycle. "Nested Prefab, two parents" from §23.4 of the work
package is therefore **not** evidenced against real data.

---

## 6. Counts

| Thing | Count |
| --- | --- |
| Prefab versions on disk | 7 |
| GameObject instances in canonical Scenes | 3 |
| Component types in the closed union | 8 |
| New unit tests | 99 (6 files) |
| Total unit tests | 686 |
| Repo Guard stages | 13 (was 12) |
| Prefab harness stages | 6 |
| GameObject harness stages | 3 |

---

## 7. Commands run

```text
pnpm install                              (lockfile updated for two new packages)
pnpm schema:generate                      66 files
pnpm prefabs:migrate                      7 Prefabs + project.json
pnpm prefabs:check                        clean
pnpm assets:prefabs:index                 generated/prefab-assets/library-index.json
pnpm unity:export                         34 files
pnpm typecheck                            PASS
pnpm lint                                 PASS
pnpm harness:check                        5/5
pnpm harness:animation-assets             7/7
pnpm harness:prefabs                      6/6
pnpm harness:game-objects                 3/3
pnpm harness:world                        1/1
pnpm harness:scenes                       1/1
pnpm harness:capabilities                 1/1
pnpm harness:unit                         686 tests
pnpm harness:integration                  233 tests
pnpm harness:replay                       129 tests
pnpm harness:repo-guard                   13/13
pnpm build                                PASS (1115 modules)
pnpm harness:visual                       201 passed, desktop + narrow, 10.9m
pnpm harness:one-shot                     42/42 stages, 681.5s, clean tree after
```

`pnpm harness:one-shot` was run twice from a clean tree; see §9.

---

## 8. What is not done

This is the HOLD list. Everything here is from the work package and is genuinely
outstanding — none of it is "done differently".

### The production switchover (§6.3, §10, §12, §17 negative guards)

`SceneDefinition` carries **both** views. `gameObjects` is canonical in shape and
derived in practice; `entities` is what the renderer, `@atc/scene-runtime`, the
Unity scene projection, the Scene Editor and the apply transaction still read.
`harness:game-objects` asserts the two agree instance by instance on every run,
so they cannot drift silently — but two production views of one Scene is exactly
what §0 forbids, and it is why this package is HOLD rather than PASS.

Consequently these are also outstanding:

- `Project.characters[]` and `activeCharacterId` still exist and are still read.
- `<Character />` is still the renderer entry; `<GameObjectRenderer />` does not
  exist.
- `/prefabs` and `/edit/prefab/:prefabId` do not exist. `/edit/rig/:id` is
  unchanged and redirects nowhere.
- The Rig Editor is not yet an Animator workspace inside a Prefab Editor.
- Prefab Overview, the component badges (`ONLY THIS PREFAB`, `SHARED BY N`,
  `PREVIEW ONLY`, …) and the Scene Editor's GameObject hierarchy do not exist.
- The Asset Library does not browse Prefabs.
- The repo guard's **negative** half — forbidding production reads of
  `Project.characters`, `SceneEntityDefinition.kind`, `CHARACTER_PRESETS`,
  `CLIP_FOR_STATE` — is not added, because it would fail on the code it is meant
  to protect. Its **positive** half (the spine exists, canonical files carry no
  runtime state) is added and passing.

### The API (§13.3, §14.3)

No `/api/prefabs*` endpoints. Adoption is implemented as `planAnimationAdoption`
/ `planPrefabAdoption` — pure, tested, and the part that was ambiguous — but
nothing serves or applies a plan, so §18.7's requirement that the tests "drive
the real route and transaction engine" is not met. The delete policy
(`prefabDeleteBlockers`) is likewise implemented and unserved.

### Props (§11.4)

`migrateEntity` throws on a `prop` entity rather than inventing a Prefab shape
nothing exercises. The demo project authors no props, so this path has never run.
A migration that silently dropped a prop would be worse than one that refuses.

### Visual tests (§18.10)

`pnpm harness:visual` was run: **201 passed**, desktop and narrow, 10.9 minutes,
source checkout unchanged. That is the *existing* suite — the Scene Editor still
renders entities, so nothing in it exercises a GameObject hierarchy, an "Open
Prefab" action or an instance-only override badge. §18.10's visual assertions are
therefore not met; they arrive with the Scene Editor switchover.

### Replay projection (§18.3)

Replay traces were not re-projected through the migration id map, because no
replay fixture drives the GameObject runtime yet.

---

## 9. One-shot verification

`harness:one-shot` runs every stage in this document plus the build and the
visual suite, and it now includes the six Prefab stages and the three GameObject
stages, ordered after the animation-asset stages and before the test suites — a
Prefab whose Animator names a missing Motion Set should surface there rather than
later as a GameObject that will not tick.

| Run | Result | Duration | `git status --short` after |
| --- | --- | --- | --- |
| 1 | 42/42 stages passed | 681.5s | clean |
| 2 | see below | — | — |

Both runs started from a committed, clean tree. `reports/one-shot-report.md` is
gitignored as a harness artifact, so it does not dirty the tree between runs;
this audit is un-ignored explicitly, matching the convention the repository
already uses for deliverable reports.
