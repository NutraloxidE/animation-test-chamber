# GameObject Prefab production cutover — audit

**GAMEOBJECT PREFAB PRODUCTION CUTOVER: HOLD**

## Identity

| | |
| --- | --- |
| Branch | `claude/new-session-5h8bdp` (the branch this session was assigned; the work package names `claude/new-session-j71ojl`, whose tip is the same start SHA) |
| Start SHA | `17f4386a3baf09ec244029d32ce00ccbf269fd7d` |
| End implementation SHA | `02b702b` (see the commit list) |
| Merge base with `origin/claude/new-session-j71ojl` | `17f4386a3baf09ec244029d32ce00ccbf269fd7d` |
| Clean working tree | PASS — `git status --short` empty after both one-shot runs |
| `main` merged or rebased | No |
| Force-push | No |

Commits:

```text
01f4e73  Draw a GameObject from its Components, not from what kind of thing it is
fdfe70a  Give a Prefab its own route, and make the rig route a redirect
3867e3b  Record the cutover as HOLD, and the two steps that are actually done
b016bf3  Show one viewport at a time, and stop sending specs through the old front door
02b702b  Keep the Prefab surfaces inside their own box at every width
```

## Why this is HOLD

Two of the nine ordered steps are complete. The production Scene composition
path is still the legacy one: the Scene Editor and its viewport iterate
`scene.entities`, Scene operations write `entities`, `Project.characters` and
`Scene.entities` are still canonical, and `gameObjects` is still generated from
`entities` by `prefabs:migrate`.

Per §18, anything less than the full cutover is HOLD, and no gate below is
claimed on the strength of work that was not done.

## What was built

### 1. GameObjectRenderer production path (§3)

- `apps/web/src/game-objects/render-projection.ts` — pure, React-free and
  Three-free. Derives drawables per Component: `ModelRenderer`, `Animator`,
  `CharacterMotor`, `Light`, `Camera`, `EquipmentSockets`, `CapsuleCollider`. A
  node may carry any subset; there is no kind and no switch on one.
- `apps/web/src/game-objects/GameObjectRenderer.tsx` — accepts a
  `RuntimeGameObject` or a projection derived from one. It accepts no
  `CharacterDefinition`, no Character id, no entity kind, and never selects a
  model from a Prefab id.
- Active camera resolves `activeCameraGameObjectId → RuntimeScene.get(id) →
  CameraRuntime`, with no fallback to "the first camera".
- Missing required Components are reported, not rendered around
  (`motor-without-animator`, `active-camera-without-camera-component`,
  `unknown-active-camera`, `scene-resolution-failed`).
- The generated Prefab index now carries documents as well as summaries, and
  `registryFromPrefabLibraryIndex` builds the same `PrefabAssetRegistry` class
  the harness and API use. This is what lets the browser resolve a Prefab with
  no API server behind it.

### 2. Prefab routes and editor (§4)

- `/prefabs` — inventory with the seven required filters. Filters are Component
  questions (`Characters` = Animator + CharacterMotor), not name or tag
  questions. Each row shows display name, id **and exact version**, derivation,
  abstract/placeable, Component badges, Scene usage count and nested usage
  count, from `describePrefabUsage` — no UI-side scan.
- `/edit/prefab/:prefabId` — panels: Hierarchy, Components, Component Inspector,
  Viewport, Usage, Dependencies, Version/derivation, plus Prefab Overview
  (derivation, parent, patches, nodes, Components, model, Animator references,
  capsule, sockets, nested Prefabs, Scene holders, Prefab holders).
- The Viewport draws through the **production** `GameObjectRenderer`; there is
  no second preview drawing path.
- Selecting an Animator mounts the existing animation authoring workspace. This
  is an adapter with a stated shelf life: it still keys off the store's
  animation subject, which §9's `AnimationSubjectDefinition` replaces.
- `/edit/rig/:characterId` is a redirect only, to
  `/edit/prefab/<prefabId>?component=animator`. The old editor does not mount
  first. An unmapped legacy id is a not-found, not a guess.
- `LEGACY_CHARACTER_PREFAB_IDS` moved to `packages/schema/src/migration.ts`;
  the migration and the redirect import the same table.
- `/` now opens `/prefabs` instead of redirecting through
  `project.activeCharacterId` — a field the cutover removes.

### 3. Harness

`harness:game-object-renderer` (`harness/check-game-object-renderer.ts`), wired
into `harness:one-shot` after the GameObject stages. Five stages:

```text
every required composition renders from its Components      PASS
a disabled GameObject draws nothing and takes nothing with it PASS
the active camera resolves through its Camera Component      PASS
a missing required Component is an error, not a fallback     PASS
the canonical Scene renders from gameObjects alone           PASS
```

The composition stage builds all seven required compositions as real Prefabs and
asserts each drawable fact independently, including the animated prop with no
motor and the character with a light — neither of which the entity renderer
could represent.

## Legacy removal matrix

| Legacy surface | State |
| --- | --- |
| `Project.characters` | Still canonical. Still read by the store, Asset Library, animation resolution. |
| `activeCharacterId` | Still canonical. No longer used for routing (`/` goes to `/prefabs`). |
| `Scene.entities` | Still canonical and still the Scene Editor's source. |
| `activeCameraEntityId` | Still canonical. |
| Entity union (`Character/Prop/Light/Camera`) | Still present. |
| Character-based renderer | `<Character/>` still used by the animation workspace; **not** used by `GameObjectRenderer`. |
| `/edit/rig/:characterId` editor | Removed as an editor; redirect only. |
| `RigEditorPage` | No longer mounted by the router; the file remains, unreferenced. |
| Legacy Scene operations | Unchanged (`scene.place_asset`, `scene.delete_entity`, …). |
| `gameObjects` generated from `entities` | Still generated by `prefabs:migrate`. |

## Production consumer matrix

| Consumer | Reads |
| --- | --- |
| Prefab Editor viewport | `RuntimeGameObject` → `GameObjectRenderer` |
| Prefab list / Overview / Usage | Prefab Registry + `describePrefabUsage` |
| Legacy rig route | `LEGACY_CHARACTER_PREFAB_IDS` only |
| Scene Editor viewport | **`scene.entities`** — not cut over |
| Scene Editor hierarchy/inspector/operations | **`scene.entities`** — not cut over |
| API save paths | **legacy** — not cut over |
| Unity export | **legacy** — not cut over |
| Asset Library | animation assets only — not cut over |

## Route evidence

| Route | Behaviour |
| --- | --- |
| `/` | → `/prefabs` (replace) |
| `/prefabs` | inventory, seven filters |
| `/edit/prefab/navigator` | resolves `navigator@1.0.0` exactly |
| `/edit/prefab/no-such-prefab` | not-found, no fallback |
| `/edit/prefab` | not-found, no fallback |
| `/edit/rig/demo-humanoid` | → `/edit/prefab/navigator?component=animator` |
| `/edit/rig/alternate-humanoid-character` | → `/edit/prefab/relay?component=animator` |
| `/edit/rig/sentinel` | → `/edit/prefab/sentinel?component=animator` |
| `/edit/rig/quaternius-knight` | → `/edit/prefab/quaternius-knight?component=animator` |
| `/edit/rig/quaternius-universal-base` | → `/edit/prefab/quaternius-universal-base?component=animator` |
| `/edit/rig/no-such-character` | not-found, no guess |

Asserted in `tests/unit/routing/prefab-routes.test.ts` (15 tests) and
`tests/visual/routing/prefab-binding.spec.ts`.

## Command results

Run from a clean tree at `02b702b`:

```text
pnpm install --frozen-lockfile          PASS
pnpm schema:generate                    PASS
git diff --exit-code -- schemas         PASS  (no drift)
pnpm prefabs:migrate                    PASS
pnpm prefabs:check                      PASS
pnpm assets:prefabs:index               PASS
pnpm assets:animation:index             PASS
pnpm unity:export                       PASS
pnpm typecheck                          PASS
pnpm lint                               PASS
pnpm build                              PASS
pnpm harness:check                      PASS
pnpm harness:animation-assets           PASS
pnpm harness:prefabs                    PASS  6/6
pnpm harness:game-objects               PASS  3/3
pnpm harness:game-object-renderer       PASS  5/5   (new)
pnpm harness:world                      PASS
pnpm harness:scenes                     PASS
pnpm harness:character-control          PASS
pnpm harness:capabilities               PASS
pnpm harness:unit                       PASS  617 tests
pnpm harness:integration                PASS  233 tests
pnpm harness:replay                     PASS
pnpm harness:repo-guard                 PASS  13/13
pnpm harness:prefab-api                 NOT RUN — the harness does not exist yet
pnpm harness:legacy-removal             NOT RUN — the harness does not exist yet
pnpm harness:visual                     PASS  204 passed, 6 skipped, checkout unchanged
git status --short                      clean
```

`pnpm harness:one-shot`, twice, from a clean tree:

```text
run 1   47/47 stages passed in 1051.4s   exit 0   git status --short: clean
run 2   47/47 stages passed in 1135.3s   exit 0   git status --short: clean
```

Both runs include the new `harness:game-object-renderer` stages. **What this is
not evidence for:** it is not evidence that the cutover happened. The one-shot
gate asserts the repository is internally consistent and every existing contract
holds; it contains no stage that would fail because production still composes
Scenes out of `entities`. That is precisely why the two missing harnesses —
`harness:prefab-api` and `harness:legacy-removal` — are part of the definition of
done, and why a green one-shot here means "nothing was broken", not "the
switchover is complete".

## Coverage changed, stated rather than dropped

The visual routing specs moved to the Prefab routes. Two assertions the
Character Overview carried are now `test.fixme` in
`tests/visual/routing/prefab-binding.spec.ts`:

- per-reference ownership badges (`SHARED BY 5`, holder lists, override count,
  rig compatibility);
- the preview-model override's `PREVIEW ONLY` / resets-on-navigation contract.

Both contracts still hold in canonical data. What is missing is the surface: the
Prefab Overview names references and holders but not per-reference ownership,
and the Prefab Editor has no preview override control. They are marked, not
deleted, so the gap is visible in the runner output.

## Regressions found and fixed during verification

Three, all caused by the route change and all caught by the visual suite:

- every spec that reached the chamber by loading `/` found no chamber, because
  `/` is the Prefab inventory now;
- the Prefab Editor mounted its own preview canvas beside the animation
  workspace's, and two live WebGL canvases competed for the same software
  rasteriser — the sword-recovery test timed out at 90s on desktop while passing
  on other viewports;
- the narrow layout scrolled horizontally, because a Component's JSON cannot
  wrap and the workspace was nested inside a padded flex cell.

## Not done

Steps 3–9 of the required order, in full:

3. Scene runtime and Scene Editor cutover to `resolveSceneGameObjects()` /
   `instantiateScene()` / `RuntimeScene`, with GameObject hierarchy rows and the
   seven required Inspector actions.
4. The thirteen production GameObject Scene operations and their repository
   apply path.
5. Prefab read/write APIs, both adoption endpoints, exact-target transactions,
   409-on-stale with zero writes.
6. Exact-target confirmation UI and the displayed/request/response/diff equality
   assertion.
7. `AnimationSubjectDefinition`; `legacy-project.ts`, `legacy-scene.ts`,
   `controller-binding.ts`; converter injection at the load boundary.
8. Canonical removal of `characters`, `activeCharacterId`, `entities`,
   `activeCameraEntityId`; required `Scene.gameObjects`; demo-project migration;
   stop generating the mirror; remove the dual-view comparison harness.
9. Asset Library Prefab browsing and delete policy; Unity export from
   `Scene.gameObjects`; Repo Guard rules; `harness:prefab-api` and
   `harness:legacy-removal`.

## Declaration

```text
GAMEOBJECT PREFAB PRODUCTION CUTOVER: HOLD

Start SHA:                              17f4386a3baf09ec244029d32ce00ccbf269fd7d
End Implementation SHA:                 fdfe70a49138dcb62ec72d9af8fbe1537c54a72a
Clean Working Tree:                     PASS

GameObjectRenderer:                     PASS
RuntimeScene Production Use:            FAIL   (Prefab Editor only; Scene path unchanged)
No Entity Renderer/Runtime:             FAIL   (Scene Editor still iterates entities)
Prefab Routes/Editor:                   PASS
Scene GameObject Editor:                FAIL

GameObject Operations:                  FAIL
Prefab Read/Publish API:                FAIL
Animation → Prefab Adoption:            FAIL
Prefab → Scene Adoption:                FAIL
Repository Transactions:                FAIL
Stale Snapshot Refusal:                 FAIL
UI / Request / Actual Equality:         FAIL
Non-Target Immutability:                FAIL

AnimationSubjectDefinition:             FAIL
Canonical Project Legacy Removal:       FAIL
Canonical Scene Legacy Removal:         FAIL
Legacy Migration Boundary:              FAIL
Demo Project Migration:                 FAIL
No Generated Scene Mirror:              FAIL

Asset Library:                          FAIL
Unity Cutover:                          FAIL
Repo Guard:                             FAIL   (no rules for the new legacy surfaces)

Typecheck/Lint/Build:                   PASS
Schema/Prefab/Unity Generate:           PASS
Prefab API Harness:                     FAIL   (does not exist)
GameObject Renderer Harness:            PASS   5/5
Legacy Removal Harness:                 FAIL   (does not exist)
Unit/Integration/Replay:                PASS
Visual Desktop/Narrow:                  PASS   204 passed, 6 skipped
One-Shot Run 1:                         PASS   47/47, clean tree
One-Shot Run 2:                         PASS   47/47, clean tree

Decision:
GAMEOBJECT PREFAB PRODUCTION CUTOVER: HOLD
```
