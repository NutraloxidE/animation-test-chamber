# Architecture

This document records the things that are hard to read off the code: the
boundaries, why they sit where they do, and what is deliberately not built.
Anything that *can* be read from the code — field names, ranges, defaults,
validation rules — is not duplicated here on purpose (see DECISIONS/0001).

## The shape of the system

```text
         ┌──────────────────────────────────────────────┐
         │ apps/web — the chamber UI                    │
         │  Viewport (R3F) · Inspector · Graph ·        │
         │  Timeline · Replay · Diff · AI · Capability  │
         └───────────────┬──────────────────────────────┘
                         │ EditSession (preview → staged)
                         │ ChamberEngine (fixed-step simulation)
         ┌───────────────┴──────────────────────────────┐
         │ packages/*-runtime — engine-agnostic logic   │
         │  animation · input · terrain · haptics ·     │
         │  replay · runtime-core                       │
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
         │  mints GitHub tokens · commits               │
         └───────────────┬──────────────────────────────┘
                         │
              projects/*.json  →  Git branch  →  PR
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

## Regression policy

A replay difference is never automatically the new truth. `compareTraces`
reports differences across both layers' state sequences, positions, event
timing and foot metrics; the decision to accept is a human's. Golden screenshots
are not used as the primary signal — the trace is, because it says *what*
changed rather than that something looks different.

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
