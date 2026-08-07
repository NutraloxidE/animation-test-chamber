# 18 — Route-Scoped Rig / Scene / ControllableCharacter: baseline audit

Phase 0 of `WP_ROUTE_SCOPED_RIG_SCENE_CONTROLLABLE_CHARACTER`. This report records
what the repository actually does *before* any of that work package is
implemented, so that every later claim about "preserved behaviour" has something
to be measured against.

Nothing in this report is projected, inferred from a diff, or copied from a
previous review. Every result below came from a command run in this session on
the branch's base commit.

---

## 1. Execution identity

| Field | Declared by the work package | Actual |
| --- | --- | --- |
| Repository | `NutraloxidE/animation-test-chamber` | same |
| Required base SHA | `d4be2dfa9e7f5844ee6b5166950c0fcce1a5eeeb` | **not HEAD** |
| Actual `origin/main` | — | `2e5b2a21a269f41aad7f14c00b0cded91233f33f` |
| Implementation branch | `claude/edit-rig-scene-controllable-character` | created from `2e5b2a2` |

`d4be2df` is a direct ancestor of `2e5b2a2`; `main` moved forward by exactly one
commit after the work package was authored. Nothing diverged. The deviation from
§0 was raised before any file was edited and the decision to branch from live
`main` was taken explicitly rather than silently.

The one intervening commit is `2e5b2a2` *Fix staged asset patches and demo
overrides*, touching two files:

```text
apps/web/src/store.ts                 +27 -5
projects/demo-character/project.json  +13 -1
```

Its `project.json` half adds two authored animation `instanceOverrides` to a demo
character:

```json
{ "path": "/graph/states/walk/speed", "op": "set", "value": 1.53 }
{ "path": "/graph/states/run/speed",  "op": "set", "value": 1.21 }
```

**This is the cause of the two red harnesses recorded in §2.** See §2.1.

`removed-world-alt` (`9f85753`) was not fetched into the working tree, not
merged, not cherry-picked, and not read as an implementation source.

---

## 2. Baseline harness results

Run on `2e5b2a2` with a clean working tree, after `pnpm install --frozen-lockfile`.

| Harness | Result |
| --- | --- |
| `typecheck` | PASS |
| `lint` | PASS |
| `harness:unit` | PASS |
| `harness:integration` | PASS |
| `harness:replay` | **FAIL** — 1 file, 1 test of 112 |
| `harness:repo-guard` | PASS |
| `harness:world` | PASS |
| `harness:capabilities` | PASS |
| `harness:animation-assets` | **FAIL** — 6/7 checks passed |

`harness:visual` was not run: Playwright browsers are not provisioned in this
environment. It is recorded as **not run**, not as passing.

`harness:one-shot` and `harness:build` were not run at baseline; they are gated
on the two failures above and would report the same cause.

### 2.1 The two failures share one cause and pre-date this work

Both failures are deterministic-trace comparisons against committed legacy
baselines:

```text
tests/replay/animation-assets/shared-behavior.test.ts
  "reproduces the pre-migration traces exactly" — traceHash/events/metrics differ

harness/check-animation-assets.ts → shadow-compare
  jump-buffer-before-landing:  finalPosition z 14.205272 → 14.977781
  dodge-jump-queued:           traceHash 2aec944e… → d37b8e5e…
```

Verified by checkout, not by reasoning: the same test **passes at `d4be2df`** and
**fails at `2e5b2a2`**. The authored walk/run speed overrides added by the head
commit legitimately change simulated motion, and the committed trace baselines
were not regenerated alongside them.

Consequences for this work package:

- these are **pre-existing reds on `main`**, not regressions introduced here;
- §22 forbids weakening or re-baselining tests to obtain green CI, so this audit
  does **not** touch either baseline;
- any later claim of "one-shot passes twice" is impossible until the owner of
  `2e5b2a2` decides whether the trace change was intended (regenerate baselines)
  or accidental (revert the overrides). This is flagged as a blocker for
  §29.60, not resolved unilaterally.

---

## 3. Inventory: what depends on `World`

### 3.1 Canonical schema

- `packages/schema/src/world.ts` (205 lines) — `TransformDefinition` (position +
  **yaw only**), `RuntimeInstanceSource`, `IntentSourceDefinition`,
  `IntentTrackKeyframe`, `IntentTrackDefinition`, `RuntimeInstanceOverrides`,
  `RuntimeInstanceDefinition`, `WorldDefinition`, `DEFAULT_INSTANCE_TRANSFORM`.
- `packages/schema/src/project.ts` — `ProjectDefinition.world?: WorldDefinition`
  (optional, §3.2 of the WP replaces it with `scenes[]`).
- `packages/schema/src/validate.ts`, `packages/schema/src/index.ts`.
- `schemas/WorldDefinition.schema.json`, `schemas/RuntimeInstanceDefinition.schema.json`,
  `schemas/ProjectDefinition.schema.json`.

Migration-relevant detail: the current transform is **yaw-only by design** —
`world.ts` documents pitch/roll as "deliberately absent: the runtime is yaw-only".
§6.4's quaternion transform is therefore a genuine widening, and the runtime will
need `yaw = f(quaternion)` at construction (WP §6.4 permits exactly this).

### 3.2 Runtime

`packages/world-runtime/src/` — 8 files, ~1,150 lines:

| File | Owns | Migration target |
| --- | --- | --- |
| `intent.ts` | `NormalizedIntent = ActionSample`, `IntentSource`, Neutral/Injected/ScriptedTrack/Replay sources | `@atc/character-control-runtime` (WP §13) |
| `world.ts` | `WorldRuntime`, per-instance `RuntimeInstanceState`, declaration-order tick loop, `seedOf` | split: per-character half → `ControllableCharacter`, orchestration → `SceneRuntime` |
| `resolve.ts` | `worldOf`, `synthesizeLegacyWorld`, `animationResolutionKey`, bundle cache | `@atc/scene-runtime/resolve.ts` |
| `observation.ts` | instance-qualified observation paths | scene observation (§14.7) |
| `trace.ts`, `world-replay.ts`, `world-control.ts`, `simulate.ts` | trace/replay/camera-yaw/stateless sim | `@atc/scene-runtime` |

The existing code already satisfies several WP §13 requirements that a rewrite
would have put at risk, and they must be carried across rather than
re-derived:

- `NormalizedIntent` is **already** aliased to `ActionSample` (`intent.ts:23`),
  with a comment explaining why a second intent shape was rejected. WP §13.2 is
  a rename, not a new decision.
- instances never poll devices; the host calls `injectLocalIntent(playerIndex,…)`
  (`world.ts:201`). WP §13.5 already holds.
- the tick loop iterates `this.order` (declaration order) and explicitly refuses
  to iterate the `Map` (`world.ts:217-244`). WP §14.3 already holds.
- `reset()` reconstructs from constructor options rather than hand-resetting
  `Simulation` internals (`world.ts:311`). WP §14.6 already holds.
- `resolveWorld` caches **bundles**, not resolved projects, keyed by
  `animationResolutionKey` which deliberately excludes character identity
  (`resolve.ts:134-149`). WP §13.10 already holds and is structurally asserted
  by `harness:world`.

### 3.3 Capability layer

`packages/capability-runtime/src/` — `world-capability.ts`, `world-commands.ts`,
`reference-capability.ts`, `manifest.ts`, `registry.ts`. `context.world` is read
in ~25 places across `world-commands.ts` and `reference-capability.ts`. WP §15.2
replaces the hard-coded world context with a discriminated `CommandContext`;
this is a context-type refactor, and the four-path completeness check
(`harness:capabilities`, currently PASS) must keep passing throughout.

### 3.4 Web app

- `apps/web/src/store.ts` — **1,902 lines**, the monolith WP §16.1 splits.
- `apps/web/src/App.tsx` — 462 lines. There is **no router**: `main.tsx` renders
  `<App/>` directly. Mode selection is `worldMode: 'world' | 'focused'` state in
  the store plus a `toggle-world-mode` button (`App.tsx:169-179`) and a `world`
  entry in the `PANELS` tab list — exactly the "World tab / World mode" surface
  WP §2.3 removes.
- `apps/web/src/components/world/WorldViewport.tsx`, `WorldPanel.tsx`.
- `apps/web/src/world/world-engine.ts`, `apps/web/src/engine.ts`.
- `apps/web/src/test-driver.ts`.

Competing notions of "the current character", all independently writable today
(WP §16.5 collapses these into one route-derived resolver):

```text
ProjectDefinition.activeCharacterId      canonical
store.characterPresetId                  visual preset selection
AssetLibrary / AssetBrowser              their own reads of activeCharacterId
world.focusedInstanceId                  which instance the focused view opens on
```

### 3.5 Direct `Simulation.step` callers

```text
apps/web/src/engine.ts:370          device sample → simulation.step   ← WP §10.6 removes
apps/web/src/world/world-engine.ts:118   runtime.step()               ← host loop, stays
packages/replay-runtime/src/replay.ts:93                              ← replay primitive, stays
packages/world-runtime/src/world.ts:237  intentSource → simulation.step ← moves into ControllableCharacter
packages/world-runtime/src/world-replay.ts:101, harness/check-world.ts  ← harness/replay drivers
```

`apps/web/src/engine.ts:370` is the one production device-to-`Simulation`
shortcut the work package forbids. It is the Rig Editor's live preview path.

### 3.6 Repository write paths

`apps/api` exposes 33 routes across `app.ts`, `routes/animation-assets.ts`,
`routes/capabilities.ts`. There is **no** `/api/repository/apply` today. The
closest existing analogues, whose destination semantics WP §8.3 requires
preserving, are:

```text
POST /api/animation-assets/save-destination   character override / tuning /
                                              behavior variant / shared / new clip versions
POST /api/animation-assets/apply
POST /api/commit                              git — already separate from apply
POST /api/pull-request                        git — already separate
```

`Apply` and `git commit` are therefore **already** separate operations
(WP §4.6 / §9.5 preserve rather than introduce this).

### 3.7 Deployment

`vercel.json` has `framework: null`, an `outputDirectory` and two `headers`
blocks. It has **no `rewrites`**. A nested route such as `/edit/rig/honoka`
would 404 on refresh today — WP §5.3 requires adding a SPA rewrite that
preserves `/api/*` and `/assets/*`.

### 3.8 Tests referencing World

```text
tests/fixtures/world.ts
tests/unit/world/world-contract.test.ts
tests/unit/capabilities/capability-registry.test.ts
tests/integration/world/{ai-workflow,render-cadence,replay-lifecycle,resolution-isolation}.test.ts
tests/integration/unity/world-export.test.ts
tests/integration/api/capabilities.test.ts
tests/replay/world/world-replay.test.ts
tests/visual/world/world-authoring.spec.ts
```

WP §22 requires these to be **renamed and migrated with their assertions
intact**, never deleted. They are the evidence that the Scene migration
preserved behaviour, so they migrate *before* `@atc/world-runtime` is removed
(WP Phase 3).

---

## 4. Required decisions (WP §21 Task A)

### 4.1 Schema migration boundary

One versioned entry point, `loadProjectDocument(raw)`, in
`packages/schema/src/migration.ts`. It parses the current shape first, falls
back to `LegacyProjectDefinitionWithWorld`, runs `migrateWorldToScenes`, and
validates the result. No `project.world ?? …` checks anywhere else.
`ProjectDefinition.world` is removed from the current schema; the legacy shape
keeps it and is the only type that names it.

`TransformDefinition` widens to position + quaternion rotation + scale. Legacy
`yawRad` migrates to a quaternion about world Y; `SceneRuntime` derives yaw back
from the quaternion when constructing `Simulation`, which stays yaw-only. The
authored transform is never discarded.

### 4.2 Generic session boundary

`EditSession` today is specialised on `ResolvedProject` and additionally owns the
asset-vs-project path split (`ASSET_OWNED_PREFIXES`, `stagedAssetChanges`,
`buildStagedProjectDocument`). The generic `DocumentEditSession<TDocument>` takes
the target identity, staging, undo/redo, protection, provenance, diff and
validation. The asset-destination split stays a **Character-session concern**,
not something pushed into the generic base — Scene sessions have no asset-owned
paths, and generalising the prefix list would invite a Scene edit to be routed
into an animation asset.

### 4.3 `ControllableCharacter` extraction boundary

Cut `WorldRuntime` along the line already visible in `RuntimeInstanceState`:
everything in that interface plus the body of the per-instance branch of `step()`
becomes `ControllableCharacter`; `order`, the clock, controls and the loop stay
in `SceneRuntime`. `intent.ts` moves wholesale, with `NormalizedIntent` re-exported
as `CharacterIntent`. `seedOf` moves with the character. This keeps the
deterministic seed derivation, the intent-source construction and the
per-instance `Simulation` in one unit and leaves nothing for a rewrite to
re-invent.

### 4.4 Repository apply transaction

`POST /api/repository/apply` reuses `packages/repository-transaction` (already
present, already exercised by `harness/check-transaction-recovery.ts`) for
prepare/validate/write/rollback. It resolves the target by ID from canonical
data, refuses on `expected.projectRevisionId` mismatch, replays typed operations
server-side, and writes an apply report. It does not call the git adapter.

### 4.5 Old package removal sequence

```text
1. add @atc/character-control-runtime alongside world-runtime (no deletions)
2. add @atc/scene-runtime, built on it
3. migrate tests/fixtures/world.ts → scene fixtures, assertions unchanged
4. migrate each tests/**/world/** file to the scene runtime
5. switch apps/web and apps/api imports
6. delete packages/world-runtime and schemas/WorldDefinition.schema.json
7. drop harness:world only once harness:scenes covers it
```

`@atc/world-runtime` is never deleted before its tests pass against the
replacement.

---

## 5. Status

```text
Phase 0: COMPLETE
Baseline: 7 of 9 runnable harnesses PASS, 2 FAIL pre-existing (§2.1), visual NOT RUN
Blocker for §29.60 (one-shot passes twice): the §2.1 trace baselines
Final Architecture Review: HOLD — no independent reviewer has run
```
