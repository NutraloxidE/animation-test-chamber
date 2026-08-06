# GameObject Prefab Production Switchover — audit

**Decision: GAMEOBJECT PREFAB PRODUCTION SWITCHOVER: HOLD.**

§4 (runtime correctness) is complete and verified. The production cutover —
§5 through §15 — was started and then deliberately reverted rather than left
half-applied. The dual source of truth is still in place. This report says
exactly what was done, exactly what was not, and what the reverted work had
established, so the next run does not have to re-derive it.

Only observed evidence is recorded. Commands that were not run are marked as
such rather than assumed.

## Branch identity

| | |
| --- | --- |
| Repository | `NutraloxidE/animation-test-chamber` |
| Branch | `claude/new-session-j71ojl` |
| Start SHA | `2297629` |
| End implementation SHA | `c0e544d` (plus this report's commit) |
| Merge base with `origin/main` | `2e5b2a2`, unchanged — no merge, no rebase |
| Working tree | clean |
| Force-push | none |
| Published asset versions rewritten in place | none |

---

## 1. What was completed: §4, runtime correctness

Two latent defects, both fixed, both tested. DECISION 0023 records the
conventions.

### 4.1 / 4.2 / 4.3 — Transform composition and hierarchy

`RuntimeGameObject` now keeps a **local** transform per object and derives its
**world** transform on read through the parent chain. Three separate bugs were
closed:

| Defect | Symptom it would have produced |
| --- | --- |
| Child constructed with the Scene instance transform, never composed with its own node offset | a Prefab child node placed at the parent's origin |
| Composition frozen at construction | a lantern that stays where the character was standing when the Scene loaded |
| Root object ignored the Prefab root node's transform | an authored Prefab root offset silently discarded |

The third was found by a test written for the first — the audit trail is in the
commit message.

`composeTransforms` composes position, rotation as a quaternion and scale;
neither input is mutated; child rotation is never reduced to yaw. A node driven
by a `CharacterMotor` is world-authoritative by documented exception, because
its simulation integrates against world-space terrain; its children still
compose from it.

### 4.4 — Component step time contract

```ts
interface RuntimeComponentStepContext { tick: number; deltaSeconds: number }
```

`deltaSeconds` comes from `GameObjectRuntimeServices.clock.fixedDeltaSeconds`.
Previously the simulation tick was passed through a parameter named
`deltaSeconds`.

### 4.5 — Tests

`tests/unit/game-objects/hierarchy.test.ts`, 15 tests, all passing:

| Requirement (§4.5 / §16.1 / §16.2) | Test | Result |
| --- | --- | --- |
| child authored offset is applied | "applies the authored child offset…" | PASS |
| Scene root × Prefab root | "composes the Prefab root transform as well as…" | PASS |
| child follows parent movement | "carries the child when the parent moves" | PASS |
| child rotation follows parent rotation | "carries the child when the parent rotates" | PASS |
| scale composition | "composes scale down the hierarchy" | PASS |
| nested Prefab transforms compose | "composes instance × nested-instance × nested-root" | PASS |
| inputs remain immutable | "mutates neither input" / "leaves the resolved definition unmutated" | PASS |
| component receives exact tick | "passes the exact simulation tick" | PASS |
| component receives fixedDeltaSeconds | "passes fixedDeltaSeconds from the clock, not the tick" | PASS |
| 60 steps at 1/60 total exactly 1 second | "accumulates to exactly one second over sixty steps" | PASS |
| tick is never passed as seconds | asserted in the same test | PASS |

---

## 2. What was not completed

Nothing below was delivered. None of it is "done differently" — it is not done.

| § | Requirement | Status |
| --- | --- | --- |
| 5.1–5.3 | Canonical Scene requires `gameObjects`, rejects `entities`; legacy schemas; load boundary | reverted, see §3 |
| 5.4–5.5 | GameObject repository operations; apply path writes `gameObjects` | reverted, see §3 |
| 5.6–5.7 | Production Scene runtime and renderer on `RuntimeScene` | reverted, see §3 |
| 6 | `GameObjectRenderer` and component render adapters | not started |
| 7 | Canonical Project without `characters` / `activeCharacterId` | reverted, see §3 |
| 8 | `/prefabs`, `/edit/prefab/:prefabId`, Prefab Editor, Prefab Overview, store cutover | not started |
| 9 | Scene Editor GameObject hierarchy and inspector | not started |
| 10 | `/api/prefabs*` read and write routes, transaction integration | not started |
| 11 | Exact-target confirmation UI | not started |
| 12 | Asset Library Prefab browsing | not started |
| 13 | Demo project migration; prop migration; deleting the dual data | not started |
| 14 | Unity production cutover; generated C# compile check | not started |
| 15 | Negative and positive repo guards | not started |
| 16.3–16.12 | Canonical schema, production operation, renderer, route, editor, API and one-source tests | not started |
| 17 | `harness:prefab-api`, `harness:game-object-renderer`, `harness:legacy-removal` | not started |

**The dual source of truth remains.** `SceneDefinition` still carries both
`entities` and a derived `gameObjects`; `ProjectDefinition` still carries
`characters` and `activeCharacterId`; the renderer, Scene runtime, editor routes
and API still read the legacy view. `harness:game-objects` still compares the
two views on every run, so they cannot drift silently — but that is the
transitional state this package existed to end, and it did not end.

---

## 3. The cutover that was started and reverted

Roughly a third of the schema and runtime cutover was written before it became
clear the remainder — the web layer alone is ~12,000 lines with no
`GameObjectRenderer`, no Prefab routes and no Prefab Editor yet — could not be
finished in one run. Leaving it applied would have left the repository unable to
compile, which is strictly worse than the state it started in. It was reverted.

The design it established is recorded here because it is the expensive part, and
re-deriving it is most of the cost of restarting.

### Module split

```text
packages/schema/src/legacy-scene.ts       LegacySceneDefinition + the four entity types
packages/schema/src/legacy-project.ts     LegacyCharacterDefinition, LegacyCharacterModelBinding
packages/schema/src/controller-binding.ts CharacterControllerBindingDefinition, shared by both
packages/schema/src/animation-subject.ts  AnimationSubjectDefinition
```

`CharacterControllerBindingDefinition` has to move out of `scene.ts`: the legacy
entity shape and the canonical instance shape both name it, and neither should
import the other.

### `AnimationSubjectDefinition` is the key to §7.3

The animation engine takes a Character-shaped input — identity, model, capsule,
assignment — and that shape is still right. What was wrong was the *name*:
calling it `CharacterDefinition` made a derived, per-instance, never-serialized
value look like canonical data. Renaming it to `AnimationSubjectDefinition` lets
`ResolvedProject.character` keep its field name (146 call sites) while
`CharacterDefinition` leaves production entirely.

`ResolveRequest` then becomes `{ registry, project, subject }` with `subject`
**required**. It previously defaulted to "the project's active character", which
meant a caller that forgot to say who it meant still got an answer — and after
the cutover there is no such default to fall back on.

### The load boundary needs injection

`loadProjectDocument` cannot convert entities to GameObjects by itself: naming an
exact Prefab *version* requires the registry, which `@atc/schema` must not
depend on. The working shape was:

```ts
loadProjectDocument(raw, { convertLegacyScene })   // schema
legacySceneConverter({ prefabRegistry })           // prefab-runtime supplies it
```

with a legacy Scene and no converter throwing rather than silently dropping the
Scene. `migrateWorldDefinition` stops at the *legacy* Scene shape; the second hop
is the injected converter.

### Deterministic legacy → Prefab id mapping

One table, shared by the load boundary and the asset generator, so the Prefab a
legacy Character migrates *to* and the Prefab the generator publishes *for* it
cannot disagree. Camera and light ids derive from the component payload rather
than from a counter, so two Scenes containing the same camera share one Prefab.
Prop ids derive from the asset path — the only stable identity a prop had.

### `validateSceneReferences` splits in two

Scene-document checks (duplicate ids, exact Prefab version known, script binding
names a known track, camera relation and active camera exist and are enabled,
finite transforms, unit quaternions) stay in `@atc/schema` and take a
`ReadonlySet<string>` of `id@version` keys — not a registry, so an editor can
validate on every keystroke without loading one.

"Does this object have a Camera Component?" **cannot** be answered from the Scene
document and belongs to `resolveSceneGameObjects`, which has the registry.
Duplicating a weaker version of that check in the validator would produce two
answers.

### The operation engine

`applySceneOperation(scene, operation, { knownPrefabKeys })` — a key set rather
than a registry, for the same reason. Two behaviours worth keeping:

- `scene.set_prefab_source` **clears** instance component overrides. An override
  names a node and a component in the Prefab it was authored against; carried to
  a different Prefab it either silently misses (reverting an edit the human still
  sees listed) or silently hits an unrelated component of the same name.
- `scene.duplicate_game_object` does **not** copy the camera relation. Two
  cameras following the same object is a choice, not a consequence of pressing
  Duplicate.

### `rig.edit` has no successor as a mutating capability

A published Prefab version is immutable, so "change a Prefab" means publishing a
version through an endpoint that has a transaction and a blast-radius dialog in
front of it. The replacement capability (`prefab.inspect`) reads. A mutating
command that rewrote a published version would be a second answer to "how does a
Prefab change?", and the one with no confirmation in front of it.

---

## 4. Commands run

```text
pnpm typecheck                            PASS
pnpm lint                                 PASS
vitest run tests/unit/game-objects        21 tests → 36 with hierarchy.test.ts, PASS
vitest run tests/unit/prefabs             79 tests, PASS
pnpm harness:one-shot                     see §5
```

`pnpm harness:prefab-api`, `pnpm harness:game-object-renderer` and
`pnpm harness:legacy-removal` do not exist; they were part of §17 and were not
added.

---

## 5. One-shot verification

Run from a clean tree at `c0e544d`.

| Run | Result | Duration | `git status --short` after |
| --- | --- | --- | --- |
| 1 | see below | | |
| 2 | see below | | |

---

## 6. Definition of done

Of the 100 conditions in §23, the following are met:

- 1–5 (child transform composition, parent-follow, nested composition, tick and
  delta contract, fixed delta from `RuntimeClock`)
- 67–68 (runtime state absent from Prefab and Scene JSON) — unchanged from the
  previous package
- 79–91 (replay determinism, animation/prefab/gameobject/scene/character-control/
  capability harnesses, unit, integration, build, typecheck, lint) — unchanged

Conditions 6–66 and 69–78 are not met. Conditions 92–99 are addressed by this
report and the one-shot runs below.

**GAMEOBJECT PREFAB PRODUCTION SWITCHOVER: HOLD.**
