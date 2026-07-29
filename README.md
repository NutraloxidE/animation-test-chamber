# Animation Test Chamber

A browser-first environment for tuning character animation — state machines,
transitions, input handling, root motion, terrain interaction and haptics — by
generating AI adjustment proposals, comparing them under identical conditions,
adjusting them by feel, and committing the result straight to Git as canonical
data.

The loop it closes:

```text
AI proposes several adjustments
  → a human compares them under identical conditions in the browser
  → a human fine-tunes with sliders, a timeline and a graph
  → the diff is validated and staged
  → it is saved to canonical data
  → it is committed to a working branch / pull request
  → the next agent reads the canonical data and the diff directly
```

No step where a human has to re-describe, in prose, what they changed.

## Quick start

```bash
pnpm install
cp .env.example .env     # optional: every value in it is optional
pnpm dev
```

Open <http://localhost:5173>.

With an empty `.env` the chamber is fully usable:

- Git operations run through an in-memory **Fake Git Adapter**
- AI tuning runs through a deterministic **rule-based provider**
- FBX/BVH conversion is reported as an explicit **pending job**

No external service, API key or asset is required to boot, play, tune, compare,
validate or commit.

### Commands

| Command | What it does |
| --- | --- |
| `pnpm dev` | Runs the web app (5173) and the API (8787) |
| `pnpm harness:one-shot` | Runs every check and writes `reports/one-shot-report.md` |
| `pnpm harness:unit` | Unit tests |
| `pnpm harness:integration` | Edit → stage → validate → commit → export |
| `pnpm harness:replay` | Deterministic replay regression suite |
| `pnpm harness:visual` | Playwright, across desktop / mobile / 320px |
| `pnpm harness:repo-guard` | Protection, test-integrity and secret checks |
| `pnpm schema:generate` | Regenerates `schemas/` and `presets/terrain/` |
| `pnpm unity:export` | Writes the Unity bundle to `generated/unity/` |
| `pnpm seed:demo -- --force` | Re-seeds the demo project (overwrites canonical data) |

## Controls

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

Button prompts follow the device you used last. The on-screen pad appears
automatically on touch devices and can be forced on or off.

## What protects your work

The chamber's second job — after making tuning fast — is stopping later edits
from quietly undoing a value you already decided was right. Every canonical
value can carry a protection level:

| Level | Meaning |
| --- | --- |
| `editable` | Normal. Anyone may change it. |
| `approval-required` | An AI may *propose* a change; nothing is applied without human approval. |
| `locked` | No change at all until a human explicitly unlocks it. |
| `invariant` | A project-wide rule; tooling may never change it. |

This is enforced in four independent places, so no single bug or careless agent
can bypass it: the edit session in the browser, the AI proposal generator, the
API server before it commits, and the repo guard in the harness.

Try it: open the Terrain panel and attempt to drag **Jump height**. It is
locked, and the slider is disabled until you unlock it deliberately.

## Project layout

```text
apps/web           the chamber UI (React, R3F, Zustand)
apps/api           Hono server: Git, AI and asset endpoints; holds all secrets
packages/schema    TypeBox definitions — the single source of truth
packages/*-runtime engine-agnostic simulation: animation, input, terrain, haptics, replay
packages/editor-core   preview → staged → validated → committed
packages/git-adapter   fake and GitHub App implementations
packages/ai-adapter    provider interface + deterministic rule-based fallback
packages/acquisition-core  GLB import, provenance, licence policy
packages/unity-export  export bundle + generated C# DTOs
projects/          canonical project data (edited through the app)
presets/, schemas/, generated/   regenerable views — never edit by hand
harness/           the checks an agent must pass before claiming completion
agents/            system prompt, subagent policy and skill definitions
```

`generated/` is build output. Nothing reads from it as a source of truth, and
the repo guard fails if anything tries.

## Status

See [`reports/one-shot-report.md`](reports/one-shot-report.md) after running the
harness, and the "Known limitations" section of
[`ARCHITECTURE.md`](ARCHITECTURE.md) for an honest account of what is
implemented, what falls back, and what is scaffolding.
