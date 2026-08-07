# 0023 — Runtime transform and step-time conventions

## Status

Accepted and in force.

This record was scoped down from the one the production-switchover work package
asked for. That record was to cover the removal of the dual source of truth, the
production cutover point, the migration boundary and `GameObjectRenderer`. None
of those happened, so recording them would be recording an intention. What *did*
happen is the runtime correctness work that had to land first, and those
conventions are decided, implemented and tested. See
`reports/gameobject-prefab-production-switchover-audit.md`.

## Context

Two defects in `RuntimeGameObject`, both latent, both about to stop being latent.

**Child transforms were not composed.** A child `RuntimeGameObject` was
constructed with the *Scene instance's* transform and never composed with the
child node's own authored offset. Every migrated Prefab is a single node, so
nothing in the repository exercised it. The first Prefab with a hierarchy — a
character carrying a lantern, a camera on a rig, a model with an authored offset
— would have placed the child wrongly.

Worse than the missing composition was what a naive fix would have produced: a
transform composed once, at construction. That passes every static check and
then fails the moment the parent moves, which reads as a rendering bug months
later, far from the code that moved the parent.

**One number meant two things.** `RuntimeComponent.step` was declared as
`step?(deltaSeconds: number)` and called with the simulation tick. Nothing broke
because no built-in component integrates against time. The first Audio,
Particle, animated-Light or scripted component would have advanced sixty times
too fast at a 1/60 clock, and it would have looked like a tuning problem.

## Decision

### Local and world transforms, with world derived on read

```text
localTransform   where this object sits relative to its parent
worldTransform   derived: compose(parent.worldTransform, localTransform)
```

Derived rather than cached. The alternative is an invalidation protocol, and a
stale cached world transform is precisely the failure that looks like "the
lantern did not follow". The cost is one composition per ancestor per read,
which is cheap at the depth a Prefab hierarchy reaches.

`composeTransforms` composes position, rotation *as a quaternion*, and scale. A
child rotation is never reduced to yaw — the runtime being yaw-only is a
locomotion constraint, not a reason to discard authored data — and neither input
is mutated.

### The Scene instance and the Prefab root both place the root object

```text
rootLocal = compose(sceneInstance.transform, prefabRoot.transform)
```

Both are real authored placements. Using only the instance transform silently
discards a Prefab root offset; using only the node transform would put every
instance of a Prefab in the same place.

### A CharacterMotor node is world-authoritative

A character simulation integrates velocity against world-space terrain, so a
node driving one reports the simulation's transform as its world transform and
is *not* carried by its parent. Its children still compose from it, which is
what makes "character carrying a lantern" work while keeping the character's own
motion in the space its physics runs in.

### Components are told the tick *and* the seconds

```ts
interface RuntimeComponentStepContext {
  tick: number;          // the simulation step; what a replay indexes
  deltaSeconds: number;  // from GameObjectRuntimeServices.clock
}
```

Both, always. Neither can be derived from the other by a component that does not
already know the clock, and a single number that means "tick" to the caller and
"seconds" to the callee is an ambiguity that stays invisible until something
integrates against it.

## Consequences

- `RuntimeGameObject.transformState` is gone; `localTransform` and
  `worldTransform` replace it, and the distinction is now something a caller has
  to think about — which is the point.
- `setLocalTransform` is how a host moves a non-character object. Children
  follow automatically on the next read.
- A component runtime that wants real time no longer has to know how the host
  configured its clock.
- `tests/unit/game-objects/hierarchy.test.ts` asserts each of these by moving a
  parent and checking the child followed, rather than by comparing constructed
  values — a construction-time assertion would pass against the frozen-child bug
  this record exists to describe.
