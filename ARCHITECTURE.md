# Architecture

This document records the things that are hard to read off the code: the
boundaries, why they sit where they do, and what is deliberately not built.
Anything that *can* be read from the code — field names, ranges, defaults,
validation rules — is not duplicated here on purpose (see DECISIONS/0001).

## The shape of the system

```text
         ┌──────────────────────────────────────────────┐
         │ apps/web — the chamber UI                    │
         │  Viewport (R3F) · World · Inspector ·        │
         │  Graph · Timeline · Replay · Diff · AI       │
         └───────────────┬──────────────────────────────┘
                         │ EditSession (preview → staged)
                         │ ChamberEngine · WorldChamberEngine
         ┌───────────────┴──────────────────────────────┐
         │ packages/*-runtime — engine-agnostic logic   │
         │  world · capability · animation · input ·    │
         │  terrain · haptics · replay · runtime-core   │
         └───────────────┬──────────────────────────────┘
                         │ reads and writes
         ┌───────────────┴──────────────────────────────┐
         │ packages/schema — TypeBox definitions        │
         │  THE single source of truth                  │
         └───────────────┬──────────────────────────────┘
                         │ validated against
         ┌───────────────┴──────────────────────────────┐
         │ apps/api — Hono (holds every secret)         │
         │  re-validates · re-runs diff policy ·        │
         │  runs atomic asset transactions ·            │
         │  mints GitHub tokens · commits               │
         └───────────────┬──────────────────────────────┘
                         │
     projects/*.json + assets/animation/**  →  Git branch  →  PR
```

## Boundaries and why they are there

### The browser holds no credentials

`apps/api` is the only place that reads `GITHUB_APP_PRIVATE_KEY` or
`ANTHROPIC_API_KEY`, and it binds to loopback. The web app talks to it over
`/api`, and never sees a token. The repo guard fails the build if a file under
`apps/web` so much as mentions a server-only variable name.

### The API does not trust the browser

The browser runs the full protection and diff policy so the UI can explain
refusals next to the control that caused them. The API then runs *the same
checks again* on the document it receives, from the canonical file on disk.
A client that skipped its own checks — or a script posting directly — still
cannot land a locked value. Client-side checking is for explanation; server-side
checking is for enforcement.

### Simulation is engine-agnostic; rendering is not

Everything under `packages/*-runtime` is plain TypeScript over plain data: no
three.js, no DOM, no React. That is what lets the same code run the live
preview, the headless regression suite, and (via the same canonical data) a
Unity adapter. Three.js, R3F, DOM and touch UI live only in `apps/web` and are
deliberately *not* abstracted for Unity's benefit — the shared contract is the
data, not the renderer.

### Fixed timestep, decoupled from rendering

Simulation runs at 60Hz. `FixedStepAccumulator` converts real frame deltas into
whole ticks, so 30 / 60 / 120fps produce identical logic. Nothing in the
simulation reads the wall clock or `Math.random`; randomness comes from a seeded
PRNG carried in the replay. This is the property the entire regression system
rests on, and it is tested directly.

### A character references its animation; it does not own it

`projects/demo-character/project.json` used to hold the graph and all 35 clips
inline. It now holds four asset references per character:

```text
assets/animation/
  behaviors/humanoid-third-person-base/1.0.0.json    the state machine
  motion-sets/demo-humanoid-motion-set/1.0.0.json    slot -> clip, per character
  clips/<clip-id>/1.0.0.json                         one piece of motion
  rigs/demo-humanoid-rig/1.0.0.json                  the skeleton
  tuning/demo-default-tuning/1.0.0.json              numeric adjustments
```

The behaviour names **motion slots** (`locomotion.idle`, `action.primary.01`),
never clip ids. The motion set binds those slots to a particular character's
clips. That single indirection is what lets two characters run one state machine
and still move differently — the demo project ships two of them, and the harness
fails if their state sequences ever diverge or their clips ever coincide.

Every reference carries a content hash, and `AssetReference.contentHash` cannot
be empty — that check has no bypass. A published version edited in place is
refused at load rather than discovered as a behaviour change later, and the repo
guard fails on any modification to a version file that already existed.

### A variant is its parent plus a patch, never a snapshot

`AnimationBehaviorAsset` is a discriminated union on `derivation.mode`: `base`
and `fork` carry a full `payload` (parameters, motion slots, semantic events,
graph, replay fixtures); `variant` carries only `{ parent, patches }` and is
not allowed a payload at all — the schema makes the wrong shape
unrepresentable rather than trusting callers not to populate both.
`resolveBehaviorAsset` reconstructs a variant by resolving its parent (which
may itself be a variant) and applying `patches` to the whole resolved payload,
so a contract the parent gains later — a new optional motion slot, a new
replay fixture id — reaches every existing variant automatically, with no
migration and no touched file. The alternative (a variant that snapshots its
parent's payload at creation time) is a fork wearing a variant's name: it
looks derived but silently stops inheriting the moment it is created.

### Every write to the repository is one atomic file-set transaction

`packages/repository-transaction` is a generic, Animation-agnostic package
(it does not import `@atc/schema` or anything animation-specific): a
caller describes a set of file writes plus an optimistic-concurrency
expectation and a validator over the *prepared* view of the repository, and
the package writes everything to a staging area, validates, backs up
replace-targets, promotes every file by same-filesystem rename, and only then
commits. A failure at any point rolls back every promoted file from its
backup and leaves an unpromoted `create` simply absent — there is no
in-between state where three of five new asset versions exist and the fourth
does not. The state machine is durable (`.chamber-transactions/<id>/journal.json`),
so a process that dies mid-promotion is resolved by the *same* rollback logic
at the next server startup, before the write API accepts a request — recovery
is not a special case of the live path, it is the live path re-entered.
`apps/api/src/transaction.ts` is the only place that turns
`AnimationAsset[]` into `PlannedFileWrite[]`; the generic package never sees
an animation type.

### Fine-tuning is classified before it is saved, never silently split

A staged chamber edit is Behaviour/Graph, Clip Asset, or a Character-only
override, and a save names a destination for each domain separately —
there is no default. `SaveAnimationChangesRequest` carries `graph.destination`
and `clips.destination` as their own discriminated choices (character
override, tuning profile, a new or existing behaviour variant, a new clip
version + motion-set version, or explicitly `none`); a clip patch aimed at a
destination that cannot hold clip data (a tuning profile, a behaviour
variant) is refused with a 409 rather than folded in. A mixed graph-and-clip
edit still lands in one repository transaction, so a partial save is not a
possible outcome, and `ResolvedProject.clipAssetSources` gives the save path
(and the Inspector) the same answer for "which asset supplied this clip"
without a second, potentially-drifting resolution pass.

### A static host still gets a real save, not a silent no-op

A character-override save needs no repository write at all — it is a preview
overlay over `instanceOverrides`, computed the same way whether or not an API
server exists. On a static deployment (or the dev server offline) it is
applied in-memory and persisted to `localStorage`, keyed by project, revision
and character, and it says so: *"Saved as a browser-only character draft. No
repository files were changed."* A draft is never applied silently across a
revision change — a stale draft surfaces as a dismissible banner instead,
because a canonical value moving on and a browser cache disagreeing about the
current value is exactly the kind of drift this system exists to prevent.

### `ResolvedProject` is derived, and deliberately unvalidatable

The runtime, the panels, the diff engine and the Unity exporter all reasonably
want a graph and a clip list. Rather than have each of them walk the asset
registry, resolution happens once — `resolveCharacterAnimation` — and produces a
`ResolvedProject`: the canonical project plus the graph, clips and slot bindings
for one character.

It has no TypeBox schema on purpose. Validating a derived document as if it were
canonical is exactly the mistake the type exists to prevent, so there is nothing
to validate it with; `validateResolvedProject` checks it in three parts against
the schemas that own each piece.

### Behaviour lives in fields, not in names

The runtime used to read `stateId.startsWith('attack-')` and
`actionState.endsWith('-recovery')`. Those were real, wanted behaviours — an
attack holds its final frame; a recovery clip hands movement back immediately —
selected by spelling, which meant a second character could only inherit them by
choosing the same names. They are now `completionPolicy`, `recoveryPolicy` and
`movementAuthorityPolicy` on the state, and the repo guard fails if a name-based
branch reappears in a runtime package.

### Canonical paths, not indices

Values are addressed as `/graph/transitions/run-to-attack-01/blendDurationSec`.
Arrays of identified objects are addressed by `id`, never by array index, so a
path survives reordering. Protection metadata, diffs, staging, provenance and
Git conflict reporting are all keyed on these paths — which is why they must be
stable.


## Route-scoped editors

There are two editing products, and the URL says which one you are in and what
it is editing:

```text
/edit/rig/:characterId     tune one reusable Character Definition
/edit/scene/:sceneId       compose one Scene Definition
```

The route parameter is the target, not a hint. Resolution is an exact id match
and an unknown id renders a not-found state — never a fallback to the first
item, because a page that always renders something is a page that can render the
wrong thing while looking entirely correct. See DECISIONS/0012.

The Rig Editor is the chamber that already existed; the route added an identity
header and reversed the direction `activeCharacterId` travels. It is also the
*only* Character selector: see "One Character selector, one animation graph"
below for what that had to displace. The Scene Editor
is a separate page with a Unity-like layout — Hierarchy, viewport, Inspector and
Asset Panel — because a tab inside the chamber would have had to share the
chamber's single-character session.

Every persistent edit in either editor follows one path:

```text
Preview -> Stage -> Validate -> Apply to Repository
```

with git commit a separate action afterwards. See DECISIONS/0014.

## One Character selector, one animation graph

Two things a Character is shown *as* used to live outside the repository, and
both are canonical data now. See DECISIONS/0019.

**Which model.** `CharacterDefinition.model` is a `CharacterModelBinding`: either
a procedural appearance named by preset id, or a repository model file with its
scale, rotation, hand bone and weapon-grip defaults. It replaced a nullable
`modelAssetPath` whose `null` meant "some procedural character, ask the
renderer" — and the renderer answered from a web-only `CHARACTER_PRESETS`
catalog that the route could not reach. That catalog was the app's real
character list, so navigating between Characters changed the header and the
document while leaving the model on screen alone.

What remains renderer-side is appearance only: the colours and proportions of
the procedurally generated meshes, keyed by the preset id the Character
*authors*.

**Which animation.** `AnimationClipDefinition.externalSource` names one take
inside one file (`{ assetPath, animationName, positionScale? }`). Visible
playback resolves through canonical data alone:

```text
state -> state.motionSlot -> motion set binding -> clip asset -> file + take
```

Before this there were two animation graphs: the Behavior chose the state, and
`CLIP_FOR_STATE` / `CharacterPreset.clipMap` / `WeaponMode.clipMap` chose the
animation. They could drift indefinitely while every gate stayed green, and one
had — a weapon mode named a take absent from the file it loaded, so the previous
clip simply stayed on screen. Weapon modes now carry presentation only; which
clips a mode plays is a `contextualKey` on each Character's motion set.

`resolveRigEditorCharacterPresentation` owns both resolutions, and the renderers
choose neither a model nor a clip.

### Ownership is computed once

`describeCharacterBindings(project, registry)` is the only implementation of "who
holds this reference". The Rig Editor's Character Overview, the save dialog's
blast radius, the audit report and the tests all read it, so a SHARED BY N badge
and the save it precedes cannot disagree. Holders are keyed by asset type, id
*and version*, because publishing over a version reaches only that version's
holders. Tuning ownership is computed like everything else — "tuning is
per-Character" was true of the two-Character repository and is false now.

### A preview override is not an identity

`previewModelOverrideId` swaps the *appearance* on screen for debugging. It
defaults to none, may name only a procedural appearance, resets on Character
navigation, is not persisted, and is never staged or applied. It is labelled
PREVIEW ONLY and never "Character": the control it replaced was labelled
"character", which is how five appearances came to be mistaken for five
Characters. `harness:repo-guard` fails a commit that reintroduces the old
selector, or that removes the badges and the PREVIEW ONLY label.

## The production model, in three nouns

```text
CharacterDefinition     reusable authored behaviour and animation references
CharacterSceneEntity    one placement and one controller binding of it
ControllableCharacter   the runtime instance built from the two
```

A Scene entity owns no rig mapping, behaviour graph, motion set or clip. A
Character Definition owns no scene position, controller binding or runtime
state. The third exists only at runtime and is never serialized. Every
controller — human, AI, scripted, replay — reaches it as normalized intent and
by no other route. See DECISIONS/0013 and 0015.

## Definitions and runtime instances

A `CharacterDefinition` is a **definition**: reusable, shared, and never itself
a running thing. A `RuntimeInstanceDefinition` is a **use** of one — an
identity, a placement, a bound intent source and explicitly scoped overrides. A
`WorldDefinition` holds instances plus the intent tracks scripted instances
sample.

Two instances may name the same character, and therefore the same behaviour,
motion set, rig, tuning and clips. They share the resolved document by
reference; they share no mutable state at all. Each owns its own `Simulation`,
and with it its own state-machine state, clip time, transition progress, input
buffer, root-motion accumulation and transform.

`ProjectDefinition.world` is optional. A project without one resolves through
`synthesizeLegacyWorld` into a one-instance world built from
`activeCharacterId`, and nothing rewrites the file on load. The focused chamber
is a *view over a one-instance world*, not a second runtime — so a bug in the
world path is a bug in the focused path too. See DECISION 0009.

### Stable tick order

Instances tick in canonical **declaration order**, over a `string[]` captured at
construction rather than over a `Map`. Map iteration is insertion-ordered and
would keep working by accident, which is exactly why the loop does not read it.
Sorting by id was rejected: renaming an instance would silently reorder the
world.

### Resolution shares a bundle, never a resolved project

Resolution splits in two. `ResolvedAnimationBundle` is the character-independent
half — graph, clips, motion bindings, skeleton, provenance — and *is* shared by
reference between every instance whose animation inputs agree. The
`ResolvedProject` wrapper around it is built fresh per instance and is never
shared, because it carries the character's own id, display name, model binding
and capsule dimensions.

The first version of this cached the whole `ResolvedProject`, which meant two
*different* characters referencing one animation set received each other's body
— invisibly, in a fixture where both characters look the same.

`animationResolutionKey` includes every input that can change a bundle: the four
asset references, the character's animation `instanceOverrides`, and the preview
overrides in force. It includes nothing that only changes the wrapper, so
renaming a character or giving it a different model does not cost it the cache.
Patch values are serialized with sorted keys at every depth, so two semantically
identical patches read from differently ordered JSON hash the same.

### Intent sources

An instance is fed by exactly one of `local-input`, `scripted-track`, `replay`
or `none`. These are *sources*, not behaviours: `scripted-track` samples
authored keyframes and decides nothing. The device is polled **once** per frame
by the host, which then hands the normalized intent to the runtime; instances
never touch a device, because an instance that reached for the keyboard would
receive input according to when it happened to tick.

Tracks are keyed by simulation tick and sample with **hold** semantics — every
field keeps the latest keyframe at or before the tick. A track sampled from
wall-clock time would mean something different on every machine.

### World-global control, and why replay records it

Camera yaw is a simulation input, not a presentation detail: movement is
camera-relative, so the same normalized "forward" produces a different
world-space direction depending on where the camera points. `WorldRuntime`
samples a bound `WorldControlSource` *before* each tick — applying it afterwards
would apply it one tick late — and a world replay carries a tick-keyed,
change-only camera-yaw track with the same hold semantics intent tracks use.

Playback binds that track itself. A replay whose correctness depended on the
caller remembering to re-drive the camera would be wrong by default.

### Instance-qualified observation

Observation is an output of the world, not a debugging afterthought: an agent
that can command an instance but cannot read one back has no way to know whether
it worked. Paths name instances by id:

```text
/world/instances/controlled-humanoid/transform/position/x
/world/instances/scripted-humanoid/animation/layers/locomotion/stateId
/world/instances/scripted-humanoid/intent/Move
```

Never `/world/instances/0/...`. An index means a different instance the moment
someone reorders the array, and a path that quietly changes meaning is worse
than no path at all. The repo guard fails a build that introduces one.

### World traces and replays

The legacy single-character `ReplayTrace` and `ReplayDefinition` are unchanged.
`WorldTrace` and `WorldReplay` are separate versioned containers keyed by
instance id, and `projectInstanceTrace` projects a one-instance world back onto
the legacy shape — asserted **byte-identical** against `runReplay` on every
committed fixture. See DECISION 0010.

## Capabilities: machine, human, observation, verification

A capability declares itself in a `CapabilityManifest` and
`harness:capabilities` fails when the declaration is incomplete:

> A new runtime capability is incomplete if it has no machine path, no human
> authoring path, no observation path, or no deterministic verification path.

**The machine path.** Typed commands with declared input and output schemas,
validated by the registry before running, returning structured issues rather
than throwing. Mutating commands return a *proposed* `WorldDefinition` and the
paths it touches; publishing stays on the existing validated save/transaction
path, and no command is handed a filesystem. There is deliberately no
`apply_patch(path, value)`: one such hole would make protection, validation and
the definition/instance boundary unenforceable, with nothing able to tell.

**The human path.** The world panel's instance controls are rendered *from* the
authoring surface declaration — labels, ranges, step sizes and the backing
`commandId` all come from the manifest — and dispatch the same commands the API
exposes. The human path and the machine path therefore cannot drift: there is
no second way to move an instance. Scope badges make the distinction the whole
contract is about visible: an instance-scoped edit moves one instance, a
shared-definition edit reaches every instance referencing it.

**Statelessness.** `world.simulate` builds a runtime, advances it by the
requested ticks, returns the final observation and a deterministic hash in the
same response, and discards the runtime. It is a pure function of
(project, world, ticks), so an identical request against a fresh process returns
an identical answer — no session, no sticky routing, no server affinity.

The first version got this wrong: `world.preview` advanced a runtime and
`world.read_observations` read "the" runtime, which worked in-process and was
false over HTTP, where each request built and discarded its own.
`world.read_observations` is still registered for in-process callers and is
refused over HTTP with a structured issue naming `world.simulate`. Trace output
is capped at 600 ticks; runs are capped at 10,000.

**Read-only mode.** Discovery and observation stay available when the repository
has gone read-only; those are the tools an operator reaches for *because*
something is wrong. Mutating commands stay refused. See DECISION 0011.

## Protection: the four gates

Protecting human-confirmed values is a primary requirement, not a feature. It is
enforced at four independent layers, because a single check is a single bug away
from being useless:

1. **`evaluateEdit`** (`packages/runtime-core/src/protection.ts`) — every write
   in the edit session passes through it. Protection is *inherited* down the
   document and can only be *raised* by a nested annotation, never lowered.
2. **Proposal generation** — an AI may propose an `approval-required` value
   (that is what the level is for) but `locked` and `invariant` values are not
   offered even as a suggestion. A suggestion is how a settled value gets talked
   back into changing.
3. **`analyzeDiff`** — classifies the whole diff before a commit: protected
   values moved, states/transitions/bindings deleted, protection weakened.
4. **`harness:repo-guard`** — compares the working tree against `HEAD` for the
   same violations, plus deleted or weakened tests, relaxed schema constraints,
   committed secrets and unlicensed assets.

The AI adapter never gets the final say on protection: whatever a model returns,
every path is re-checked locally before anything is applied.

### Domain decisions never read UI state

Whether an asset is a variant is `registry.getBehavior(reference).derivation.mode
=== 'variant'` — nothing else. `librarySummaries()`, the asset browser's search
box, its type filter and its current selection exist to decide what a human
*sees*; none of them may decide what a save *does*. The two were briefly
coupled (a save-destination option was computed from the filtered library
list), which meant typing into an unrelated search box could change which
destinations a save offered — the same class of bug as a protection check
that reads a display label instead of the field it labels.

## Regression policy

A replay difference is never automatically the new truth. `compareTraces`
reports differences across both layers' state sequences, positions, event
timing and foot metrics; the decision to accept is a human's. Golden screenshots
are not used as the primary signal — the trace is, because it says *what*
changed rather than that something looks different.

## Visual tests are tick-driven, not wall-clock-driven

`window.__ATC_TEST__` (installed only when `import.meta.env.DEV` is true, so
it never reaches a production bundle) lets a Playwright test call
`advanceTicks(n)` to step the simulation a deterministic number of fixed
steps, instead of calling `waitForTimeout` and hoping this particular
machine renders fast enough for real time to cover it. `enable()` also stops
the normal `requestAnimationFrame` loop from advancing the simulation from
wall-clock deltas for that page, so the two sources of ticks never race.
Tests that still need to observe something as it happens (a replay's
progress, a jump's landing) poll DOM state between small tick batches rather
than waiting on a fixed real-time budget — the same reasoning `expect.poll`
usually encodes, just driven by simulated ticks instead of real ones.

## Known limitations

Stated plainly, because the alternative is someone discovering them later.

**Implemented and verified**

- Two-layer state machine with priority, exit times, cancel windows, input
  buffering, re-entry policy, timeouts and fallbacks
- Deterministic fixed-step simulation, frame-rate independent, with replay
  record/playback and trace comparison
- Terrain sampling, terrain-state detection, ground snapping, step-up,
  moving-platform inheritance, surface materials
- Protection at all four layers, diff policy, staging, undo/redo, provenance
- Commit through the fake adapter, base-SHA conflict detection with per-field
  conflicts, protected-branch refusal
- Rule-based AI proposals: three deterministic, protection-aware variants
- GLB import, candidate lifecycle, licence policy
- Unity bundle and C# DTO generation from the same schemas
- Multi-instance worlds: shared definitions, independent runtime state,
  per-instance intent routing, deterministic tick order, instance-qualified
  observations and traces, world replay, and a byte-identical projection onto
  the legacy single-character trace
- Typed capability commands with harness-enforced completeness

**Implemented with a fallback**

- **Git**: GitHub App adapter is implemented but is only exercised when
  credentials are configured; the fake adapter is the tested default.
- **AI**: the Anthropic provider is implemented and falls back to the
  rule-based provider on any error, missing key or malformed response. Only the
  rule-based path is covered by tests.
- **Haptics**: generic dual-rumble and trigger-rumble degrade correctly and are
  tested through the capability probe. Actual vibration cannot be asserted in a
  headless browser.

**Scaffolded, not operational without an external service**

- **Animation worker**: the HTTP contract and client exist; FBX/BVH conversion
  requires a Blender worker at `ANIMATION_WORKER_URL`. Without it, conversion is
  reported as an explicit pending job rather than failing silently.
- **DualSense Extended haptics**: an adapter boundary with no backend. The
  capability probe reports the feature as absent unless a backend registers,
  and never infers capability from a controller's name.
- **Unity adapter**: DTOs, a JSON importer, a state machine with matching
  semantics and adapter interfaces. It does **not** generate an Animator
  Controller, bind clips, port the terrain height field, or implement foot IK —
  each is listed in the generated README.

**Deliberately not built (MVP non-goals)**

- A general-purpose node editor, a full game engine, retargeting from arbitrary
  skeletons, crowd/enemy AI, multiplayer, or identical haptics across every
  browser and OS.
- A behaviour system. `scripted-track` is a deterministic composition and test
  primitive; nothing in the world runtime *decides* what an instance should do.
- A general ECS. Instances hold a `Simulation` each, not a component store.
- A universal property editor. The authoring surface declaration drives the
  world panel's instance section and nothing else; the existing Inspector is
  not generated from it.
- Unofficial API automation for services like Mixamo. Acquisition automates
  everything from *import* onward; obtaining the file is the human's step.

**Known rough edges**

- The character is a procedural stand-in. Foot IK operates on synthesized foot
  positions, so its absolute numbers are only meaningful relative to each other
  until a real skinned GLB is registered.
- Terrain is a height field with a forward probe, not a collision engine. Steps
  and walls are distinguished from ramps by a flatness threshold, which is a
  heuristic that holds for the authored presets.
- `frameAt` scans a replay's frames linearly; fine at MVP replay lengths, worth
  a binary search if replays get long.
- The world viewport renders the procedural character only, on a flat plane. It
  shares `ProceduralCharacter` with the focused viewport through a pose closure
  rather than duplicating it, but terrain meshes, GLB characters, debug overlays
  and the ghost trace are focused-view features that the world view does not
  show yet.
- Only `local-input` player index 0 is wired in the browser. The schema allows
  0–7 and the runtime routes by index; nothing polls a second gamepad.
- The Unity adapter gains world DTOs and an `IChamberWorld` seam. It does not
  spawn instances, and `local-input`/`replay` sources are declarations the
  adapter must supply rather than things the bundle can evaluate.
