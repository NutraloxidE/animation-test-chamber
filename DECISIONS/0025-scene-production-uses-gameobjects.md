# 0025 — The production Scene path reads and writes GameObjects, and an Animator animates

Status: accepted
Supersedes nothing. Extends 0020, 0021, 0022, 0023, 0024.

## Context

Decision 0024 chose a consumer-first cutover and named where it would stop.
After it, the Prefab Editor, the Prefab routes and `GameObjectRenderer` were all
running on GameObjects — and the *Scene* was not. The state it left was:

```text
Scene Editor           read scene.entities
Scene Viewport         drew a coloured primitive per entity.kind
Scene operations       wrote scene.entities
Repository apply       applied entity operations
scene.gameObjects      generated from scene.entities by prefabs:migrate
```

Two problems in that arrangement are not cosmetic.

**The generated view made the mirror authoritative.** `gameObjects` was
*derived*, so `harness:game-objects` checked the two views agreed, and that check
was correct precisely because production never wrote the GameObject half. The
moment production writes it, the agreement check becomes an instruction to
reverse-generate `entities` — and a system that keeps both halves in sync
forever has two sources of truth permanently, not temporarily.

**The Animator was a fact, not a behaviour.** `render-projection.ts` reported
that an Animator Component existed and named its assignment. Nothing bound an
`AnimationMixer`, resolved the assignment to a clip, or advanced anything. A
Prefab carrying `ModelRenderer + Animator` therefore rendered as a mesh frozen
in its bind pose, while every check that asked "is there an Animator?" answered
yes. The harness's own animated-prop composition paired an arbitrary `.glb` with
the *navigator's* Animator, whose motion set binds only procedural clips — a
composition that could not animate, passing a stage named for animation.

## Decision

### 1. The Scene read cutover and the operation cutover land together

Production Scene UI and runtime read `scene.gameObjects`. Every Scene Editor
action writes a GameObject operation. Neither half shipped without the other.

The forbidden intermediate state is a viewport reading `gameObjects` while the
Inspector writes `entities`. It is worse than either pure state, because it
needs a migration between every edit and the next frame — and the migration then
becomes the thing that decides what a Scene means, in a step nobody invoked and
nothing displays.

### 2. `entities` is not reverse-generated. It is left alone

The transitional policy is the one §9.2 calls preferred:

```text
production writes gameObjects only
entities is untouched, and is consulted by nothing in production
the mirror may go stale, and staleness is harmless because nothing reads it
```

`applySceneGameObjectOperation` passes `entities` through by identity, and both
the unit and the integration suites assert it byte-for-byte rather than
field-by-field. A field comparison would let a reverse-generation step that
produced an *equivalent* list through, and an equivalent list is still a second
source of truth.

Three consequences follow, and each is a deliberate change rather than a
side effect:

- **project validation moved to the GameObject view.** `validateProjectReferences`
  validates `scene.gameObjects`; `validateSceneReferences` still exists and is
  still exercised, from the migration that produces the entity view. Continuing
  to validate the mirror in production would let a mirror that was already stale
  refuse a write that never touched it — which is the stale half being
  load-bearing again by the back door.
- **`harness:game-objects` no longer checks agreement.** It checks that each
  Scene is *complete in GameObject terms alone*: a `gameObjects` collection
  exists, every instance resolves, every binding and relation is supported by
  resolved Components, and the active camera resolves through a Camera
  Component. A Scene that still needed `entities` to be complete fails there.
- **`prefabs:migrate` gained a one-way valve.** It still walks the entities of
  every Scene, because that walk is what emits the shared camera and light
  Prefabs; but it adopts the resulting `gameObjects` only for a Scene that has
  none. Regenerating them would silently revert every Scene edit made since the
  migration last ran, under a command whose name suggests it only touches
  Prefabs.

### 3. Root instance identity and child runtime-node identity are separate

A viewport click can land on a child node of a resolved Prefab. Four identities
are involved and none of them may be collapsed:

```text
instanceId    the Scene GameObject. The only thing an operation may name.
nodeId        a node inside the resolved Prefab. Inspection only.
componentId   which Component's Inspector is open.
runtime id    what the renderer drew: `<instanceId>/<nodeId>`.
```

`operationTarget()` is the only supported path from a selection to an operation,
and it always returns the root instance. It is a separate function from
`selectedInstanceId()` even though the two agree today, because they answer
different questions — "what is highlighted" and "what may be written" — and the
day a child node becomes independently addressable is the day a call site that
reached for the highlight starts writing operations against a runtime path.

Child rows may inspect a Component, open the source Prefab and highlight in the
viewport. They do not become Scene instances.

### 4. Simulation-owned placement is never persisted by a tick

A `CharacterMotor`-driven node's world transform belongs to the simulation. The
Inspector shows the *authored* transform and labels it `INSTANCE ONLY`; live
placement is `RUNTIME ONLY` and is never presented as a saved value.

The gizmo follows from that. It attaches only to a root instance, and on a
simulation-owned object it is **refused while the Scene is running**, with the
reason stated and Pause and Reset beside it. The alternative — allowing the drag
— has two outcomes and both are bad: the next tick discards the gesture, or the
commit writes an authored transform copied from wherever the simulation had
drifted to.

Editing the authored transform rebuilds the `RuntimeScene` at tick 0, which is
also why a staged edit can never be overwritten by a tick: the runtime the tick
belongs to no longer exists.

### 5. Animator playback advances on the shared Scene clock

`resolveAnimatorPlayback` runs the *existing* animation asset resolver — behavior
asset, motion set, rig, tuning — and flattens it into the one question a
renderer has per frame:

```text
graph state id -> which imported take plays, from which file, looping or not
```

Clips are bound by canonical take identity — asset path plus animation name,
arrived at through `state -> motion slot -> motion set -> clip asset`. Never by a
filename convention, a hard-coded map, a Prefab id or a Character id.

Where the time comes from depends on what the node has, not on what kind of
thing it is:

- a node with a `CharacterMotor` takes its state and normalized time from the
  tick record the simulation just produced;
- a node with an Animator alone sits in the graph's base-layer default state and
  advances `deltaSeconds` per fixed step, from
  `GameObjectRuntimeServices.clock.fixedDeltaSeconds`.

Neither reads a wall clock. `AnimatedRepositoryModel` seeks the action to
`normalizedTime * duration` and calls `mixer.update(0)`, so the pose on screen is
a function of *simulation* time: two runs of one replay show the same pose at the
same tick, and a paused Scene stays paused instead of drifting.

`activeAnimationState` — which state is showing, and the dodge-recovery rule that
decides when the action layer stops winning — is now one exported function shared
by the GameObject runtime and the legacy chamber renderer. Written twice they
would drift, and the way they would drift is the worst available one: both would
still animate, one simply a beat behind, and nothing on screen would say which.

### 6. A missing clip is visible, and never filled in

Two halves, because they are knowable in two different places:

- the **projection** reports `animator-take-unbound` when a node with an imported
  model plays a state its motion set binds no take to. That is knowable from
  documents alone, which is what lets the harness catch it in Node before anybody
  opens a viewport;
- the **renderer** reports `animator-clip-missing` when the take resolves
  canonically but the loaded GLTF does not contain it. That needs the file.

Neither falls back to "the first clip in the GLTF". Playing something would put
motion on screen for a binding that names nothing, and "it animates" would stop
being evidence that the binding is right.

A procedural model has no skeleton to pose. Its Animator still resolves and still
advances; the visual follows the runtime transform and has no skeletal clip, and
that is stated rather than counted as proof of skeletal playback.

### 7. Repository operation semantics

Thirteen operations, applied server-side against a context the *server* builds:
the exact-reference key set of every Prefab this checkout holds, and a resolved
Component lookup. The browser builds the same context so it can refuse at the
control the human just moved — but a check that only the browser makes is a habit
of one client, not a rule.

The refusals worth naming:

- **delete refuses** while another instance's relation targets the object.
  Cascading would mean deleting a prop silently un-aims a camera elsewhere in the
  Scene, and the human who pressed Delete would have no way to know. Clearing the
  Scene's own `activeCameraGameObjectId` is the one exception, because that is a
  property of the Scene and is visible in the Inspector the deletion happened in.
- **duplicate drops the camera relation** and keeps everything else. Two cameras
  following one character is a thing somebody might want and never a thing
  duplication should decide for them — and unlike the other fields, a copied
  relation changes what the *other* object is involved in.
- **changing the Prefab source clears overrides the new graph cannot address.**
  `nodeId`/`componentId` belong to the graph that declared them; carried across
  they either dangle or land on something that merely shares an id. The
  confirmation states exactly which ones, from the same computation the operation
  performs.
- **reorder changes declaration order only.** Relations are id-based, which is
  what makes reordering safe at all.
- **active camera requires an enabled GameObject with a Camera Component.** A
  Scene that plays through an object with no camera has no viewpoint, and
  discovering that at load time as a black frame is what this refusal prevents.

`changedGameObjectIds` is derived by the server from the documents before and
after, never declared by a branch and never taken from the request. A branch that
forgot to name what it touched cannot under-report, and a client-supplied list
would be a claim about a computation the server is about to perform itself.

### 8. What this package does not do

The canonical schema deletion is the next package's. `Scene.entities`,
`SceneEntityDefinition`, `Project.characters` and the legacy `SceneOperation`
union all still exist, and the Repo Guard deliberately does not require their
removal — requiring it now would fail on the documents this guard is meant to
protect. What the guard *does* forbid is any production Scene module reaching for
them again, and any reverse generation anywhere.

## Consequences

- A Scene edit and its entity mirror now disagree, by design, from the first
  write. That is the intended state and is why the agreement check had to go.
- `RepositoryApplyRequest.operations` is `GameObjectSceneOperation`, not a union
  of both. Accepting both would have made the endpoint a dual write path with
  "which collection is canonical" decided per request by whichever client sent
  it. A retired entity operation is refused by name.
- The Scene Editor has a transport — Play, Pause, Reset — because it draws a
  running `RuntimeScene` rather than the authored document. "NOT RUNNING" there
  means the Scene's GameObjects did not resolve, and no entity fallback is drawn
  in its place.
- `harness:scene-gameobject-cutover` runs against a fixture whose two views
  contradict each other. While the views agree, no test can tell a cut-over
  editor from one that still reads entities; the contradiction is what makes a
  fallback produce a wrong answer loudly instead of a right answer by accident.
