# Handoff — Rig Character Binding, Model Ownership and Animation Sharing Visibility

Work package: `WP_RIG_CHARACTER_BINDING_AND_ANIMATION_SHARING_VISIBILITY.md`
(authored 2026-08-05).
Branch: `claude/new-session-xgr1z6`.

```text
Start SHA:               dd9b0213aeeaeff64cef8d031f401a89635d1d5d
Reviewed impl. SHA:      689fe5c45507a7ab9dd6806b3b53da1571cdb6fe
Base preserved:          yes — merge-base with origin/main is still 2e5b2a2
main merged or rebased:  no
removed-world-alt:       never fetched, merged or read
```

**Branch note.** The package names
`claude/edit-rig-scene-controllable-character`; this session's standing
instruction names `claude/new-session-xgr1z6`. At session start both branches
pointed at the same commit (`dd9b021`), so the designated branch already
contained the whole reviewed rig-branch history and the work went there. Nothing
about the baseline changed as a result.

Written to be picked up on another machine. Full evidence, including the final
matrix and the limitations, is in `reports/rig-character-binding-audit.md`. The
design rationale is `DECISIONS/0019-character-model-and-animation-bindings-are-canonical.md`.

---

## 1. What this package changed, in one chain

```text
/edit/rig/:characterId
        ↓  exact match, no fallback (unchanged from DECISION 0012)
CharacterDefinition
        ↓  model: CharacterModelBinding                    ← new, canonical
        ↓  animation.{behavior,motionSet,rig,tuning,instanceOverrides}
resolveRigEditorCharacterPresentation                      ← new, one resolver
        ↓  model binding + stateId → {file, take}
Viewport / GltfCharacter / ProceduralCharacter             ← choose nothing
        ↓
describeCharacterBindings                                  ← new, one inventory
        ↓  ownership + exact holders
Character Overview badges · save-destination blast radius · tests · audit
```

Two selectors became one: the route. Two animation graphs became one: the motion
set. Two holder scans became one: `describeCharacterBindings`.

## 2. The repository now declares five Characters

| ID | Display name | Model |
| --- | --- | --- |
| `demo-humanoid` | Navigator | `procedural-humanoid:navigator` |
| `alternate-humanoid-character` | Relay | `procedural-humanoid:relay` |
| `sentinel` | Sentinel | `procedural-humanoid:sentinel` |
| `quaternius-knight` | Quaternius Knight | `repository-model:…/KnightCharacter.glb` |
| `quaternius-universal-base` | Universal Base Superhero | `repository-model:…/Superhero_Female_FullBody.gltf` |

§5.4 **Option A** — the two existing ids are preserved and three are added. A
rename would have rewritten every replay fixture, world fixture, generated Unity
export and integration test naming them, for no canonical gain. Only the display
names changed (`Procedural Humanoid` → `Navigator`, `Alternate humanoid` →
`Relay`); if you grep for the old names you will find them only in the *legacy
v1* seed and migration inputs, where they belong.

Sharing, and it is deliberate: one Behavior across all five; the demo rig across
the three procedural Characters; one Motion Set across Navigator and Sentinel;
one Tuning profile across four. Full matrix with holder lists in the audit §2.

## 3. Where to look

```text
packages/schema/src/project.ts                     CharacterModelBinding
packages/schema/src/animation.ts                   ExternalAnimationSource
packages/schema/src/migration.ts                   the modelAssetPath adapter
packages/animation-asset-runtime/src/bindings.ts   describeCharacterBindings
apps/web/src/rig-editor/resolve-character-presentation.ts
apps/web/src/rig-editor/CharacterOverview.tsx
apps/web/src/three/catalog.ts                      appearances only, no Characters
apps/web/src/three/characters/GltfCharacter.tsx    canonical takes + isolation
harness/generate-imported-character-assets.ts      the imported-asset adapter
harness/repo-guard.ts                              characterSelectorBoundaryStage
```

## 4. Things a follow-up session will want to know

1. **`pnpm assets:animation:imported` is idempotent and must stay so.** It
   authors 73 files with fixed timestamps and sorted iteration. If you change a
   take mapping, re-run it, re-run `pnpm assets:animation:index`, and update the
   affected Character's `animation.motionSet.contentHash` in `project.json` — the
   reference carries the hash and is refused when it disagrees.
2. **Imported clip timing is inherited, not measured** (audit §8.1). Every
   imported clip's duration and events come from the demo Character's clip for
   the same slot, because the engine ticks on canonical durations and importing
   real take lengths would retune every transition and move the replay fixtures.
   That is the single largest deliberate limitation here, and the obvious next
   work package.
3. **One behavioural correction was made.** The sword weapon mode's retired clip
   map named `Rig|Sword_Idle` while loading a file that has no such take, so
   nothing played and nothing complained. The canonical sword context binds
   `Idle_No_Loop` / `Sword_Block` instead. Audit §3 records it.
4. **`WeaponMode.usesAttackRootMotion` is still renderer-side.** It is a feel flag
   rather than a clip reference — the displacement comes from the canonical
   clip's `rootMotionMode` — but it is arguably canonical data and moving it was
   out of scope.
5. **The Character Overview is collapsed below 900px.** It has to be: a
   persistent 40vh block above the chamber left the 320px and Pixel-5-landscape
   layouts too short, and the bottom sheet's handle ended up underneath the
   viewport's own controls (three chamber specs caught it). It now takes the same
   overlay shape as the Hierarchy and the panel sheet, and the summary names the
   Character at every width.
6. **The repo guard has a positive half.** Every negative rule in
   `characterSelectorBoundaryStage` — no `CHARACTER_PRESETS`, no
   `characterPresetId`, no `CLIP_FOR_STATE`, no `clipMap` — is also satisfied by
   deleting the feature, so the stage additionally requires the inventory, the
   ownership badges and the PREVIEW ONLY label to still be present.
7. **Do not weaken route identity.** `resolveRigEditorTarget` still has no
   fallback, and `previewModelOverrideId` may name only a procedural appearance
   precisely so a preview can never be mistaken for an authored model.

## 5. Commands

```bash
pnpm install --frozen-lockfile
pnpm schema:generate && git diff --exit-code -- schemas
pnpm typecheck && pnpm lint && pnpm build
pnpm harness:check
pnpm harness:animation-assets
pnpm harness:world && pnpm harness:scenes && pnpm harness:capabilities
pnpm harness:unit && pnpm harness:character-control
pnpm harness:integration && pnpm harness:replay
pnpm harness:repo-guard
pnpm harness:visual
pnpm harness:one-shot
```

Regenerating data:

```bash
pnpm assets:animation:imported   # the two imported Characters' rigs/clips/motion sets
pnpm assets:animation:index      # generated/animation-assets/library-index.json
pnpm unity:export                # generated/unity/**
```

## 6. Declaration

See the closing section of `reports/rig-character-binding-audit.md` for the
observed results and the final PASS/HOLD declaration. This document does not
restate them, so that there is exactly one place where the evidence lives.
