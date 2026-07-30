# Third-party assets

## LowPoly Animated Knight

- Creator: Quaternius
- Asset: `apps/web/public/assets/characters/quaternius-knight/KnightCharacter.glb`
- Source: https://opengameart.org/content/lowpoly-animated-knight
- Original download: https://opengameart.org/sites/default/files/Knight%20Character%20by%20%40Quaternius.zip
- License: CC0 1.0 Universal (public-domain dedication)
- License text: https://creativecommons.org/publicdomain/zero/1.0/

The repository includes a GLB conversion of the character FBX from the original archive.
Attribution is not required by CC0, but the source is recorded here for provenance.

## Universal Base Characters — Superhero Female

- Creator: Quaternius
- Assets: `apps/web/public/assets/characters/quaternius-universal-base/`
- Source: https://quaternius.com/packs/universalbasecharacters.html
- Download: https://quaternius.itch.io/universal-base-characters
- Original archive: `Universal Base Characters[Standard].zip`
- License: CC0 1.0 Universal (public-domain dedication)
- License text: https://creativecommons.org/publicdomain/zero/1.0/

The repository includes one glTF character and only the buffers and textures it references.
The original Standard archive is not redistributed.

## Universal Animation Library — Standard

- Creator: Quaternius
- Asset: `apps/web/public/assets/animations/quaternius-universal/AnimationLibrary_UE_Standard.glb`
- Source: https://quaternius.com/packs/universalanimationlibrary.html
- OpenGameArt mirror: https://opengameart.org/content/universal-animation-library
- Original archive: `Universal Animation Library[Standard].zip`
- License: CC0 1.0 Universal (public-domain dedication)
- License text: https://creativecommons.org/publicdomain/zero/1.0/

The bundled Standard library contains 45 humanoid clips. Its Unreal FBX was converted
to GLB because that export shares the Universal Base bone names exactly. The chamber
maps idle, walk, run, jump, fall, dodge, guard, and two attack states to a focused subset.

## Universal Animation Library 2 — Standard

- Creator: Quaternius, with sword animations by Quaternius and Gonzalo Furnier
- Asset: `apps/web/public/assets/animations/quaternius-universal-2/UAL2_Standard.glb`
- Source: https://quaternius.com/packs/universalanimationlibrary2.html
- Download: https://quaternius.itch.io/universal-animation-library-2
- Original archive: `Universal Animation Library 2[Standard].zip` (v2.1, updated 2026-07-05)
- Bundled upstream file: `Unreal-Godot/UAL2_Standard.glb` (root motion disabled)
- License: CC0 1.0 Universal (public-domain dedication)
- License text: https://creativecommons.org/publicdomain/zero/1.0/

The chamber uses the matching Universal rig's `Sword_Regular_A` and
`Sword_Regular_B` clips for sword mode. The archive's root-motion-disabled GLB is
used for rendering because chamber simulation owns world translation. The matching
`UAL2_Standard_RM.glb` was inspected (but is not bundled) to author the canonical
attack displacements: +0.8245245m for A and -0.0525849m for B.
