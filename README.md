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

Animation is **reused**, not re-implemented. A character does not own its state
machine; it references one:

```text
pick a Behavior asset
  → equip a Motion Set (this character's clips, bound to the behaviour's slots)
  → check rig compatibility
  → feel it in the chamber
  → adjust only this character's values
  → choose where that adjustment lives: the character, its tuning profile,
    a behaviour variant, or a new version of the shared behaviour
```

The demo project ships two characters on one behaviour asset. The harness fails
if their state sequences ever diverge, or if any motion slot ever resolves to the
same clip for both — the first would mean the behaviour is not really shared, the
second that the second character is not really a second character. Browse it all
in the **Asset Library** workspace.

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
| `pnpm build` | Static production build of the web app into `apps/web/dist` |
| `pnpm preview` | Serves that build locally, with no API behind it |
| `pnpm harness:one-shot` | Runs every check and writes `reports/one-shot-report.md` |
| `pnpm harness:unit` | Unit tests |
| `pnpm harness:integration` | Edit → stage → validate → commit → export |
| `pnpm harness:replay` | Deterministic replay regression suite |
| `pnpm harness:visual` | Playwright, across desktop / mobile / 320px |
| `pnpm harness:repo-guard` | Protection, test-integrity and secret checks |
| `pnpm schema:generate` | Regenerates `schemas/` and `presets/terrain/` |
| `pnpm unity:export` | Writes the Unity bundle to `generated/unity/` |
| `pnpm seed:demo -- --force` | Re-seeds the demo project (overwrites canonical data) |

## Deploying to Vercel

The web app builds to a static bundle, so it deploys as-is:

```bash
pnpm build          # -> apps/web/dist
```

`vercel.json` already sets the install command, the build command and
`apps/web/dist` as the output directory. Import the repository on Vercel, leave
the framework preset as **Other**, and deploy — no environment variables are
needed.

Vercel serves static files only; there is no Hono server behind the deployment.
The app probes `/api/health` once on load and adapts:

| Feature | Static deployment |
| --- | --- |
| Playback, input, terrain, haptics, timeline, state graph | Works — all client-side |
| Inspector tuning, diff, staging (persisted in `localStorage`) | Works |
| Replay playback and before/after comparison | Works |
| AI proposals | Works — the rule-based provider runs in the browser |
| Anthropic-backed AI | Unavailable (needs a server to hold the key) |
| Commit / pull request | Unavailable — buttons disabled |
| Asset Library: browse, search, detail, dependencies, version diff | Works — the generated index carries whole assets |
| Applying an asset set to a character for preview | Works — preview only, nothing is written |
| Publishing an asset, creating a variant or fork | Unavailable — needs a server to write files |
| Unity export, animation import | Unavailable — both write to disk |

The disabled features say why, rather than failing with a network error. Run
`pnpm dev` locally to get all of them back.

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

## Where things live

The editor is laid out around one question — *what is selected?*

- **Hierarchy** (left) is the world: its instances, their equipment
  attachments, the terrain and the camera. Rows select; they do not edit.
- **Inspector** (right) shows whatever the hierarchy has selected. Select an
  instance to edit its transform, loadout and intent source; select its shield
  to edit that one slot. There is no tab strip — and no `World` tab, because
  the instance list is the hierarchy now.
- **Bottom dock** — opened with **Editor** — holds the workspaces, grouped
  Create / Animate / Tools: Project/Assets, Import, Animation, Graph, Timeline,
  Replay, AI, Diff and Haptics. The inspector stays visible while they change.
- **View: World | Isolate | Rig** in the toolbar is a display choice. It never
  moves your selection. World and Isolate are the same renderer under two
  visibility filters; Rig is the focused skinned viewport with the weapon-grip
  gizmo and terrain debugging.

Two badges are worth learning. `INSTANCE` means the change affects only the
selected instance; `SHARED` means it affects every instance referencing that
definition. `PREVIEW` means nothing is being saved at all.

The Animation workspace has two modes, and the difference between them is the
point (DECISION 0013):

- **Clip Preview** samples a resolved clip and displays the pose. It executes
  nothing — no transitions, no semantic events, no recovery, no gameplay root
  motion — and says so on the panel. Its transport is in seconds of clip time,
  so `speed = 1` plays the clip at its authored duration. Nothing is written to
  the project, the world or any asset, and **Clear preview** restores authored
  behaviour exactly.
- **State Sandbox** runs the real runtime in a separate disposable simulation
  built from the same resolved document. Transitions, exit times, cancel
  windows, buffered input, events, recovery and root motion all execute. The
  live world is never advanced, moved or recorded by it.

Both follow the Hierarchy selection by default, and either can be **pinned** to
one instance so it stays put while you select elsewhere.

Two instances of the same character can therefore carry different weapon modes
and different equipment without either one changing the other, or the shared
character definition they both point at.

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

Try it: select **Terrain** in the Hierarchy and attempt to drag **Jump
height**. It is locked, and the slider is disabled until you unlock it
deliberately.

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
