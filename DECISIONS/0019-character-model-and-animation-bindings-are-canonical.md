# 0019 — A Character's model and its animation takes are canonical data

## Status

Accepted.

## Context

`/edit/rig/:characterId` resolved a Character correctly. Everything below that
boundary did not.

The repository declared two `CharacterDefinition`s, both with
`modelAssetPath: null`. The five *visible* characters lived somewhere else
entirely — `apps/web/src/three/catalog.ts`, as `CHARACTER_PRESETS`, carrying the
model file, its scale and rotation, the right-hand bone, the weapon grips and a
`stateId -> GLTF clip name` map. So the app had two selectors:

```text
route Character selector      -> Project.characters[]        (canonical)
Hierarchy "character" select  -> CHARACTER_PRESETS[]         (web-only)
```

The Viewport read the second one. `setActiveCharacter` rebuilt the canonical
animation document and left `characterPresetId` alone, which produced the
reported symptom exactly:

```text
navigate from Character A to Character B
  header changes
  canonical animation document changes
  the model on screen does not
```

Playback had the same split. The canonical Behavior decided which *state* was
active; `CLIP_FOR_STATE`, `CharacterPreset.clipMap` and `WeaponMode.clipMap`
decided which *animation* you saw. Two animation graphs, free to drift, with
nothing able to notice — and one already had: the sword weapon mode named
`Rig|Sword_Idle`, a take that does not exist in the file that mode loads.
`animations.find(...)` returned `undefined`, no error was raised, and the
previous clip stayed on screen.

Sharing visibility was the third gap. Five Characters sharing one Behavior is
correct and intended; discovering it *after* a save is not. The Asset Library
could answer "who uses this asset" if you went looking, and the Rig Editor —
where the editing happens — could not.

## Decision

### The route selects the Character; nothing else may

`activeCharacterId` remains a navigation preference consulted only to answer
where `/` should go. There is no second control that changes which Character is
shown. Switching Character is navigation, in the Rig Editor header, the Character
Overview and the Asset Library's select alike.

### Model choice is Character identity

`CharacterDefinition.model` replaces the nullable `modelAssetPath`:

```ts
type CharacterModelBinding =
  | { kind: 'procedural-humanoid'; presetId: string }
  | {
      kind: 'repository-model';
      assetPath: string;
      scale: number;
      rotationYRad: number;
      rightHandBone?: string;
      weaponGrips?: Record<string, { position: Vec3Tuple; rotation: Vec3Tuple }>;
    };
```

`modelAssetPath: null` meant "some procedural character, ask the renderer",
which named no particular appearance. The binding names one. Model scale,
rotation, hand bone and grip defaults move with it: a grip somebody positioned
by hand is now reviewable repository data rather than a field on a preview
record.

Migration is one declared adapter — `migrateCharacterModelBinding` in
`packages/schema/src/migration.ts`, applied at the single document-load
boundary. Not a `character.model ?? presetFor(character.id)` fallback at each
render site: scattered, that becomes a second answer to "which model is this",
and the first site to answer differently does so invisibly.

### The five appearances become five authored Characters

`/characters` lists five, and each has one route. The two existing ids are kept
(work package §5.4 Option A):

| Character ID | Display name | Model binding |
| --- | --- | --- |
| `demo-humanoid` | Navigator | `procedural-humanoid:navigator` |
| `alternate-humanoid-character` | Relay | `procedural-humanoid:relay` |
| `sentinel` | Sentinel | `procedural-humanoid:sentinel` |
| `quaternius-knight` | Quaternius Knight | `repository-model:…/KnightCharacter.glb` |
| `quaternius-universal-base` | Universal Base Superhero | `repository-model:…/Superhero_Female_FullBody.gltf` |

Renaming the two would have rewritten every replay fixture, world fixture,
generated Unity export and integration test that names them, for no gain in
canonical correctness. No aliases: five ids, five Characters, and no two ids
reach one Character.

### Sharing is deliberate, and stated

```text
Behavior  humanoid-third-person-base   SHARED BY 5
Rig       demo-humanoid-rig            SHARED BY 3   Navigator · Relay · Sentinel
Rig       quaternius-knight-rig        ONLY Knight
Rig       quaternius-universal-rig     ONLY Universal Base
MotionSet demo-humanoid-motion-set     SHARED BY 2   Navigator · Sentinel
MotionSet alternate-humanoid-motion-set ONLY Relay
MotionSet quaternius-knight-motion-set ONLY Knight
MotionSet quaternius-universal-motion-set ONLY Universal Base
Tuning    demo-default-tuning          SHARED BY 4   Navigator · Sentinel · Knight · Universal Base
Tuning    alternate-humanoid-tuning    ONLY Relay
Model     (all five)                   ONLY THIS CHARACTER
```

Sentinel shares Navigator's rig, Behavior, Motion Set and Tuning and differs
only in appearance. No differences were manufactured to make five Characters
look independent; the imported models get their own rig and Motion Set because
their skeletons genuinely differ.

### One inventory computes ownership

`describeCharacterBindings(project, registry)` is the only implementation of
"who holds this reference". The Character Overview's badges, the save dialog's
blast radius, the audit report and the tests all read it.

The failure this prevents is not a wrong number in a panel — it is two panels
disagreeing. A badge saying ONLY THIS CHARACTER beside a save that reaches four
others is worse than no badge, and that is what two independent holder scans
eventually produce. Holders are compared by type, id *and version*: two
Characters on different versions of one asset do not share it, because
publishing over one version reaches only its holders.

Tuning ownership in particular is computed. "Tuning is per-Character" was true
of the old two-Character repository and is false of this one.

### Imported takes are canonical clip assets

`AnimationClipDefinition.externalSource` names the take:

```ts
interface ExternalAnimationSource {
  assetPath: string;      // the file
  animationName: string;  // the take inside it, verbatim
  positionScale?: number; // UE-exported libraries author centimetres
}
```

A file path alone was not enough to play anything — a GLTF holds many named
animations — which is what made a renderer-side map necessary in the first
place. Visible playback now resolves:

```text
state -> state.motionSlot -> motion set binding -> clip asset -> file + take
```

`resolveRigEditorCharacterPresentation` owns that resolution and hands
`GltfCharacter` a `stateId -> {file, take}` map. The renderer chooses neither a
model nor a clip; that independence is what let the two graphs drift.

Clip *timing* is authored, not imported. Duration, root displacement, semantic
events and foot contacts are inherited from the demo Character's clip for the
same slot rather than measured off the take, because the engine ticks on
canonical durations — importing the takes' real durations would silently retune
every transition and move the replay fixtures. The takes supply appearance; the
repository still owns feel.

Weapon modes keep only presentation: a label, whether a sword is held, and
whether the mode's attacks drive root motion. Which clips a mode plays is a
`contextualKey` on each Character's motion set, so a Character whose motion set
binds nothing for a mode keeps its own takes instead of half-playing another
rig's animation.

### Rig identity is explicit for imported models

`quaternius-knight-rig` and `quaternius-universal-rig` are authored rig profiles
whose skeletons are read out of the model files rather than restated by hand.
The Knight previously had no `rigId` at all, so nothing could say whether the
universal libraries would play on it; they will not — different
`compatibilityKey`, and the Character Overview says so.

### A preview override may exist, but never as an identity

`previewModelOverrideId` replaces `characterPresetId`. It defaults to `null`, may
name only a procedural appearance, is cleared on every Character switch, is not
persisted, and is never staged or applied. It is labelled "Preview Model
Override / PREVIEW ONLY / Not saved to the Character", and never "Character" —
the old control's label is precisely why five appearances were mistaken for five
Characters.

## Consequences

- `harness/repo-guard.ts` fails a commit that reintroduces `CHARACTER_PRESETS`,
  `characterPresetId`, `setCharacterPreset`, `CLIP_FOR_STATE` or a `clipMap`, and
  equally fails one that deletes the Character Overview's ownership badges or the
  PREVIEW ONLY label. Both halves matter: every negative rule above is also
  satisfied by removing the feature.
- Each rendered Character clones its skinned scene, its materials and the clips
  it plays. `useGLTF` caches per URL, and the previous code scaled position
  tracks in place on cached clips and drove a mixer built on the cached scene —
  so two Characters sharing a file shared a skeleton, a mixer and a set of
  progressively re-scaled tracks.
- 69 clip assets, two rig profiles and two motion sets are generated by
  `pnpm assets:animation:imported`, the second declared migration adapter. It
  refuses to write when a take name is absent from the file it names, which is
  the check the retired maps could not fail.
- `AnimationTestChamberAdapter`'s asset manifest exports the model binding and
  each clip's `externalSource` instead of a flattened nullable path.
- The Character Overview occupies a persistent row above the chamber. It is
  context for every edit made below it, not a report to consult afterwards.
