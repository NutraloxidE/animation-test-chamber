# 0013 — Clip Preview versus State Sandbox

## Status

Accepted.

## Context

The Animation Preview workspace presented itself as:

> Play this state on this instance, now.

Its implementation was a read-side pose substitution applied in
`WorldChamberEngine.poseOf`, *after* the world had already stepped. That
placement is a good design and it is the reason previewing cannot reach the
fixed-step tick, the tick record, the world trace or a replay baseline. It is
not, however, a runtime simulation. None of the following executed:

state entry, transition eligibility, exit time, cancel windows, input
buffering, semantic events, recovery policy, movement authority, root motion,
state-authored playback speed as a real clock, or the destination state after a
transition.

Three further problems followed from having one panel make two promises:

- **Timing.** The transport advanced a normalized `0..1` loop against a fixed
  `PREVIEW_LOOP_SEC = 1`, so a 0.35 s attack and a 1.20 s dodge both took
  exactly one second at speed `1` — while the control was labelled "authored
  rate".
- **Target.** The state list came from one globally resolved project. That is
  correct only while every instance in the world references the same Character
  Definition; the moment two instances reference different ones, the panel
  offers one target the other's states.
- **Visibility.** The override was attached to the world engine, and Isolate
  was a *different renderer*, so the panel had to tell the user to switch to
  World view to see what they had just pressed Play on — in the presentation
  where inspecting one character's animation is easiest.

## Decision

Clip Preview is a read-side pose sampler.
State Sandbox is a separate runtime simulation.
Neither mutates the live world or canonical data.
Graph/Timing are persistent authoring surfaces.
Animation targets resolve from Runtime Instance → Character Definition.

### Clip Preview

Samples a resolved clip and displays it. It executes nothing. Its banner says
`POSE ONLY` in the panel, not in a tooltip, and names State Sandbox as the
place runtime behaviour lives. The transport's clock is **seconds of clip
time**; normalized time is derived from it and the clip's authored duration, so
`speed = 1` means the authored duration, `0.5` twice as long and `2` half as
long. Structural non-persistence is unchanged: the override is installed on the
engine's read side and nowhere else.

### State Sandbox

Constructs its own `Simulation` from the target's *immutable* resolved
document, bootstraps the chosen layer states before tick zero, and then runs
the ordinary fixed step. Everything after the bootstrap is the real runtime, so
transitions, events, recovery, movement authority and root motion are real
rather than reimplemented. It holds no reference to `WorldRuntime`, no live
instance, no shared input buffer, layer state, event queue or root-motion
accumulator, and writes to its own record list rather than the world trace.

### The bootstrap seam

`AnimationGraphRuntime.bootstrapState` places a layer in a chosen state and
throws once the graph has ticked. `Simulation` accepts a bootstrap only through
`SimulationInit` — a constructor argument, not a method — so the only thing
that can use it is something building a *new* simulation. `WorldRuntime` never
passes one.

The rejected alternative was a `worldRuntime.forceState(...)` or a general
`setLayerState(...)`. Either would be reachable from world commands, the HTTP
capability surface and replay playback, and each of those would be a way to
rewrite a tick record that replay determinism is measured against.
`harness:repo-guard` fails the build if such a method appears, or if
`world-runtime` starts passing a bootstrap.

### Targets

`AnimationTargetMode` is `follow-selection` (the default) or
`pinned`. Follow Selection *derives* the target from `SceneSelection` every
time it is asked, so there is no second copy of the selection to fall out of
date. Pinning stores an id precisely because the user asked for one that
outlives their next click. A pinned target that is deleted is **reported**, not
silently replaced — silently choosing another instance is how a user previews a
character they never chose.

Resolution goes through `WorldChamberEngine.resolvedProjectFor`, which returns
the document `WorldRuntime` already built for that instance. Resolving a second
time from the same inputs would be a second chance to disagree, and the stale
answer would be the one on screen.

### Viewport

`world` and `isolate-selection` are one renderer under two visibility filters.
Isolate is a `VisibilityFilter`, which is all it ever meant. `rig` is the
focused skinned viewport (GLTF, weapon-grip gizmo, terrain mesh, debug
overlays), kept as an explicit third presentation rather than as the hidden
second meaning of "Isolate".

### Graph and Timing

The Graph workspace names the Behavior it edits and the instance it came from,
and reconciles its local selection when the target changes — a state id from
another behaviour is a dangling reference, not a selection. `MotionBindingContext`
separates *which binding is being inspected* from *what an instance is holding*:
the Timing panel used to dispatch `setInstanceWeaponMode`, so looking at the
sword's curve re-armed the character in the viewport, staged a world edit and
dirtied the world.

## Consequences

- `PREVIEW_LOOP_SEC` is gone; there is no fixed preview span.
- `AnimationPreviewWorkspace` is replaced by `AnimationWorkspace` with two
  modes. The bottom dock entry is `Animation`, and the dock toggle is `Editor`
  rather than `Project (Assets)`.
- `Simulation` has one new optional constructor field and no new methods.
- The live world's public surface is unchanged: no force-state command, no new
  capability, no new HTTP route.
