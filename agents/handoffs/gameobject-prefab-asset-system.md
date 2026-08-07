# Handoff — GameObject Prefab Asset System

**GameObject Prefab Asset System: HOLD.**

The canonical spine — schema, registry, resolver, usage graph, runtime,
migration, harness, tests — is built and green. The production switchover is not
started. Details and the full outstanding list are in
`reports/gameobject-prefab-migration-audit.md`; this document is the shortest
thing a next session can start from.

- Repository: `NutraloxidE/animation-test-chamber`
- Branch: `claude/new-session-j71ojl`
- Start SHA: `671cce03236de84daa75f80ceaa8d868150d854a`
- End implementation SHA: `02488a6` plus this commit — five in total: the system,
  the decision records and adoption planning, the node-local character fix, the
  ARCHITECTURE section, and the audit report the .gitignore had been swallowing
- `main` was neither merged nor rebased. Nothing was force-pushed. No published
  asset version was modified in place.

---

## What exists now

```text
GameObjectPrefabAsset            versioned, content-hashed, immutable
  ↓ resolveGameObjectPrefab      variant chain → patches → nested expansion
ResolvedGameObjectPrefab         deep-owned immutable
  ↓ + GameObjectInstanceDefinition
ResolvedGameObjectDefinition     one Prefab as one Scene placement sees it
  ↓ instantiateGameObject
RuntimeGameObject                every mutable byte, never serialized
```

New packages: `@atc/prefab-runtime`, `@atc/game-object-runtime`.
New schema modules: `assets.ts`, `transform.ts`, `prefab.ts`, `prefab-save.ts`.
New harness commands: `assets:prefabs:index`, `prefabs:migrate`, `prefabs:check`,
`harness:prefabs`, `harness:game-objects` — the last two are wired into
`harness:one-shot`, after the animation-asset stages and before the test suites.

Seven Prefabs on disk under `assets/prefabs/`: one abstract
`humanoid-character-base`, five concrete variants of it, one
`default-scene-camera`.

## Where the seam is

`SceneDefinition` carries two views:

- `entities` — what the renderer, `@atc/scene-runtime`, the Unity scene
  projection, the Scene Editor and the apply transaction still read.
- `gameObjects` — derived from `entities` by `pnpm prefabs:migrate`.

`harness:game-objects` compares them instance by instance on every run, so they
cannot drift silently. But two production views of one Scene is exactly what the
work package forbids, and closing that seam is the next session's job.

**Do not hand-edit `gameObjects`.** It is generated. Change `entities`, run
`pnpm prefabs:migrate`, commit both.

## Suggested next steps, in order

1. `<GameObjectRenderer runtimeObject={…} />` replacing `<Character … />`, driven
   by `resolveSceneGameObjects` + `instantiateScene`. This is the change that
   makes `gameObjects` load-bearing rather than derived.
2. `@atc/scene-runtime` reading `gameObjects`. The GameObject runtime already
   composes `ControllableCharacter`, so this is a swap of the resolution front
   end, not a rewrite of the simulation.
3. `/prefabs` and `/edit/prefab/:prefabId`, with `/edit/rig/:id` redirecting
   through the legacy id map in `harness/migrate-character-prefabs.ts`
   (`LEGACY_CHARACTER_PREFAB_IDS`).
4. `/api/prefabs*` endpoints serving `planAnimationAdoption` /
   `planPrefabAdoption` through the existing repository transaction. The planning
   half is done and tested; only the route and the write are missing.
5. Delete `Project.characters[]`, `activeCharacterId` and the entity union, then
   add the repo guard's negative half. Not before: a guard that fails on the code
   it protects trains everyone to ignore it.

## Traps worth knowing about

- **`PrefabNodeDefinition` is recursive**, so it carries a `$id` that a `$ref`
  resolves against. `stripSchemaIds` keeps referenced ids for that reason, and
  the three stored Prefab shapes are registered in `SCHEMA_REGISTRY`
  individually rather than as their union — one compiled schema cannot carry
  that `$id` twice.
- **The usage graph resolves before it counts.** Reading stored payloads reports
  a variant as holding nothing, because a variant stores nothing. That bug was
  found and fixed; if you add a second usage scan anywhere, you will reintroduce
  it.
- **The migration's `createdAt` is a constant.** Wall-clock time would move every
  content hash on every run.
- **`project.ts`'s `CharacterModelBinding` is not `RenderableModelBinding`.** The
  legacy type still carries `rightHandBone` and `weaponGrips`; the new one does
  not, because those became `EquipmentSocketsComponent`. They are deliberately
  not aliased.
- **A prop entity throws.** `migrateEntity` refuses rather than inventing a
  Prefab shape nothing exercises. The demo project has no props; the first one
  added will need this path written.

## Verification

Everything below was run and passed in this session:

```bash
pnpm typecheck && pnpm lint && pnpm build
pnpm schema:generate && git diff --exit-code -- schemas
pnpm prefabs:migrate && pnpm prefabs:check && pnpm assets:prefabs:index
pnpm unity:export
pnpm harness:check                 # 5/5
pnpm harness:animation-assets      # 7/7
pnpm harness:prefabs               # 6/6
pnpm harness:game-objects          # 3/3
pnpm harness:world                 # 1/1
pnpm harness:scenes                # 1/1
pnpm harness:capabilities          # 1/1
pnpm harness:unit                  # 686 tests
pnpm harness:integration           # 233 tests
pnpm harness:replay                # 129 tests
pnpm harness:repo-guard            # 13/13
pnpm harness:visual                # 201 passed, desktop + narrow
pnpm harness:one-shot              # 42/42 twice, clean tree both times
```

The visual suite that passed is the *existing* one: nothing in it exercises a
GameObject hierarchy yet, because the Scene Editor still renders entities. The
§18.10 visual assertions arrive with that switchover.

## Two guards changed, and why

Both were changed because they were wrong, not because they were inconvenient.

- **Schema-relaxation guard.** It compared raw `Type.Optional(` counts per file
  and fired above a threshold. That reports a file which added a *new type* with
  optional members as a relaxation, and says nothing when one existing field is
  quietly relaxed while another is deleted. It now names the field that stopped
  being required.
- **C# reserved words.** The list was the handful of keywords the schemas
  happened to use. A Prefab's `abstract` flag generated `public bool abstract;`,
  which does not compile — in a file nothing in this repository compiles, so
  nothing would have caught it. It is now the whole keyword set.
