# 06 — Multi-instance architecture audit (Gate A)

**Mode:** read-only inventory, performed before any implementation.
**Performed by:** the main agent (`claude-opus-5`). No separate audit subagent
ran — see `agents/handoffs/multi-instance-world-harness.md` for the honest
orchestration record.
**Base:** `c684dafb1ceadc252ab9621674c32e32d117bcf7`

## What the single-instance assumption actually was

The repository was not "single-instance" in one place. It was single-instance in
about a dozen, and they are not all the same kind of problem.

| Where | The assumption | Severity |
| --- | --- | --- |
| `ProjectDefinition.activeCharacterId` | one character runs at a time | canonical; the thing to fix |
| `apps/web/src/engine.ts` (`ChamberEngine`) | owns exactly one `Simulation` | browser-only |
| `apps/web/src/store.ts` | one `engine`, one `project`, one `activeCharacterId` | browser-only |
| `apps/web/src/three/Viewport.tsx` | renders one `<Character>` plus one ghost | browser-only |
| `ProceduralCharacter` | reads `engine.simulationState` directly | browser-only |
| `packages/replay-runtime` `runReplay` | one project, one replay, one trace | canonical shape |
| `ReplayFrame` / `TickRecord` | carry no instance identity | canonical shape |
| `resolveCharacterAnimation` | resolves *the* character, defaulting to active | resolution |
| `packages/unity-export` | exports the resolved active character | export |
| Inspector paths (`/graph/...`) | address the focused character implicitly | observation |

The **good** news, and it shaped every later decision: `Simulation` was already
a self-contained unit of mutable character state. It takes a `SimulationInit`
and owns its clock, its graph runtime, its input buffer and its transform. It
had no module-level state and no singletons. That is why this work package did
not need to reimplement a state machine — it needed to decide *which*
simulations exist, what feeds them, and in what order they run.

The **bad** news: `ChamberEngine` conflated four things — device polling, the
fixed-step clock, the simulation, and the replay recorder. A world engine that
inherited from it would have inherited the conflation.

## Decisions taken at this gate

1. **Additive schema.** `ProjectDefinition.world` optional; `characters` and
   `activeCharacterId` untouched. → DECISION 0009.
2. **Legacy synthesis, never auto-migration.** `synthesizeLegacyWorld` builds a
   one-instance world from `activeCharacterId` on read. `migrateProjectToExplicitWorld`
   exists and is never called on load.
3. **Replay: version alongside, do not rewrite.** → DECISION 0010. The
   decisive argument is that regenerating baselines destroys the evidence they
   exist to provide.
4. **Deterministic iteration: canonical declaration order**, over a captured
   `string[]`, never a `Map`.
5. **Runtime ownership boundary:** `packages/world-runtime` owns instance
   lifetime, intent routing, tick order and observation. It reuses `Simulation`
   and must not import React, Three, Hono or `node:fs` — enforced by a repo
   guard rule rather than by intention.
6. **Observation paths:** `/world/instances/<id>/...`, ids only, no indices.
7. **Capability manifest:** four required surfaces, harness-enforced. →
   DECISION 0011.
8. **Stays project-global in this pass:** terrain preset, camera yaw, input map,
   movement/root-motion/haptics profiles, equipment declarations. Camera yaw in
   particular is world-global on purpose: movement is camera-relative and there
   is one camera, so a per-instance value would let two instances disagree about
   which way "forward" is while sharing a view.
9. **Becomes instance-scoped:** transform, intent source, enabled, seed, weapon
   mode, equipment overrides — the enumerated `RuntimeInstanceOverrides`, not a
   patch list.
10. **Shared critical integration points:** `packages/schema/src/index.ts`,
    `apps/web/src/store.ts`, `apps/api/src/app.ts`, `harness/one-shot.ts`,
    `harness/repo-guard.ts`, `package.json`, `tsconfig.base.json`,
    `vitest.config.ts`, `apps/web/vite.config.ts`, `projects/demo-character/project.json`.

## Blocking questions

None outstanding. Two were resolved during the audit rather than deferred:

- *Does a per-instance camera yaw make sense?* No — see (8).
- *Should the demo project carry the acceptance world, or should it be reachable
  only via a route?* The demo project carries it. The human workflow requires
  "open the chamber, see two instances", and a fixture reachable only by a test
  is exactly the hidden path the work package forbids. The cost is that legacy
  synthesis stops being the default path, which is why it now has an explicit
  fixture (`legacyDemoProject()`) rather than being assumed.

**Gate A: PASS.**
