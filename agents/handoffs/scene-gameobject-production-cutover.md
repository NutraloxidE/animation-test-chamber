# Handoff — Scene GameObject production cutover + Animator playback

Branch: `claude/new-session-ou984u`
Start SHA: `5b9dc609af7b24bb72c6caaaee52ff44087bed8e`

## What this package did

Two things, and they had to land together.

**The production Scene path moved onto GameObjects.** The Scene Editor read
`scene.entities` and drew a coloured primitive per `entity.kind`; the apply
endpoint wrote entity operations and let `prefabs:migrate` regenerate the
GameObject view from them. Now the Scene session resolves and instantiates a
`RuntimeScene`, the viewport projects it through `GameObjectRenderer`, every
editor action dispatches one of thirteen GameObject operations, and the endpoint
applies those to `scene.gameObjects`.

**An Animator Component now animates.** The projection reported that an Animator
existed and named its assignment; nothing bound a mixer, resolved the assignment
to a clip, or advanced anything. `resolveAnimatorPlayback` now runs the existing
animation asset resolver and flattens it to `state -> take`, the `AnimatorRuntime`
advances on the shared fixed-step clock, and `AnimatedRepositoryModel` binds
clips by canonical take identity and seeks them from simulation time.

Read `DECISIONS/0025-scene-production-uses-gameobjects.md` before changing any of
it; the reasoning behind each refusal is there.

## Where to start reading

```text
packages/game-object-runtime/src/animator-playback.ts   what an Animator plays
packages/game-object-runtime/src/components.ts          AnimatorRuntime, its clock
packages/editor-core/src/game-object-operations.ts      the thirteen operations
packages/prefab-runtime/src/capabilities.ts             what a Prefab can do
apps/web/src/scene-editor/use-scene-runtime.ts          RuntimeScene lifecycle
apps/web/src/scene-editor/viewport/SceneViewport.tsx    the one Scene clock
apps/web/src/game-objects/AnimatedRepositoryModel.tsx   mixer, clips, isolation
apps/api/src/routes/repository-apply.ts                 the server-side apply
harness/check-scene-gameobject-cutover.ts               the ten cutover stages
```

## Things that will bite you if you do not know them

**The cutover fixture contradicts itself on purpose.** `contradictoryScene()`
(in `tests/fixtures/scene.ts` and again, independently, in the harness) holds
three `ENTITY-ONLY-DECOY` entities and three unrelated GameObjects. While the two
views agree, no test can tell a cut-over editor from one that still reads
entities. Do not "fix" the fixture to make the views match — that removes the
only thing that catches a fallback.

**`entities` is passed through by identity and asserted byte-for-byte.** Not
field-by-field. An operation that reverse-generated an *equivalent* entity list
would still be a second source of truth, and a field comparison would let it
through. If a test starts failing on entity bytes, something began writing the
mirror; do not relax the comparison.

**`prefabs:migrate` has a one-way valve.** It still walks every Scene's entities,
because that walk is what emits the shared camera and light Prefabs, but it only
*adopts* the generated `gameObjects` for a Scene that has none. Removing the
valve would make the command silently revert every Scene edit since it last ran.

**`operationTarget()` is the only path from a selection to an operation.** It
always returns a root instance id. The runtime spells a child node
`<instanceId>/<nodeId>`, and passing that to `scene.set_transform` writes an
operation naming a GameObject that does not exist. `selectedInstanceId()` agrees
with it today and is deliberately a different function.

**The gizmo is refused on a simulation-owned object while the Scene runs.** That
is not a missing feature. Allowing the drag has two outcomes and both are bad:
the next tick discards the gesture, or the commit persists a transform copied
from wherever the simulation had drifted to. Pause or Reset first.

**Animation time is simulation time.** `AnimatedRepositoryModel` seeks
`action.time` and calls `mixer.update(0)`. It never calls `mixer.update(delta)`
with a frame delta. Changing that makes the pose a function of frame rate, which
breaks replay determinism in a way that looks like a tuning problem.

**One clock per viewport.** `SceneClock` lives inside the `<Canvas>` and is the
only thing allowed to step the `RuntimeScene`. A `requestAnimationFrame` loop
inside a renderer would give each object its own idea of what time it is.

## What is still open

The final schema deletion. `Scene.entities`, `SceneEntityDefinition`,
`Project.characters` and the legacy `SceneOperation` union all still exist. The
Repo Guard deliberately does not require their removal — it forbids production
Scene modules from *reaching for* them, and forbids reverse generation anywhere.

Also still open, and out of scope here:

```text
Prefab APIs (publish / variant / adopt through the endpoint)
Asset Library cutover
Unity export cutover
scene.set_component_override has no Inspector control that authors a patch;
  the Inspector can clear an override and revert all of them, and the
  operation itself is exercised by tests and the harness
```

## Running it

```bash
pnpm harness:scene-gameobject-cutover   # the ten stages this package added
pnpm harness:one-shot                   # everything, in dependency order
```

The visual suite must go through `pnpm harness:visual`, never `playwright test`
directly: it performs real writes through the real API, and the wrapper is what
points that API at a disposable checkout.
