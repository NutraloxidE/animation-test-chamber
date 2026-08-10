# Animation Test Chamber

> **Human readers / 人間向け:** [English guide](README-forhuman-en.md) · [日本語ガイド](README-forhuman-jp.md)
>
> **Coding agents:** continue with this README. It is intentionally implementation-oriented.

An **AI-native game development harness** for building browser-playable games by
editing one repository.

Clone or fork the repo for a game, let an agent work inside known boundaries,
and keep the engine, gameplay code, authored data, editor, tests and agent
instructions together:

```text
clone / fork this repository
  → describe the game or mechanic
  → AI edits Gameplay Scripts / Prefabs / Scenes / game UI / animation assets
  → typed runtime boundaries reject invalid shortcuts
  → harnesses verify architecture, determinism and browser behaviour
  → commit the resulting game
```

The repository started as an animation tuning chamber, and that workflow remains
part of the system. It now also contains the runtime and extension layer needed
to build game mechanics without adding a new engine Component for every rule.

## AI: START HERE

If you are a coding agent asked to build or change a game in this repository,
use this as your boot sequence before editing code:

1. Read this README completely.
2. Read [`agents/GAMEPLAY_VIBE_CODING.md`](agents/GAMEPLAY_VIBE_CODING.md).
3. Inspect the closest existing Gameplay Script before inventing a new pattern:
   - [`packages/gameplay/src/scripts/health/`](packages/gameplay/src/scripts/health/)
   - [`packages/gameplay/src/scripts/stamina/`](packages/gameplay/src/scripts/stamina/)
   - [`packages/gameplay/src/scripts/air-dash/`](packages/gameplay/src/scripts/air-dash/)
4. If the request changes CharacterMotor movement, also read
   [`agents/skills/add-character-movement.md`](agents/skills/add-character-movement.md).
5. Prefer extending **game code and authored data** over changing engine code.
6. Do not create a mechanic-named native Component, central runtime switch,
   renderer special case or Simulation branch for an ordinary game mechanic.
7. Preserve canonical/runtime separation and deterministic fixed-tick behaviour.
8. After implementation, regenerate derived gameplay data and run focused tests.
9. Before claiming a substantial feature complete, run the repository-wide
   harness.

Default verification sequence:

```bash
pnpm gameplay:generate
pnpm gameplay:check
pnpm typecheck
pnpm lint
pnpm harness:one-shot
```

### AI implementation routing

Translate the user's request into the narrowest existing extension surface
before touching engine internals.

```text
"add double jump"
  → Gameplay Script
  → ctx.self.character.command(...)
  → optional gameplay.* animation parameter
  → animation asset change only if visuals need a new state

"add poison damage"
  → Gameplay Script
  → Gameplay events / runtime state
  → no engine Component

"add knockback when the enemy is hit"
  → Gameplay Script
  → ctx.world.get(target)?.character?.command({ type: 'impulse', ... })
  → no direct velocity or transform write

"add a moving platform"
  → Gameplay Script
  → ctx.self.transform
  → do not use Character Motion unless the object has CharacterMotor authority

"add HP and stamina bars"
  → existing Gameplay Script state/events
  → apps/web/src/game-ui/
  → do not add editor chrome

"place three enemies in this level"
  → Prefab + Scene authored data
  → do not hard-code level composition in the renderer
```

If an ordinary gameplay request appears to require edits across schema,
renderer, runtime factories and Simulation, stop and inspect the existing SDK and
Gameplay Script examples first. That is usually a sign that the feature is being
implemented at the wrong layer.

## What this repository is

This is currently designed as a **repository-distributed engine**, not as a
small library that a separate game project imports.

A game gets the whole environment:

```text
engine/runtime packages
+ Gameplay SDK
+ Gameplay Scripts
+ Prefabs and Scenes
+ browser play surface
+ animation authoring/tuning tools
+ game UI seam
+ AI instructions and skills
+ deterministic harnesses
+ Git-friendly canonical data
```

That is intentional for vibe coding: an agent can inspect and modify the entire
working environment without first reconstructing engine conventions from an
external package.

## Quick start

```bash
pnpm install
cp .env.example .env     # optional: every value in it is optional
pnpm dev
```

Open <http://localhost:5173>.

The root URL is the game front door:

```text
/                  play the active canonical Scene, or the first Scene
/play/:sceneId     play one exact Scene; never silently falls back
/edit/scene/:id    Scene Editor
/edit/prefab/:id   Prefab Editor
```

The repository ships a complete game built this way — a 5 v 5 third-person
skirmish with a 300-second day/night match, economy, equipment and progression,
all of it Gameplay Scripts and authored data:

```text
/play/wildlands-skirmish
```

See [`docs/wildlands-skirmish.md`](docs/wildlands-skirmish.md). It is the worked
example to read before building a game of your own here.

`/` mounts the play surface without Scene Editor or Prefab Editor chrome.

With an empty `.env` the local project remains usable. Git and AI capabilities
that require external credentials fall back or report their unavailable state
explicitly rather than becoming hidden runtime dependencies.

## The main vibe-coding rule

**Game rule = Gameplay Script. Engine capability = native Component.**

Ordinary mechanics belong here:

```text
packages/gameplay/src/scripts/<script-id>/<version>.ts
```

Examples include:

- health, stamina and cooldowns
- damage, healing and status rules
- doors, pickups and moving props
- enemy or encounter rules
- dash, knockback, launch and movement modifiers
- runtime spawning and despawning

A Gameplay Script is referenced through the one generic native `script`
Component. Published references are exact:

```text
asset id + version + content hash
```

Changing script source therefore does not silently change the meaning of an
already-published Prefab reference.

After adding or changing a Gameplay Script:

```bash
pnpm gameplay:generate
pnpm gameplay:check
pnpm harness:gameplay
```

Start with [`agents/GAMEPLAY_VIBE_CODING.md`](agents/GAMEPLAY_VIBE_CODING.md).

## Character movement is also a Gameplay Script concern

CharacterMotor-driven objects have one world-space authority:

```text
Gameplay Script
    ↓ typed CharacterMotionCommand
ControllableCharacter
    ↓ ExternalMotionFrame
Simulation
    ↓
movement / root motion / gravity / terrain
```

Gameplay code does not directly rewrite a character transform or reach into the
private Simulation.

The current Character Motion command vocabulary includes:

```text
impulse
motion-override
movement-scale
teleport
```

For example, an air dash remains ordinary game code:

```ts
ctx.self.character?.command({
  type: 'motion-override',
  key: 'dash',
  velocity: { x: 0, y: 0, z: 12 },
  space: 'camera',
  durationTicks: 9,
  horizontal: 'replace',
  vertical: 'preserve',
  facing: 'velocity',
});
```

Gameplay Scripts may also expose namespaced runtime animation parameters such
as:

```text
gameplay.dashing
gameplay.stunned
gameplay.grappling
```

Animation Behavior assets react to those parameters. Gameplay code does **not**
select clips directly.

See [`agents/skills/add-character-movement.md`](agents/skills/add-character-movement.md).

## Ordinary object movement

A non-CharacterMotor GameObject can be moved at runtime through the Gameplay
object transform API.

```text
moving platform / door / pickup / rotating trap
  → Gameplay Script
  → ctx.self.transform
```

The same transform path refuses CharacterMotor-owned nodes and directs the
caller to the character command API instead. This keeps character simulation
from gaining a second transform authority.

## Runtime model

Canonical authoring data and mutable game state are intentionally separate:

```text
CANONICAL
  Scene
  Prefab
  Script Component
  Gameplay Script exact reference
  Animation assets
       │
       ▼
RUNTIME
  RuntimeScene
  RuntimeGameObject
  GameplayScriptRuntime
  ControllableCharacter / Simulation
```

Runtime state such as HP, cooldown counters, active motion overrides, spawned
objects and current positions does not write itself back into canonical Scene or
Prefab data.

Gameplay execution uses fixed ticks, deterministic per-instance RNG, deferred
events and bounded runtime operations. The same canonical data plus the same
inputs should produce the same simulation result.

## Browser play surface

The production play surface uses the canonical project, authored active Camera,
fixed-step RuntimeScene and the existing browser input sampler.

Human input is normalized before it reaches a character. Camera yaw is passed
into character simulation, so movement and camera-space Gameplay commands use
the same definition of forward.

Game-owned HUD work has an explicit surface:

```text
apps/web/src/game-ui/GameOverlay.tsx
```

Requests such as “show HP”, “add a stamina bar” or “show a lock-on reticle”
should normally stay in the game UI layer rather than creating editor chrome.

## Animation workflow

Animation remains reusable authored data rather than character-specific code.
A character can reference shared Behavior assets while supplying its own motion
bindings and tuning.

The animation workflow is still:

```text
AI proposes adjustments
  → compare under identical conditions in the browser
  → fine-tune by feel
  → validate and stage the diff
  → save canonical data
  → commit
```

The native Animator workspace, Prefab composition, motion bindings, root motion,
terrain interaction and replay infrastructure remain part of the same repo.

## Controls

The authored input map is the source of truth. The demo mapping currently
includes:

| Action | Keyboard | Gamepad | Touch |
| --- | --- | --- | --- |
| Move | WASD | Left stick | On-screen stick |
| Look | Mouse | Right stick | Drag the right side |
| Jump | Space | A / cross | A |
| Primary action | J or F | X / square | X |
| Secondary action | K | Y / triangle | Y |
| Dodge | Shift | B / circle / RB | B |
| Guard | L | LT / LB | LB |
| Interact | E | Start | — |
| Pause | Esc | Options | — |

## Commands

| Command | What it does |
| --- | --- |
| `pnpm dev` | Runs the web app and API locally |
| `pnpm build` | Builds the production web app |
| `pnpm gameplay:generate` | Regenerates the exact Gameplay Script registry |
| `pnpm gameplay:check` | Fails if the generated Gameplay registry is stale |
| `pnpm harness:gameplay` | Gameplay Script runtime tests |
| `pnpm harness:character-motion` | Character Motion ABI checks and tests |
| `pnpm harness:play-surface` | Play-only route/import boundary checks |
| `pnpm harness:vibe-coding` | Checks the intended game-extension path |
| `pnpm harness:unit` | Unit tests |
| `pnpm harness:integration` | Integration tests |
| `pnpm harness:replay` | Deterministic replay regression suite |
| `pnpm harness:visual` | Browser / Playwright verification |
| `pnpm harness:repo-guard` | Repository protection and integrity checks |
| `pnpm harness:one-shot` | Runs the repository-wide completion gate and writes a report |
| `pnpm schema:generate` | Regenerates schemas and generated canonical views |
| `pnpm unity:export` | Writes the Unity export bundle |
| `pnpm seed:demo -- --force` | Re-seeds demo canonical data; destructive |

Before claiming a large feature complete, prefer:

```bash
pnpm gameplay:generate
pnpm gameplay:check
pnpm typecheck
pnpm lint
pnpm harness:one-shot
```

## Project layout

```text
apps/web
  browser game runtime, editors, renderer and game UI

apps/api
  Git / AI / asset endpoints and server-only capabilities

packages/schema
  canonical TypeBox definitions

packages/gameplay-sdk
  stable AI-facing Gameplay Script ABI

packages/gameplay
  game-specific Gameplay Scripts + generated exact registry

packages/game-object-runtime
  RuntimeScene, RuntimeGameObject and generic Script runtime adapter

packages/character-control-runtime
  normalized character control and Character Motion command ownership

packages/replay-runtime
  deterministic character Simulation

packages/animation-asset-runtime
packages/animation-runtime
packages/input-runtime
packages/terrain-runtime
packages/haptics-runtime
  reusable engine runtime capabilities

packages/prefab-runtime
  Prefab resolution, composition and validation

projects/
  canonical project / Scene data

harness/
  executable architectural contracts and completion gates

agents/
  AI system prompt, workflows, skills and handoffs

reports/
  harness and migration evidence
```

Generated outputs are not canonical authoring sources. Do not hand-edit generated
registries or generated schema views when a generator owns them.

## Where an AI should edit

A useful default routing table is:

| User intent | Normal edit surface |
| --- | --- |
| Add a game rule | Gameplay Script |
| Add HP / stamina / cooldown | Gameplay Script |
| Add dash / knockback / lunge | Gameplay Script + Character Motion API |
| Move an ordinary prop at runtime | Gameplay Script transform API |
| Add/change animation behaviour | Animation assets / native Animator workflow |
| Change reusable object composition | Prefab |
| Place objects in a level | Scene |
| Add HUD / game-only UI | `apps/web/src/game-ui/` |
| Add a new reusable engine capability | native Component/runtime work |

A normal game mechanic should **not** require a mechanic-named native Component,
a new central runtime switch, a router edit or a renderer special case.

### Before editing engine code

An AI should be able to answer all of these before changing a native runtime
package for a game feature:

- Why can this not be represented as a Gameplay Script?
- Why can it not use an existing Character Motion or transform command?
- Why is the capability reusable across unrelated game mechanics?
- Which deterministic authority should own it?
- Which schema, runtime, host/editor/export and harness surfaces must change?

If those questions do not have clear answers, keep the feature in game code.

## What protects the architecture

The repo is intentionally more than source code. Its tests, schemas, generated
registries, Decision Records and agent documentation act as executable
constraints.

Examples:

- Gameplay Script id/version must match its source path.
- exact script hashes are validated at runtime.
- CharacterMotor transforms reject ordinary direct transform writes.
- Character Motion command conflicts use deterministic arbitration.
- operation budgets prevent runaway script loops from becoming unbounded work.
- runtime state stays isolated per instance.
- `/play/:sceneId` is exact and does not guess another Scene.
- the one-shot harness invokes gameplay, play-surface, vibe-coding and character-motion gates.

## Deploying to Vercel

The web app builds to a static bundle:

```bash
pnpm build
```

`vercel.json` configures installation, build and `apps/web/dist` output.

Static deployment can run the browser game/runtime and read-only client-side
surfaces. Operations that require server credentials or filesystem/Git writes
need the local/API-backed environment and must report that limitation explicitly.

## Current status

The Gameplay Script ABI, Character Motion command layer and browser play path are
implemented and exercised by unit and browser tests.

The repository still treats full harness closure as the release criterion. Do
not infer “everything is finished” from a successful local feature test alone.
Run the current harness and inspect:

- [`reports/one-shot-report.md`](reports/one-shot-report.md), when generated
- [`reports/gameplay-vibe-coding-audit.md`](reports/gameplay-vibe-coding-audit.md)
- [`ARCHITECTURE.md`](ARCHITECTURE.md)

The checked-in gameplay audit may intentionally remain `HOLD` until its required
visual and repeated one-shot closure has actually been demonstrated.
