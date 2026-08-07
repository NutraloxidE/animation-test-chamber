# Rig Editor main-branch UI inventory

Donor baseline: `main@2e5b2a21a269f41aad7f14c00b0cded91233f33f`
Restoration branch head at inventory time: `68e06edd6b598f0bd6c2626cbd2e1fee770b865c`

This is the preservation reference for the native restoration. `main` is a UI
donor and a behavioural baseline. It is not a merge source, and nothing here was
cherry-picked.

## 1. The central finding: the panels are already here

The right-side fine-tuning components were never removed from this branch. Their
blobs are byte-identical to the donor, so the restoration is a rewiring of their
data source, not a port of their markup.

| File | Donor blob | Branch blob | Status |
| --- | --- | --- | --- |
| `panels/TransitionInspector.tsx` | `54d962f6` | `54d962f6` | identical |
| `panels/StateGraph.tsx` | `23e96719` | `23e96719` | identical |
| `panels/Timeline.tsx` | `465c9076` | `465c9076` | identical |
| `panels/MotionTimingPanel.tsx` | `cdaff532` | `cdaff532` | identical |
| `panels/ReplayPanel.tsx` | `9a7d6926` | `9a7d6926` | identical |
| `panels/TerrainPanel.tsx` | `6f8468aa` | `6f8468aa` | identical |
| `panels/AiPanel.tsx` | `f4eddf95` | `f4eddf95` | identical |
| `panels/DiffPanel.tsx` | `5644d56c` | `5644d56c` | identical |
| `panels/CapabilityPanel.tsx` | `bdb0b360` | `bdb0b360` | identical |
| `panels/AcquisitionPanel.tsx` | `6edb6d01` | `6edb6d01` | identical |
| `panels/MobilePad.tsx` | `65f1d1a6` | `65f1d1a6` | identical |
| `panels/Field.tsx` | `b5a707bd` | `b5a707bd` | identical |
| `components/world/WorldPanel.tsx` | `a7144aab` | `a7144aab` | identical |
| `components/world/WorldViewport.tsx` | `6ba8c8e0` | `6ba8c8e0` | identical |
| `asset-library/SaveDestinationDialog.tsx` | `cca652dc` | `cca652dc` | identical |
| `App.tsx` | `e5eed5c2` | `b5749f61` | **differs** |
| `panels/Hierarchy.tsx` | `5dff1e9e` | `aa85537f` | **differs** |
| `asset-library/AssetLibrary.tsx` | `a40d8432` | `6243a19e` | **differs** |
| `three/Viewport.tsx` | `bfecec55` | `9a0e8157` | **differs** |
| `styles.css` | `c5872c58` | `a13eaab9` | **differs** |
| `store.ts` | `820a82eb` | `78bd010f` | **differs** |
| `engine.ts` | `7bbbf1ee` | `901f33f6` | **differs** |

This matches the work package's expected discovery. No identical file is
duplicated by this restoration.

## 2. Panel registry

Donor ordering, which Phase I restores:

| # | id | label |
| --- | --- | --- |
| 1 | `inspector` | Inspector |
| 2 | `world` | World |
| 3 | `graph` | Graph |
| 4 | `timeline` | Timeline |
| 5 | `timing` | Timing |
| 6 | `replay` | Replay |
| 7 | `terrain` | Terrain |
| 8 | `ai` | AI |
| 9 | `diff` | Diff |
| 10 | `capability` | Haptics |
| 11 | `acquisition` | Import |

The branch's current `App.tsx` carries the same list **with `world` removed** —
ten entries, Inspector through Import. Restoring `world` to position 2 is a
required change, subject to the Preview World semantics of Phase O.

## 3. Layout regions in the donor `App.tsx`

```text
workspace switch            (chamber <-> library)
top DockBar                 undo / redo / status
left Hierarchy dock         toggle-hierarchy
centre viewport             Viewport or WorldViewport, never both
HUD overlay                 live simulation readout
viewport controls           grip / camera / pad / pause / frame-step
right panel dock            tab strip + panel body, toggle-inspector
bottom Asset Library dock   showLibrary
dialogs                     Save Destination
banners                     stale draft, status bar
responsive bottom sheet     sheet-handle
```

The centre is a single WebGL surface: `worldMode === 'world' ? <WorldViewport /> : <Viewport />`.
That ternary is the donor's own one-viewport rule, and Phase M keeps it.

## 4. HUD values

`locomotionState`, `actionState`, `terrainState`, `speed`, `blendWeight`,
`tick`, `mode`, `replayProgress`, `recording`.

## 5. Viewport controls

`grip-editor-select`, `reset-grip`, `toggle-camera-control`, `toggle-pad`,
`toggle-pause`, `frame-step`, plus clean capture and the Unity export entry.

## 6. Keyboard shortcuts

| Keys | Action |
| --- | --- |
| `z` (no shift) | undo |
| `y`, or `shift`+`z` | redo |

Both are bound on a window `keydown` listener in the donor `App.tsx`.

## 7. Test identities

Extracted to `tests/fixtures/rig-editor-main-testids.json`: **90 static IDs**
across 19 donor files, plus templated IDs in 6 files recorded separately
(`staticByFile`, `templatedByFile`, `allStatic`).

That fixture is the Phase T preservation gate. Every ID in `allStatic` survives
unless it belongs exclusively to the old Hierarchy or names Character canonical
behaviour that exact-subject behaviour replaces — and each such removal is
recorded with its replacement and reason.

Known Character-bound IDs, expected to be replaced rather than preserved:

| Donor ID | Owner | Disposition |
| --- | --- | --- |
| `hierarchy` | `panels/Hierarchy.tsx` | replaced by `animation-hierarchy` (Phase L redesign) |
| `character-select` | `panels/Hierarchy.tsx` | removed; the workspace has one exact subject, not a Character picker |
| `weapon-mode-select` | `panels/Hierarchy.tsx` | replaced by motion-context chips derived from the resolved Motion Set |
| `stale-character-draft-banner` | `App.tsx` | replaced by the subject-native conflict surface (Phase R) |
| `library-character-select` | `asset-library/AssetLibrary.tsx` | removed with the Character projection |

Everything else in `allStatic` is a preservation target.

### Identities changed by exact Component selection

The Prefab Editor's Component list was keyed by `componentType`, which cannot
name one of two Animators on a node. It is keyed by `componentId` now, and
`?component=` reads an id (falling back to a type match only for URLs written
before the change).

| Old ID | New ID | Reason |
| --- | --- | --- |
| `prefab-component-model-renderer` | `prefab-component-model` | keyed by Component id; the type is available as `data-component-type` |
| `prefab-component-animator` | `prefab-component-animator` | unchanged — every current Prefab's Animator has `componentId` `animator` |

These are composition-page identities rather than donor animation-workspace
identities, so neither appears in `allStatic`; they are recorded here because
the same preservation rule applies to any test-ID this restoration moves.

New identities, one per Animator, for the way into the workspace:
`prefab-open-animation-workspace-<componentId>`.

## 8. Data-source surface to rewire

The preserved panels reach global Character-bound state through `store.ts`:

- 94 `useChamber(...)` selector calls across the panel and viewport files
- 5 `useWeaponProject()` calls
- 2 `useCharacterPresentation()` calls
- 1 `useCharacterBindings()` call

The four vertical-slice panels read a small, well-defined document surface:

| Panel | Document fields read |
| --- | --- |
| Inspector | `graph.states`, `graph.transitions`, `clips`, `rootMotion.mode` |
| Graph | `graph.layers`, `graph.states`, `graph.transitions` |
| Timeline | `graph.states`, `graph.transitions`, `haptics.bindings` |
| Timing | `graph.states` |

That surface is what `AnimationChamberDocument` has to satisfy for the first
slice, and it contains no Character identity — which is why the slice is
possible without reconstructing a Character.
