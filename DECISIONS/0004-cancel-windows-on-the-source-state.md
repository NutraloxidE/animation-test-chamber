# 0004 — A transition's cancel window is measured in the source state

Status: accepted

## Context

"Cancel window" could plausibly mean a window in the source state (when you may
leave it) or in the destination state (when the new state accepts a cancel).
The two produce very different authoring.

## Decision

`TransitionDefinition.cancelWindow` is a normalized window in the **source**
state's playback time, naming when that transition is permitted to fire.

This is what makes combo and dodge cancels expressible:
`attack-01 → attack-02` with `{0.35, 0.8}` is cancellable only mid-swing, never
on the first frame and never during late recovery.

It follows that a cancel window must be able to pierce a non-interruptible
state. A state marked `interruptible: false` may still be left through a
transition that declares *when* leaving is legal — an exit time or a cancel
window. Without this, every authored cancel window on an attack would be dead
data, which is precisely the bug the first implementation had.

## Consequences

- `exitTimeNormalized` (earliest) and `cancelWindow` (a bounded range) coexist
  and are both evaluated against the source state.
- The Unity adapter reimplements the same rule; it is asserted in both suites.
