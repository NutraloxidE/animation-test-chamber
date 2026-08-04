# Handoff — Route-Scoped Rig / Scene / ControllableCharacter

Work package: `WP_ROUTE_SCOPED_RIG_SCENE_CONTROLLABLE_CHARACTER`
Branch: `claude/edit-rig-scene-controllable-character`
Base: `2e5b2a21a269f41aad7f14c00b0cded91233f33f` (see §1)

**Phases 0–5 of 11 are complete. Phases 6–11 are not started.** Nothing in this
document describes work that was not run, and no result below was projected
from a diff.

---

## Summary

The contract layer of the work package is built and tested: Scene schemas, the
explicit World-to-Scene migration, `ControllableCharacter`, `SceneRuntime`, the
generic document edit session with typed Scene operations, and the repository
Apply endpoint. The user-facing half — routing, the Rig Editor extraction and
the Scene Editor UI — has not been started, so no route in the acceptance
matrix exists yet.

## Files changed

```text
agents/reviews/18-route-rig-scene-baseline-audit.md   new
harness/migrate-scenes.ts                             new
harness/check-scenes.ts                               new
harness/check-world.ts                                modified
harness/repo-guard.ts                                 modified
packages/schema/src/constants.ts                      new
packages/schema/src/intent-track.ts                   new
packages/schema/src/scene.ts                          new
packages/schema/src/migration.ts                      new
packages/schema/src/{index,project,validate,world}.ts modified
packages/character-control-runtime/**                 new package
packages/scene-runtime/**                             new package
packages/world-runtime/src/scene-compat.ts            new (transitional)
packages/world-runtime/src/{index,resolve,world-control}.ts modified
packages/editor-core/src/repository-target.ts         new
packages/editor-core/src/operations.ts                new
packages/editor-core/src/document-session.ts          new
packages/animation-asset-runtime/src/migration.ts     modified
apps/api/src/routes/repository-apply.ts               new
apps/api/src/reports.ts                               new
apps/api/src/app.ts                                   modified
projects/demo-character/project.json                  migrated
schemas/*.schema.json                                 regenerated (+7 new)
tests/fixtures/scene.ts                               new
tests/unit/scene/{migration,scene-session}.test.ts    new
tests/unit/character-control/controllable-character.test.ts  new
tests/replay/scene/scene-equivalence.test.ts          new
tests/integration/api/repository-apply.test.ts        new
tests/fixtures/world.ts                               modified
tests/integration/unity/world-export.test.ts          migrated to Scene semantics
```

## Contracts added

- `SceneDefinition` and the four-member entity union over a full
  position/rotation/scale transform; `CharacterControllerBindingDefinition`
  (human/script/ai/replay/none); `SceneAssetReference`.
- `ProjectDefinition.scenes[]` and `activeSceneId`.
- `loadProjectDocument` / `migrateWorldToScenes` — one migration boundary,
  non-writing on load.
- `CharacterIntent = ActionSample`, `CharacterIntentSource`,
  `ControllableCharacter`, five concrete sources.
- `SceneRuntime`, `SceneTrace`, `SceneReplay`, `simulateScene`, scene
  observation.
- `RepositoryDocumentTarget`, `draftKey`, `DocumentEditSession<T, Op>`,
  `SceneOperation` (10 operations), `applySceneOperation`.
- `POST /api/repository/apply`.

## Commands run, and their exact results

Every harness below was run at the branch tip on this machine.

| Command | Result |
| --- | --- |
| `pnpm typecheck` | PASS |
| `pnpm lint` | PASS |
| `pnpm harness:unit` | PASS |
| `pnpm harness:integration` | PASS |
| `pnpm harness:replay` | **FAIL — 1 test, pre-existing (§1)** |
| `pnpm harness:repo-guard` | PASS |
| `pnpm harness:world` | PASS |
| `pnpm harness:scenes` | PASS (new) |
| `pnpm harness:capabilities` | PASS |
| `pnpm harness:animation-assets` | **FAIL — 1 of 7 checks, pre-existing (§1)** |
| `pnpm harness:visual` | **NOT RUN** — Playwright browsers not provisioned |
| `pnpm harness:one-shot` | **NOT RUN** — gated on the two failures above |

New tests added and passing: 39 (migration) + 22 (controllable character) + 17
(scene equivalence) + 34 (scene session) + 10 (apply API) = **122**.

### The two failures are pre-existing and are not mine

Verified by checkout, not by reasoning: `tests/replay/animation-assets/
shared-behavior.test.ts` **passes at `d4be2df`** and **fails at `2e5b2a2`**, the
commit this branch is based on. That commit added authored walk/run speed
overrides to the demo character, which legitimately change simulated motion, and
the committed trace baselines were not regenerated with them. The same cause
produces the `harness:animation-assets` shadow-compare failure.

§22 forbids re-baselining tests to obtain green CI, so neither baseline was
touched. **Someone who knows whether that trace change was intended has to
decide**: regenerate the baselines, or revert the overrides. Until then §29.60
("one-shot passes twice") is unreachable, and that is a data question, not a
code one.

## Assumptions

1. **Base SHA.** The declared base `d4be2df` was not `main`'s head; the actual
   head was `2e5b2a2`, one commit ahead with `d4be2df` as its direct ancestor.
   The deviation was raised before any edit and branching from live `main` was
   chosen explicitly.
2. **Branch name.** The work package's branch name was used rather than the
   session default, on explicit instruction.
3. **Phase 1 keeps `ProjectDefinition.world` declared** as a deprecated,
   migration-only field. Removing it in Phase 1 would have broken every
   un-migrated world test at once; the work package sequences that removal into
   Phase 3's package retirement, which has not happened yet.

## Limitations

- **No routes exist.** `/edit/rig/:characterId` and `/edit/scene/:sceneId` are
  not implemented; there is still no router, and `vercel.json` still has no SPA
  rewrite. Every routing row in the acceptance matrix is unmet.
- **No Scene Editor UI**, no Asset Panel, no gizmos, no drag-and-drop.
- **The Rig Editor has not been extracted** and `apps/web/src/engine.ts:370`
  still steps `Simulation` directly from device input, which §10.6 removes.
- **`@atc/world-runtime` still exists** and is still what the web app and the
  capability layer use. Its production imports were not removed. Two
  transitional bridges keep it working and must be deleted with it:
  `packages/world-runtime/src/scene-compat.ts` (views a Scene as a World) and
  `world-control.ts` (re-exports the moved control track).
- **The capability layer is unchanged.** There are no `rig.edit`, `scene.edit`
  or `character.control` groups yet; `world.*` commands remain the machine path.
- **Unity export** emits the migrated project as-is. `IChamberWorld` and the
  World DTOs are unchanged; §19's Scene contracts are not generated.
- **Apply covers scene targets only.** Character targets are refused explicitly
  with a `400` rather than half-handled, because the existing animation-asset
  destination flow owns their blast-radius semantics.
- **`moveSpeedScale` is still declared and unread**, exactly as it was on
  `main`. Wiring it would change every existing trace, so it stays a documented
  gap rather than a silent behaviour change smuggled inside a migration.

## Known follow-up, in the order the work package sequences it

1. Phase 6 — router, route resolvers with no fallback, `vercel.json` rewrite,
   Rig Editor extraction, `ControllableCharacter` rig preview.
2. Phase 7–8 — Scene Editor shell, hierarchy, contextual inspector, viewport,
   gizmos, asset panel, typed drag-and-drop.
3. Phase 9 — capability groups and the target-aware command context.
4. Phase 10 — retire `@atc/world-runtime`, migrate its tests, remove
   `ProjectDefinition.world` and the two transitional bridges, Unity Scene
   contracts, docs and Decision Records.
5. Phase 11 — full regression, one-shot twice, independent review.

## Protection impact

Unchanged in strength, wider in reach. `DocumentEditSession.dispatch` evaluates
protection before an operation runs, on every path it would touch, for the actor
that asked — so Inspector edits, gizmo drags, drops, AI commands and scripted
commands pass one gate instead of four. Locked entities are refused for `human`
and `ai` alike unless a human explicitly unlocks the path; asserted in
`tests/unit/scene/scene-session.test.ts`.

One guard was deliberately changed, and the repo guard asked for it to be said
explicitly: `schemaConstraintStage` now compares the package-wide count of
`additionalProperties: false` as well as the per-file count. A per-file count
alone cannot distinguish a deleted constraint from a moved one, and reading five
constraints as "vanished" when they were extracted into a new module trains
everyone to ignore the guard. A genuinely dropped constraint still fails.

## Migration impact

`projects/demo-character/project.json` was migrated by `pnpm scenes:migrate`
and no longer carries `world`. Loading never rewrites; `pnpm scenes:check`
asserts the committed form is the migrated form, and `harness:scenes` asserts
migration idempotence against the committed data.

`harness:world`'s "the project carries the acceptance world" check became "the
project carries the acceptance scene", comparing against the migrated fixture —
the same drift check in the shape the document now has.

## Generated-artifact impact

`pnpm schema:generate` regenerated `schemas/`, adding seven Scene schemas and
updating three. `RuntimeInstanceDefinition.schema.json` and
`WorldDefinition.schema.json` changed only because the legacy transform was
renamed to `LegacyTransformDefinition` to clear the name for the Scene
transform. No Unity artifact was regenerated: §19 is Phase 10 work.

## Final declaration

```text
Route-Scoped Rig / Scene / Controllable Character WP: INCOMPLETE (phases 0-5 of 11)

Exact Main Base:                             DEVIATED — declared d4be2df, used 2e5b2a2 (§1), agreed
Implementation Branch:                       PASS
Removed-World-Alt Excluded:                  PASS — never fetched, merged or read

Scene Canonical Schema:                      PASS
Legacy World Migration:                      PASS
No Write on Migration Load:                  PASS
Scene Runtime:                               PASS
ControllableCharacter Contract:              PASS
Single CharacterIntent Shape:                PASS
Human / Script Equivalence:                  PASS — byte-identical, 60 ticks
Human / AI Equivalence:                      PASS
Instance Runtime Isolation:                  PASS
Generic Edit Session:                        PASS
Preview / Stage Separation:                  PASS
Stage / Apply Separation:                    PASS
Atomic Repository Apply:                     PASS — scene targets only
Revision Conflict Refusal:                   PASS
Git Separation:                              PASS
Observation Paths:                           PASS — entity-id-qualified
Protection Enforcement:                      PASS

Rig Route:                                   NOT IMPLEMENTED
Scene Route:                                 NOT IMPLEMENTED
Nested Route Deployment:                     NOT IMPLEMENTED
Scene Hierarchy:                             NOT IMPLEMENTED
Contextual Inspector:                        NOT IMPLEMENTED
Scene Asset Panel:                           NOT IMPLEMENTED
Typed Drag and Drop:                         NOT IMPLEMENTED
Transform Gizmos:                            NOT IMPLEMENTED
Capability Completeness (new groups):        NOT IMPLEMENTED
Unity Generation (Scene contracts):          NOT IMPLEMENTED

Typecheck / Lint:                            PASS
Unit:                                        PASS
Integration:                                 PASS
Replay:                                      FAIL — pre-existing baseline (§1)
Visual:                                      NOT RUN — no browsers in this environment
Repo Guard:                                  PASS
One-Shot Run 1:                              NOT RUN
One-Shot Run 2:                              NOT RUN

Final Independent Review:
HOLD — no independent reviewer has run, and §21 Task I says that is a HOLD
```
