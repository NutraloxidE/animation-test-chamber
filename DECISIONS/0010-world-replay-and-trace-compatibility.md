# 0010 — World replay and trace compatibility

## Status

Accepted.

## Context

`ReplayTrace` and `ReplayDefinition` describe one character. The replay fixtures
committed to this repository are the evidence that the simulation has not
drifted, and `tests/replay/expectations.test.ts` compares against them tick by
tick.

A multi-instance world needs traces and recordings that identify *which*
instance produced each record. There were two obvious ways to get there, and the
cheap one is a trap.

## Options considered

**Rewrite the legacy shape.** Add an `instanceId` to `ReplayFrame` and
`TickRecord`, regenerate every fixture, move on. Smallest diff, and it destroys
the only evidence that the new runtime behaves like the old one: after
regeneration, every baseline agrees with the code that produced it by
construction.

**Version alongside.** Leave the legacy shape untouched and add a separate,
versioned world container.

## Decision

Version alongside.

`ReplayDefinition` and `ReplayTrace` are unchanged. Every committed fixture
still means exactly what it meant.

- **`WorldTrace`** carries `worldTraceVersion`, an `instanceOrder`, and one
  `InstanceTrace` per instance keyed by instance id.
- **`WorldReplay`** carries `worldReplayVersion` and one legacy
  `ReplayDefinition` per instance, keyed by instance id. Every frame therefore
  identifies its target instance *by construction* — there is no shared frame
  stream in which a frame could be ambiguous. The alternative, one flat frame
  list with an `instanceId` column, would have made "replay only this instance"
  a filter over the whole file rather than a lookup.
- **`projectInstanceTrace`** projects one instance's trace onto the legacy
  `ReplayTrace` shape, using `computeMetrics` from `replay-runtime` — the same
  function `runReplay` uses. It is exported rather than copied: a second
  implementation of that arithmetic is the fastest possible way to make the
  projection test pass while the two traces quietly measure different things.

`tests/replay/world/world-replay.test.ts` runs every legacy fixture through both
paths and asserts the projected ticks are **byte-identical** to `runReplay`'s,
and that the metrics are equal. Not "within tolerance": a tolerant comparison
would hide precisely the drift it exists to rule out.

## Consequences

- A replay difference is still never auto-accepted. The projection test says
  which instance, which tick and which field differ before anyone considers
  whether a fixture should change.
- Recordings capture *normalized* intent, not device events. A recording made of
  keydowns could only be replayed in a browser and would say nothing about what
  a gamepad or a track had asked for.
- Replay frames stay sparse and are read with hold semantics, matching
  `frameAt`. Exact-tick matching would feed neutral input on every unrecorded
  tick, which is how a replayed run silently disagrees with the run that
  recorded it.
- Two trace shapes exist. That is the cost, and it is paid in one direction
  only: the world knows how to become a legacy trace, and the legacy trace does
  not know about worlds.
