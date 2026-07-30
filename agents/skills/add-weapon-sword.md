# Skill: add-weapon:sword

## Purpose

Add a sword-family weapon so it is actually held in the hand, by reusing the
transform the existing placeholder sword already uses.

## Inputs

- The new weapon's mesh/component and its id
- The character presets it must be held by

## Outputs

- The weapon rendered inside the right-hand bone, gripped at the handle
- A grip entry per character preset it supports

## The existing placeholder is the reference

`apps/web/src/three/characters/HeldSword.tsx` is the shape contract. Its local
origin sits **at the grip**, not at the model centre: the handle spans y ≈
-0.07..0.11, the guard is at y = 0.12, the blade runs up +Y to y ≈ 0.94, and the
blade faces ±Z (thickness 0.025). Build the new weapon the same way — origin in
the palm, blade up +Y, flat of the blade in the XY plane — and every existing
grip value keeps working. If a new mesh is authored around its own centre, offset
it inside its own component; do not compensate in the grip.

## Where it attaches

- `GltfCharacter.tsx` portals the weapon into `character.rightHandBone` and
  applies `grip.position` / `grip.rotation`. That is the only mounting path for
  rigged characters.
- `ProceduralCharacter.tsx` nests it under the right arm mesh at
  `position={[0, -0.28, 0]} rotation={[0, 0, Math.PI]}` — the arm capsule points
  down, hence the flip. Keep that group as-is and swap only the child.

## Steps

1. Add the component next to `HeldSword.tsx`, origin at the grip (see above).
2. Extend `heldItem` in `WeaponMode` (`apps/web/src/three/catalog.ts`) with the
   new id and add the `WEAPON_MODES` entry.
3. Render it in both `GltfCharacter.tsx` and `ProceduralCharacter.tsx` where
   `HeldSword` is used today — a weapon that only appears on one character path
   is a bug, not a scope cut.
4. Add a `weaponGrips[<weaponId>]` entry to every character preset that supports
   it (`quaterniusKnight.ts`, `quaterniusUniversalBase.ts`, …). Start from that
   preset's `sword` grip; a same-family weapon usually needs no change.
   Without this entry `gripSupported` is false in `App.tsx` and the grip editor
   is unavailable.
5. Tune in-app with the grip editor (`gripEditorMode`), then copy the saved
   values back into the preset. The stored override in `store.ts` is a tuning
   buffer, not the source of truth.

## Must not

- Bake a grip offset into the weapon component so it "looks right" on one
  character. Per-character correction belongs in `weaponGrips`.
- Attach to the hand mesh or the model root instead of the hand bone — it will
  not follow the animation.
- Ship an override left only in the store; commit the tuned numbers to the preset.

## Verify

```bash
npx playwright test tests/visual/chamber.spec.ts
```

Then hold the weapon through idle, run, attack-01/02 and dodge, and confirm the
hand does not pass through the grip on any of them.
