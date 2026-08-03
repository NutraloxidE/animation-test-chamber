# PR #14 replay lifecycle closure — verification report

## Identity

| | |
| --- | --- |
| Base SHA for this pass | `b1920f249b23d2a47d31ca004b57c0eac04aa102` |
| Last implementation SHA | `f00572d` (`fix: preserve control sources across reset and record the consumed control`) |
| Branch tip | the docs commit containing this file; a commit cannot record its own SHA |
| Branch | `claude/multi-instance-world-harness` |
| Executing agent | `main-opus-pr14-replay-lifecycle`, model `claude-opus-5` |

## Orchestration compliance — NOT FOLLOWED

The work package specifies five agents across three model tiers. **No subagent
ran** — the tiered models it names are not addressable as separate agents in this
environment. Per §6.2: no handoff or independent review was fabricated, the main
agent performed every task, and orchestration is recorded as not followed. The
reviews in `agents/reviews/12-replay-lifecycle-audit.md` are self-reviews and say
so at the top. `Agent Orchestration Evidence` stays **FAIL**.

## The two defects

Both share the property that makes them worth naming separately from the three
earlier critical fixes: they are invisible on the *first* use of a recording,
which is the use anybody checks.

**1 — `reset()` dropped the control source.** `createReplayRuntime` built a
runtime and then called `setControlSource`. `reset()` rebuilds from
`this.options`, which never held it, so a reset replay ran with the camera pinned
at zero. First playback correct; second playback a different run under the same
recording's name.

**2 — the recorder captured the previous tick's yaw.** `WorldReplayRecorder.step()`
read `runtime.cameraYawRad` before calling `runtime.step()`. Correct for a
host-driven run, where the host sets the yaw first — wrong for a
control-source-driven run, where the source is sampled *inside* the step. Every
`record → replay → record` round trip shifted the camera track one tick later.

## What changed

```
packages/world-runtime/src/world-control.ts    WorldControlState; stateless-source contract
packages/world-runtime/src/world.ts            controlSource option; tick-record controls;
                                               control sampled and validated before the
                                               instance loop
packages/world-runtime/src/world-replay.ts     controlSource passed via constructor;
                                               recorder reads the returned tick record
harness/check-world.ts                         three executable lifecycle gates
tests/integration/world/replay-lifecycle.test.ts   (new) 9 tests
agents/reviews/12-replay-lifecycle-audit.md    (new)
reports/pr14-replay-lifecycle.{md,json}        (new)
```

`packages/schema/**`, `packages/capability-runtime/**`, `apps/api/**`,
`apps/web/**`, generated schemas and generated Unity DTOs are **unchanged**.
`WorldTickRecord` gained a field, which is additive; no caller needed updating.

## Contract decisions

1. **`controlSource` is a constructor option**, so `reset()` stays a one-liner
   rebuilding from `this.options` and is correct rather than lucky.
2. **The source contract is stateless per tick.** Documented on the interface and
   asserted by running two runtimes off one source object. A cloneable-but-stateful
   source was rejected: "clone it correctly at every reset" is a rule someone
   eventually forgets, and the failure is silent.
3. **`setControlSource` stays public and does not survive reset**, documented as
   such. Making it retroactively rewrite the constructor options would mean a
   debugging call quietly redefined "reset".
4. **`WorldTickRecord.controls` reports the consumed control.** The recorder
   reads the returned record and never observes the runtime, so it cannot
   observe it at the wrong moment.
5. **Controls stay out of `WorldTrace`.** The trace hashes per-instance records,
   in which camera yaw already appears through the positions it produced. Adding
   it would change the hash of every existing world trace to record something
   already implied.
6. **Invalid control fails the whole tick.** Sampled and validated before the
   instance loop; a half-advanced world is worse than a refused one because the
   next tick would run on top of it.

## Regression tests

`tests/integration/world/replay-lifecycle.test.ts` — 9 tests:

| Test | Covers |
| --- | --- |
| resetting a replay runtime preserves its recorded camera control source | R1 |
| resetting after partial playback restarts the same replay from tick zero | R2 |
| shares one stateless control source between a runtime and its reset | §2.2 |
| recording a control-source-driven runtime captures the yaw consumed by the same tick | R3 |
| record replay record preserves camera control keyframes exactly | R4 |
| record replay record preserves every per-instance replay frame | R5 |
| produces the same trace when played back from either recording | R6 |
| keeps host-driven recording correct | R7 |
| does not partially advance a tick when the control source returns NaN | R8 |

### These tests fail against the base

Verified rather than asserted. With the three runtime source files stashed back
to `b1920f2` and the new test file in place:

```
7 failed | 2 passed (9)
```

The two that pass at base — per-instance frame preservation and host-driven
recording — are the two the defects did not touch, which is consistent with the
diagnosis rather than an accident.

R9 (legacy replay) and R10 (cadence) are covered by the existing suites, which
remain enabled and green: the legacy projection still asserts byte-identity on
all four committed fixtures, and the 30/60/120 cadence test is untouched.

## Harness

`harness:world` gained three executable gates, not source-text scans:

- a reset replay runtime must produce the same world hash as a fresh one;
- re-recording a replay must reproduce its camera keyframes exactly;
- `record → replay → record` must round-trip to the same world hash.

No stage was removed. The one-shot order is unchanged.

## Test counts

| Suite | Before this pass | After | Added |
| --- | --- | --- | --- |
| vitest files | 30 | 31 | 1 |
| vitest tests | 537 | 546 | 9 |
| playwright | 141 | 141 | 0 |
| one-shot stages | 29 | 29 | 0 |
| repo-guard checks | 9 | 9 | 0 |

**Tests deleted:** none. **Skipped:** none. **Weakened:** none. No assertion was
replaced in this pass. The `no tests deleted or weakened` repo-guard stage passes
in both one-shot runs.

## Commands

| Command | Exit |
| --- | --- |
| `git status --short` | 0 (clean) |
| `git rev-parse HEAD` | 0 |
| `pnpm typecheck` | 0 |
| `pnpm lint` | 0 |
| `npx vitest run tests/replay/world/world-replay.test.ts` | 0 — 21 passed |
| `npx vitest run tests/integration/world/replay-lifecycle.test.ts` | 0 — 9 passed |
| `npx vitest run tests/unit/world/world-contract.test.ts` | 0 — 20 passed |
| `npx vitest run tests/integration/world/render-cadence.test.ts` | 0 — 2 passed |
| `pnpm harness:world` | 0 |
| `pnpm harness:capabilities` | 0 |
| `pnpm harness:unit` / `:integration` / `:replay` | 0 — 546 passed |
| `pnpm harness:repo-guard` | 0 — 9/9 |
| `pnpm build` | 0 |
| `pnpm harness:visual` | 0 — 141 passed |
| `pnpm schema:generate` + `assets:animation:index` + `unity:export` | 0, no diff |
| `pnpm harness:one-shot` run 1 | 0 — 29/29 in 962.2s |
| `pnpm harness:one-shot` run 2 | 0 — 29/29 |
| `git diff --check` | 0 |

`pnpm install --frozen-lockfile` was not run: no dependency changed in this pass.
`npx tsx harness/shadow-compare.ts` was not run — it compares a live deployment
against local output and needs a deployment to compare against, which is the same
reason Vercel is unverified below.

## Generated drift

Second generation clean. No schema drift, no Unity DTO drift. Both one-shot runs
pass the `schema generation drift` and `generated files not hand-modified`
stages.

## Known limitations

Unchanged from the previous pass except where noted:

1. **Orchestration not followed; reviews are self-reviews.**
2. **The browser samples camera yaw once per frame**, so at 30Hz two ticks share
   a yaw where at 60Hz they would not. Inherent to frame-sampling a continuous
   input, and not something the replay contract can fix. Recording is unaffected:
   the recorder now stores whatever the tick consumed, whichever cadence produced
   it.
3. `RuntimeInstanceOverrides.moveSpeedScale` is declared and unread.
4. `setFocusedInstance` / `setCameraTargetInstance` bypass the command registry.
5. The world viewport is procedural-character-on-a-flat-plane.
6. Only local-input player index 0 is wired in the browser.
7. No performance ceiling established for instance count.
8. Only camera yaw is a replayed control. Pitch, distance and any other channel
   are out of scope by §3 and would need the same treatment.
9. **Latest-head Vercel: not verified.** This environment surfaces no check or
   status data for the branch head.

## Declaration

```text
PR14 Replay Lifecycle Closure: PASS

Reset-Persistent Control Source:          PASS
Reset After Partial Playback:             PASS
Tick-Consumed Control Observation:        PASS
Control-source Re-record Boundary:        PASS
Record → Replay → Record Controls:        PASS
Record → Replay → Record Intent:          PASS
Record → Replay → Record Trace:           PASS
Host-driven Recording Compatibility:      PASS
Invalid Control Atomicity:                PASS
Legacy Replay Compatibility:              PASS
30/60/120 Cadence:                        PASS

Typecheck / Lint:                         PASS
Unit / Integration / Replay:              PASS
Repo Guard:                               PASS
Build / Visual:                           PASS
Generated Artifact Stability:             PASS
One-shot Run 1:                           PASS
One-shot Run 2:                           PASS
Agent Orchestration Evidence:             FAIL — no subagent ran; recorded, not fabricated
Latest-head Vercel:                       NOT VERIFIED

Final Merge Review: HOLD
```

**Why HOLD.** Every replay lifecycle row passes, the three earlier critical
fixes remain green, one-shot passes twice, and nothing was deleted, skipped or
weakened. §13 permits `MERGE RECOMMENDED` only when latest-head Vercel is PASS,
and it cannot be verified from here.

The hold is on the deployment check, not on the engineering. A reviewer who can
see the Vercel status for the branch head has everything else required to move
this to MERGE RECOMMENDED.
