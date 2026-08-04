# Architecture

This document records the things that are hard to read off the code: the
boundaries, why they sit where they do, and what is deliberately not built.
Anything that *can* be read from the code — field names, ranges, defaults,
validation rules — is not duplicated here on purpose (see DECISIONS/0001).

## The shape of the system

```text
         ┌──────────────────────────────────────────────┐
         │ apps/web — the chamber UI                    │
         │  Viewport (R3F) · Inspector ·                │
         │  Graph · Timeline · Replay · Diff · AI       │
         └───────────────┬──────────────────────────────┘
                         │ EditSession (preview → staged)
                         │ ChamberEngine
         ┌───────────────┴──────────────────────────────┐
         │ packages/*-runtime — engine-agnostic logic   │
         │  animation · input ·                        │
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
