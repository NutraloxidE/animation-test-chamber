# Animation Test Chamber — Human Guide (English)

> This page is for people evaluating or using the project.
> Coding agents should read [`README.md`](README.md), which is intentionally more implementation-oriented.
>
> 日本語: [`README-forhuman-jp.md`](README-forhuman-jp.md)

## What is Animation Test Chamber?

Animation Test Chamber is an **AI-native, browser-first game development environment** designed around one idea:

> Clone the repository for a game, tell a coding agent what you want, and let the repository itself teach the agent how to build it without constantly modifying engine internals.

It started as a character-animation tuning environment and has grown into a gameplay platform containing:

- a browser game runtime
- Gameplay Scripts for ordinary game rules
- reusable character movement and animation systems
- Prefabs and Scenes
- Scene / Prefab / animation editing tools
- a game-only HUD surface
- deterministic tests and harnesses
- AI instructions, skills and architecture rules
- Git-friendly canonical project data

The goal is not to replace every general-purpose game engine feature. The goal is to make **vibe-coded prototypes and small-to-medium action games unusually fast to build and modify** while keeping the codebase understandable enough for another agent to continue later.

## How it is meant to be used

At the moment, Animation Test Chamber is a **repository-distributed engine**.

You normally use it by cloning or forking the entire repository for each game:

```text
Animation Test Chamber
        ↓ clone / fork
Your Game Repository
        ↓
Ask Claude Code / Codex / another coding agent to add features
        ↓
Gameplay Scripts / Prefabs / Scenes / UI / animation data change
        ↓
Harnesses check that the architecture still holds
```

It is **not currently designed as a tiny npm package that a separate game repository imports**.

That is intentional. Keeping the engine, game code, editor, tests and AI instructions in the same repository gives an agent enough context to work without first reconstructing the project's conventions.

## Quick start

Requirements:

- Node.js
- pnpm
- a modern browser

Then:

```bash
pnpm install
cp .env.example .env     # optional
pnpm dev
```

Open:

```text
http://localhost:5173
```

The root URL is the game itself.

```text
/                  play the active Scene
/play/:sceneId     play one exact Scene
/edit/scene/:id    Scene Editor
/edit/prefab/:id   Prefab Editor
```

Most local gameplay and editing features can run without external API keys. Server-only Git / AI integrations report their unavailable state explicitly when credentials are not configured.

## The important concept: game rules stay in game code

The central architecture rule is:

> **Game rule = Gameplay Script. Reusable engine capability = native Component.**

Examples of things that should normally be Gameplay Scripts:

- HP and stamina
- damage and healing
- cooldowns
- poison or status effects
- doors and pickups
- enemy encounter rules
- dash and knockback
- moving platforms
- spawning and despawning

Gameplay Scripts live under:

```text
packages/gameplay/src/scripts/
```

The repository already includes small examples for:

- `health`
- `stamina`
- `air-dash`

This means a request such as:

```text
"Add an enemy with 100 HP, knockback on hit and despawn on death"
```

should mostly become game-specific script / Prefab / Scene work rather than a new `EnemyHealthComponent`, renderer branch and simulation special case.

That is one of the main reasons the repository is intended to work well with coding agents.

## Character movement

Characters controlled by CharacterMotor have one movement authority.

Gameplay code asks for movement through typed commands instead of directly rewriting velocity or transforms.

Current high-level movement operations include:

- impulse
- temporary motion override
- movement scaling
- teleport

This is used for mechanics such as:

- dash
- knockback
- recoil
- launch
- slow / haste
- grapple-style movement

Animation can react to temporary `gameplay.*` parameters, while Gameplay Scripts remain separate from direct clip selection.

The practical result is that adding a new movement mechanic should usually remain a small game feature rather than becoming a new engine subsystem.

## What a normal AI-assisted workflow looks like

A typical workflow can be as simple as:

```text
1. Clone/fork the repository.
2. Give the coding agent a feature request.
3. Let it read README.md and the linked agent instructions.
4. Review the game in the browser.
5. Ask for another adjustment.
6. Run the harness before treating the feature as complete.
```

Example requests:

```text
"Add double jump."
"Give the player stamina and make air dash cost 20 stamina."
"Add an enemy that loses HP, gets knocked back and disappears at zero HP."
"Add a moving platform between these two points."
"Show HP and stamina in the HUD."
"Place three enemies in the current Scene."
```

The repository's AI-facing README tells the agent which extension surface each kind of request should use.

## Where things live

```text
apps/web/
  browser game, renderer, editors and game UI

apps/api/
  server-only Git / AI / asset capabilities

packages/gameplay/
  game-specific Gameplay Scripts

packages/gameplay-sdk/
  stable API exposed to Gameplay Scripts

packages/game-object-runtime/
  Scene / GameObject runtime and script host

packages/character-control-runtime/
  normalized character control and movement command handling

packages/replay-runtime/
  deterministic character simulation

packages/animation-*/
  animation runtime and authored animation support

packages/prefab-runtime/
  Prefab resolution and composition

projects/
  canonical project and Scene data

agents/
  instructions and skills for coding agents

harness/
  executable architecture and regression checks

reports/
  generated / checked-in verification evidence
```

## Browser game and editor

The project deliberately separates the game front door from editing tools.

`/` is the play surface and does not mount Scene Editor / Prefab Editor chrome.

Game-specific HUD work belongs under:

```text
apps/web/src/game-ui/
```

Authoring work uses the explicit `/edit/...` routes.

This keeps "make the game UI" and "make the editor UI" from becoming the same task.

## Animation is still a first-class part of the project

Animation Test Chamber began as an animation tuning tool, and those ideas remain important.

The project supports reusable animation behaviour, per-character motion bindings, root-motion-aware simulation, replay and browser-based comparison / tuning workflows.

The intended animation loop is still:

```text
AI proposes an adjustment
  → human compares it in the browser
  → human or AI fine-tunes it
  → canonical data changes
  → the change is validated and committed
```

The gameplay platform extends that workflow rather than replacing it.

## Verification

For ordinary development, focused checks exist for gameplay, character motion and the browser play surface.

For a larger change, the repository-wide gate is:

```bash
pnpm harness:one-shot
```

A useful full sequence is:

```bash
pnpm gameplay:generate
pnpm gameplay:check
pnpm typecheck
pnpm lint
pnpm harness:one-shot
```

The harness is part of the product design: it acts as an executable contract telling future agents what they are not allowed to quietly break.

## Building and deploying

Production web build:

```bash
pnpm build
```

The static web output is written to `apps/web/dist` and the repository contains Vercel configuration.

Static deployments can run the browser game and client-side surfaces. Features that require filesystem writes, server-held credentials or Git operations need the API-backed/local environment.

## Current status

The repository currently has working Gameplay Script, Character Motion and browser play-path foundations, with unit and browser coverage around the major extension paths.

It is still an evolving platform, not a claim that every general-purpose engine problem is solved. The project intentionally treats harness closure as stronger evidence than "the feature worked once on my machine."

For the exact implementation rules, current architecture boundaries and agent workflow, continue with:

- [`README.md`](README.md) — AI / implementation entrypoint
- [`agents/GAMEPLAY_VIBE_CODING.md`](agents/GAMEPLAY_VIBE_CODING.md)
- [`ARCHITECTURE.md`](ARCHITECTURE.md)
