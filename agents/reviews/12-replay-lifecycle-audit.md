# 12 — Replay lifecycle audit (Gate A) and final merge review

**Performed by:** the main agent (`claude-opus-5`). **No subagent ran.** The
reviews below are self-reviews by the implementing agent and are weaker evidence
than an independent reviewer; orchestration is recorded as **not followed**.

**Base:** `b1920f249b23d2a47d31ca004b57c0eac04aa102`, branch
`claude/multi-instance-world-harness`, worktree clean.

## The two defects, confirmed

Both are real, and both share a property that makes them worth naming: they are
invisible on the *first* use of a recording, which is the use everybody checks.

**1 — `reset()` dropped the control source.** `createReplayRuntime` built a
runtime and then called `setControlSource`. `reset()` rebuilds from
`this.options`, which never held that source, so a reset replay ran with the
camera pinned at zero. The first playback was correct; the second was a
different run wearing the same recording's name.

**2 — the recorder captured the wrong tick's yaw.** `WorldReplayRecorder.step()`
read `runtime.cameraYawRad` *before* calling `runtime.step()`. For a host-driven
run that is right: the host sets the yaw first. For a control-source-driven run
— every replay — the source is sampled *inside* the step, so the pre-step value
belongs to the previous tick. A `record → replay → record` round trip therefore
shifted every camera keyframe one tick later, once per round trip.

Neither defect can be caught by record-then-replay. Both need the round trip,
which is why the regression file is built around it.

## Decisions taken at this gate

1. **`controlSource` is a constructor option.** Not an afterthought attachment.
   `reset()` stays a one-liner rebuilding from `this.options`, and the option is
   what makes that correct rather than lucky.
2. **The source contract is stateless per tick**, documented on the interface
   and asserted by a test that runs two runtimes off one source object and
   checks neither drags the other's position along. A cloneable-but-stateful
   source was rejected: "clone it correctly at every reset" is a rule someone
   eventually forgets, and the failure is silent.
3. **`setControlSource` stays public and is documented as not surviving reset.**
   Making it retroactively rewrite the constructor options would mean a
   debugging call quietly changed what "reset" means. A host that hands over
   control mid-run re-establishes it itself.
4. **`WorldTickRecord.controls` carries the consumed state.** Reported, not
   inferred. The recorder reads the returned record and cannot observe the
   runtime at the wrong moment because it never observes the runtime at all.
5. **Controls do not enter `WorldTrace`.** The trace hashes per-instance
   records, and camera yaw already shows up there through the positions it
   produced. Adding it would change the hash of every existing world trace to
   record a value that is already implied.
6. **Invalid control fails the whole tick.** Sampling and validation happen
   before the instance loop; `setCameraYaw` throws on a non-finite value. A
   half-advanced world is worse than a refused one, because the next tick would
   run on top of it.

**Gate A: PASS**, no blocking question.

---

## Final merge review

The questions §7 Task 03 requires answering, answered.

**Does reset reconstruct the same control pipeline?** Yes.
`createReplayRuntime` passes `controlSource` through the constructor;
`reset()` rebuilds from those options. Asserted by
*resetting a replay runtime preserves its recorded camera control source*, which
compares world hash, instance order, every tick record, the final observation,
and the yaw actually consumed at eight boundary ticks. It fails against the base
SHA.

**Is the re-record boundary exact?** Yes. A runtime driven by a source with
keyframes at 0 and 30 re-records exactly `[0, 30]` — not `[0, 31]`, which is
what the old ordering produced. Asserted by
*recording a control-source-driven runtime captures the yaw consumed by the same
tick*, and again end to end by
*record replay record preserves camera control keyframes exactly*.

**Is any mutable cursor shared?** No. `RecordedControlSource.sample` reads
immutable sorted keyframes and returns a fresh object; it holds no position.
*shares one stateless control source between a runtime and its reset* runs two
runtimes off one source and checks neither advances the other.

**Can invalid controls partially advance a tick?** No. The control is sampled
and applied before the instance loop, and `setCameraYaw` throws on a non-finite
value. *does not partially advance a tick when the control source returns NaN*
asserts the tick index and every instance's `lastRecord` are unchanged after the
throw.

**Are reports and PR claims accurate?** They are as of this head. The reports
name the last implementation SHA and state plainly that a commit cannot record
its own SHA. The PR body's stale limitations were removed when the underlying
gaps closed, and the ones that remain are still true.

**Is latest-head Vercel successful?** **Unknown.** This environment surfaces no
check or status data for the branch head — `get_commit` returns commit metadata
only. It is reported as NOT VERIFIED, which is the accurate answer, not a
pessimistic one.

**Does any remaining issue block merge?** No *code* issue does. Every replay
lifecycle row passes, the three earlier critical fixes remain green, one-shot
passes twice, and nothing was deleted, skipped or weakened.

Two things are unresolved and neither is a defect in the branch:

- **Latest-head Vercel is unverified**, and §13 permits `MERGE RECOMMENDED` only
  when it is PASS.
- **Orchestration evidence is FAIL**, which §15 of the previous package directs
  be reviewed separately from code correctness.

### Conclusion

```text
HOLD
```

Held on the deployment check alone. The engineering is complete: reset
reconstructs the pipeline, the re-record boundary is exact, no cursor is shared,
invalid controls cannot advance anything, and the round trip is byte-identical
in controls, per-instance frames and world traces. A reviewer who can see the
Vercel status for the branch head — which I cannot — has everything else needed
to move this to MERGE RECOMMENDED.
