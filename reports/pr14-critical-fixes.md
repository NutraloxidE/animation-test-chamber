# PR #14 critical fixes — verification report

## Identity

| | |
| --- | --- |
| Original reviewed head | `4521873b4943935f73480b995e40f05c3e477040` |
| Last implementation SHA | `68d5036` (`docs: record the PR14 critical fix architecture`) |
| Branch tip | the docs commit containing this file; a commit cannot record its own SHA |
| Branch | `claude/multi-instance-world-harness` |
| Executing agent | `main-opus-pr14-critical-fixes`, model `claude-opus-5` |

## Orchestration compliance — NOT FOLLOWED

The work package specifies five subagents across three model tiers, each with a
task manifest and a returned handoff. **No subagent ran.** The tiered models it
names are not addressable as separate agents in this environment.

Per §6.2: nothing was fabricated, the main agent performed every task, and
orchestration is recorded as not followed. The gate reviews in
`agents/reviews/08-pr14-critical-fix-audit.md` are self-reviews and say so at the
top. `Agent Orchestration Evidence` stays **FAIL**.

## Changed files

**Fix A — resolution isolation**

```
packages/animation-asset-runtime/src/resolver.ts
packages/world-runtime/src/resolve.ts
packages/world-runtime/src/world.ts
packages/world-runtime/src/observation.ts
tests/unit/world/world-contract.test.ts
tests/integration/world/resolution-isolation.test.ts   (new)
tests/visual/world/world-authoring.spec.ts
```

**Fix B — stateless simulation**

```
packages/world-runtime/src/simulate.ts                 (new)
packages/world-runtime/src/index.ts
packages/capability-runtime/src/world-commands.ts
packages/capability-runtime/src/world-capability.ts
packages/capability-runtime/src/manifest.ts
apps/api/src/routes/capabilities.ts
tests/integration/api/capabilities.test.ts
tests/integration/world/ai-workflow.test.ts
tests/unit/capabilities/capability-registry.test.ts
DECISIONS/0011-capability-completeness-contract.md
```

**Fix C — camera-faithful replay**

```
packages/world-runtime/src/world-control.ts            (new)
packages/world-runtime/src/world.ts
packages/world-runtime/src/world-replay.ts
apps/web/src/world/world-engine.ts
tests/replay/world/world-replay.test.ts
tests/integration/world/render-cadence.test.ts         (new)
```

**Harness and docs**

```
harness/check-world.ts
ARCHITECTURE.md
agents/reviews/08-pr14-critical-fix-audit.md           (new)
reports/pr14-critical-fixes*.md/json                   (new)
```

No canonical schema changed. `schemas/**` and `generated/**` are byte-identical
to the reviewed head.

## Issue A — character-safe resolution

**Before.** `resolveWorld` cached the whole `ResolvedProject` under a key built
from animation asset references. A `ResolvedProject` carries the character's id,
display name, `modelAssetPath`, capsule radius and capsule height, so two
different characters referencing one animation set received each other's body.

**After.** Resolution splits into `ResolvedAnimationBundle` — graph, clips,
motion bindings, contextual bindings, context keys, clip asset sources,
provenance, skeleton, rig compatibility key — and a per-character
`ResolvedProject` wrapper built by `materializeResolvedProject`. The cache holds
bundles. `resolveCharacterAnimation` is unchanged as a public entry point.

`resolutionKey` became `animationResolutionKey` and now includes preview
overrides and a canonical, key-order-independent patch serialization.

### The invariant that was removed, and why

> The former test asserting that two instances share the complete
> `ResolvedProject` was replaced because that assertion encoded character-data
> contamination. The corrected invariant shares only immutable
> animation-resolution bundle data.

Concretely, this assertion was deleted:

```ts
expect(controlled.resolved).toBe(scripted.resolved);
```

and replaced by, in a test renamed *shares immutable animation bundle members
without sharing resolved project wrappers*:

```ts
expect(controlled.resolved).not.toBe(scripted.resolved);
expect(controlled.resolved.character).not.toBe(scripted.resolved.character);
expect(controlled.resolved.graph).toBe(scripted.resolved.graph);
expect(controlled.resolved.clips).toBe(scripted.resolved.clips);
expect(controlled.resolved.character.skeleton).toBe(scripted.resolved.character.skeleton);
expect(controlled.resolved.motionBindings).toBe(scripted.resolved.motionBindings);
```

This is the one change in this pass that removes an assertion. It is not test
weakening: the old assertion was **stronger and wrong**, and the new one is
narrower and correct. `harness:world` was carrying the same wrong check and was
corrected the same way.

### Regression tests (A1–A5)

`tests/integration/world/resolution-isolation.test.ts`, 10 tests:

- does not share character-specific resolved data across characters with shared
  animation assets
- shares immutable animation bundle members across characters with shared
  animation assets
- gives one character used twice distinct wrappers and one shared bundle
- does not share a bundle between characters with different animation overrides
- includes preview overrides in animation resolution identity
- ignores fields that only change the character wrapper
- changes when any animation reference changes
- changes when an animation patch changes
- is unaffected by property order inside a patch value
- carries no character identity

The first uses a `knight` (1.85 m, `knight.glb`) and a `mage` (1.62 m,
`mage.glb`) sharing every animation reference, and asserts neither receives the
other's model path or capsule.

## Issue B — stateless simulation

**Before.** `world.preview` advanced a per-request runtime and discarded it;
`world.read_observations` read a fresh one at tick zero. The advertised
`preview → read` sequence was false over HTTP.

**After.** `world.simulate` builds a runtime, advances it, returns the final
observation, the deterministic hash, the instance order and optionally flat
observations and a bounded trace — in one response — then discards the runtime.
`simulateWorld` in `@atc/world-runtime` is the single implementation; the API
route contains no simulation code.

`world.preview` is **removed**, not aliased: the name invites exactly the reading
that was wrong, and PR #14 is unmerged so there is no caller to keep working.
`world.read_observations` remains registered for in-process callers and is
refused over HTTP with a 400 and a structured issue naming `world.simulate`.

Bounds: runs ≤ 10,000 ticks; `includeTrace` ≤ 600 ticks with a structured
refusal above it; the default response carries no trace.

### Regression tests (B1–B7)

`tests/integration/api/capabilities.test.ts`, 15 tests total, 7 new:

- returns final observations from stateless world.simulate over HTTP
- produces the same simulate result in a fresh app instance
- does not write repository bytes while simulating a staged world
- simulates in a read-only repository while mutation stays refused
- advertises no cross-request runtime continuation
- refuses invalid simulate input with structured issues
- bounds trace output

The staged-world test asserts `project.json` is byte-identical afterwards and
that no `.chamber-asset-transactions` directory was created.

## Issue C — camera-faithful replay

**Before.** The recorder wrote `cameraYawRad: 0` unconditionally; playback bound
no control source. A run recorded while the camera turned replayed as a straight
line with byte-identical input frames.

**After.** `WorldControlSource` is sampled inside `WorldRuntime.step()` *before*
instance intent and before any simulation step. `WorldReplay` carries
`controls.cameraYaw`: a tick-keyed, change-only keyframe track with hold
semantics. `createReplayRuntime` binds it itself. `setCameraYaw` throws on a
non-finite value rather than propagating NaN into every position.

`WORLD_REPLAY_VERSION` is **2**. A v1 recording is read explicitly as constant
zero yaw — what it meant — and any other version is refused by name.

### Regression tests (C1–C8)

`tests/replay/world/world-replay.test.ts`, 21 tests total, 9 new:

- replays a constant non-zero camera yaw exactly
- replays changing camera yaw on the exact recorded tick
- applies a yaw change on its own tick and not the one before
- replays two instances on different intent sources under one global camera
- produces the same result from two fresh replay runtimes
- reads a v1 recording as constant zero yaw rather than guessing
- refuses an unsupported world replay version
- refuses malformed replay control data
- refuses a non-finite camera yaw at the runtime boundary

`tests/integration/world/render-cadence.test.ts`, 2 tests:

- produces identical world traces at 30 60 and 120 Hz render cadence
- advances the same number of fixed steps regardless of frame size

This closes the gap PR #14 recorded rather than covered.

## Legacy replay

Unchanged and still byte-identical. The legacy compatibility suite runs all four
committed fixtures through a one-instance world and asserts
`JSON.stringify(projected.ticks) === JSON.stringify(legacy.ticks)`, equal
metrics, and `compareTraces(...).identical`. **No baseline was regenerated.**

## Test counts

| Suite | At PR #14 | After fixes | Added |
| --- | --- | --- | --- |
| vitest files | 28 | 30 | 2 |
| vitest tests | 509 | 537 | 28 |
| playwright | 141 | 141 | 0 |
| one-shot stages | 29 | 29 | 0 |
| repo-guard checks | 9 | 9 | 0 |

**Tests deleted:** none.
**Tests skipped:** none.
**Tests weakened:** none. One assertion was *replaced* — see Issue A above; it
was replaced because it was wrong, and the replacement is documented rather than
folded into a routine update.

The `no tests deleted or weakened` repo-guard stage passes in both one-shot runs.

## Commands

| Command | Exit |
| --- | --- |
| `git status --short` | 0 (clean) |
| `git rev-parse HEAD` | 0 |
| `pnpm install` | 0 |
| `pnpm typecheck` | 0 |
| `pnpm lint` | 0 |
| `pnpm harness:check` | 0 |
| `pnpm harness:animation-assets` | 0 |
| `pnpm harness:world` | 0 |
| `pnpm harness:capabilities` | 0 |
| `pnpm harness:unit` / `:integration` / `:replay` | 0 — 537 passed |
| `pnpm harness:repo-guard` | 0 — 9/9 |
| `pnpm build` | 0 |
| `pnpm harness:visual` | 0 — 141 passed |
| `pnpm schema:generate` + `assets:animation:index` + `unity:export` | 0, no diff |
| `pnpm harness:one-shot` run 1 | 0 — 29/29 in 1285.4s |
| `pnpm harness:one-shot` run 2 | 0 — 29/29 |

`pnpm install --frozen-lockfile` was not used: no dependency changed in this
pass, and the branch's lockfile already includes the two workspace packages
added by PR #14. `npx tsx harness/shadow-compare.ts` was not run — it compares a
live deployment against local output and needs a deployment.

## Repository byte integrity

`projects/demo-character/project.json`, `schemas/**` and `generated/**` are
unchanged by this pass. The staged-simulation test asserts the project file is
byte-identical across a full mutating-command sweep and a staged simulation.

## Generated drift

Second generation clean; both one-shot runs pass the `schema generation drift`
and `generated files not hand-modified` stages.

## Known limitations

1. **Orchestration not followed; gate reviews are self-reviews.** Unchanged from
   PR #14 and still the largest gap in this branch's evidence.
2. **The browser samples camera yaw once per frame.** At 30Hz two ticks share a
   yaw where at 60Hz they would not. That is a property of sampling a continuous
   input at frame rate — the same as device input — not something the replay
   contract can fix. The cadence test supplies yaw per tick, which is the right
   comparison for "identical per-tick inputs produce identical results", and it
   does not claim the browser's frame-sampled camera is cadence-independent.
3. **`RuntimeInstanceOverrides.moveSpeedScale` is still declared and unread.**
   Out of scope for this pass by §1.
4. **`setFocusedInstance` / `setCameraTargetInstance` still bypass the command
   registry.** Unchanged; out of scope.
5. **The world viewport is still procedural-character-on-a-flat-plane.**
6. **Only local-input player index 0 is wired in the browser.**
7. **No performance ceiling established for instance count.**
8. **Unity gains no world behaviour** — DTOs and the `IChamberWorld` seam only.
9. **Latest-head Vercel: not verified.** Reported below as such.

## Superseded by the replay lifecycle pass

Two follow-up defects were found in the replay lifecycle after this report was
written — `reset()` dropping its control source, and the recorder capturing the
previous tick's yaw — and are fixed in `reports/pr14-replay-lifecycle.md`. The
findings in this report are unchanged and still hold; the branch's current test
counts and one-shot results are the later report's.

## Declaration

```text
PR14 Critical Fix Pass: PASS

Issue A — Character-safe Resolution:      PASS
A1 Distinct Character Data:               PASS
A2 Immutable Animation Sharing:           PASS
A3 Override-sensitive Resolution Key:     PASS
A4 Preview Resolution Isolation:          PASS

Issue B — Stateless Simulation API:       PASS
B1 Same-response Final Observation:       PASS
B2 Fresh-process Determinism:             PASS
B3 Repository Byte Integrity:             PASS
B4 Read-only Simulation:                  PASS
B5 API Documentation Honesty:             PASS

Issue C — Camera-faithful Replay:         PASS
C1 Constant Non-zero Yaw:                 PASS
C2 Changing Yaw:                          PASS
C3 Tick-boundary Ordering:                PASS
C4 Multi-instance Replay:                 PASS
C5 Replay Version Validation:             PASS
C6 Legacy Replay Compatibility:           PASS
C7 30/60/120 World Cadence:               PASS

Typecheck / Lint:                         PASS
Unit / Integration / Replay:              PASS
Repo Guard:                               PASS
Build / Visual:                           PASS
Generated Artifact Stability:             PASS
One-shot Run 1:                           PASS
One-shot Run 2:                           PASS
Agent Orchestration Evidence:             FAIL — no subagent ran; recorded, not fabricated
Latest-head Vercel:                       NOT VERIFIED

Merge Recommendation: HOLD
```

**Why HOLD rather than MERGE.** All three critical issues are fixed and every
required regression passes. The work package permits `MERGE` only when
latest-head Vercel is PASS, and it is not verified — this environment has no
access to the deployment's status. Orchestration evidence is separately FAIL and,
per §15, is to be reviewed apart from code correctness.

The code recommendation is that the three defects are resolved. The merge gate is
held open by the deployment check, not by the fixes.
