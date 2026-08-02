# Handoff — Multi-Instance World and Operability Harness

**Agent:** `main-opus-world-harness`
**Actual model:** `claude-opus-5`
**Starting SHA:** `c684dafb1ceadc252ab9621674c32e32d117bcf7`
**Branch:** `claude/multi-instance-world-harness`

## Orchestration: recorded as NOT FOLLOWED

The work package specifies seven subagents across four model tiers, each with an
isolated worktree, a task manifest written before delegation, and a returned
handoff. **None of that happened.** No subagent ran, no worktree was created,
and no handoff was returned by anybody.

Two reasons, stated plainly:

1. The tiered models the work package names — "Claude Opus 5 Low",
   "Claude Sonnet 5 High", "Claude Sonnet 5 Low" — are not addressable as
   distinct agents in this environment.
2. The schema, world runtime, intent routing and capability contracts turned out
   to be coupled the way the repository's own prior orchestration record warned
   that schema and asset resolution were. Splitting them across parallel
   worktrees would have produced four divergent versions of one contract to
   merge, not four reviewed increments.

The work package's own §8.2 covers this case: do not fabricate a handoff, record
that the agent was unavailable, let the main agent perform the task, and mark
orchestration as not followed. That is what this document does.

**Consequence for the evidence:** the gate reviews are self-reviews by the
implementing agent. They contain real analysis and real refusals, but a
self-review is weaker evidence than an independent one, and no claim in this
branch should be read as having survived an adversarial reviewer.

## Files changed

**New packages**

- `packages/world-runtime/**` — intent sources, world resolution, `WorldRuntime`,
  observation, world traces, world replay
- `packages/capability-runtime/**` — manifest types, registry, completeness
  rules, world commands, the reference capability

**Canonical schema**

- `packages/schema/src/world.ts` (new), `project.ts` (optional `world`),
  `validate.ts` (`validateWorldReferences` + world checks in
  `validateProjectReferences`), `index.ts`

**Runtime**

- `packages/replay-runtime/src/replay.ts` — `computeMetrics` exported (one line
  plus a comment) so the world projection uses the same arithmetic rather than a
  copy

**Browser**

- `apps/web/src/world/world-engine.ts`, `apps/web/src/components/world/{WorldPanel,WorldViewport}.tsx`
- `apps/web/src/store.ts` — world slice, integrated by the main agent
- `apps/web/src/three/characters/ProceduralCharacter.tsx` — optional `pose`
  closure so the world viewport drives the same rig
- `apps/web/src/App.tsx`, `styles.css`, `test-driver.ts`, `vite.config.ts`

**API**

- `apps/api/src/routes/capabilities.ts` (new), `app.ts` (mount + read-only
  exemption for non-mutating commands)

**Harness**

- `harness/check-world.ts`, `harness/check-capabilities.ts` (new)
- `harness/one-shot.ts` — both stages inserted before the test suites
- `harness/repo-guard.ts` — ninth stage, `worldContractGuardStage`

**Canonical data / generated**

- `projects/demo-character/project.json` — carries the acceptance world
- `schemas/{WorldDefinition,RuntimeInstanceDefinition,IntentTrackDefinition}.schema.json`,
  `schemas/ProjectDefinition.schema.json`, `generated/unity/**`

**Docs**

- `ARCHITECTURE.md`, `DECISIONS/0009`, `0010`, `0011`

## Contract decisions made

Every decision is recorded in DECISIONS 0009–0011 and the Gate A audit. The four
that most constrained everything after them:

1. `ProjectDefinition.world` optional, legacy synthesized on read, never
   auto-written.
2. Declaration order is tick order, iterated over a captured array.
3. Legacy replay/trace shapes unchanged; world containers versioned alongside;
   projection asserted byte-identical.
4. No `apply_patch`-shaped command, ever.

## Commands run

See `reports/multi-instance-world-harness.md` for the full table with exit
codes.

## Known failures

None outstanding at the time of writing. Two were found and fixed during the
work rather than shipped:

- The world visual suite failed 9/9 on the first run because
  `@atc/world-runtime` was not aliased in `apps/web/vite.config.ts`, so the app
  never booted. Adding the alias and the workspace dependency fixed it. The
  first run is recorded here rather than deleted: a suite that has never failed
  has not been shown to be running.
- The repo-guard mutable-state check initially flagged intent-track keyframes,
  which legitimately carry an authored `tick`. Scoping it to instance
  declarations fixed it.

## Unresolved questions

- Whether the demo project *should* carry the acceptance world, or whether the
  fixture should be reachable by a route instead. It carries it, because the
  human workflow requires "open the chamber and see two instances" and a fixture
  only a test can reach is the hidden path the work package forbids. The cost is
  that legacy synthesis is no longer the default path exercised by opening the
  app; it is covered by `legacyDemoProject()` fixtures instead.
- Whether `RuntimeInstanceOverrides.moveSpeedScale` should exist at all. It is
  declared and validated but nothing reads it yet — see the limitations note in
  the report.

## Out-of-scope observations

- `ChamberEngine` conflates device polling, the fixed-step clock, the
  simulation and the replay recorder. `WorldChamberEngine` deliberately does
  not, which means the two engines now differ in shape. Unifying them is a
  worthwhile follow-up and was explicitly not attempted here.
- `frameAt` is still a linear scan, now called once per replay-sourced instance
  per tick. Fine at fixture lengths; a binary search would be cheap.

## Forbidden-file statement

Not applicable in the usual sense: there were no subagents, so there was no
ownership boundary to violate. The main agent owns every file in this branch,
which is precisely the weakness this document is recording.
