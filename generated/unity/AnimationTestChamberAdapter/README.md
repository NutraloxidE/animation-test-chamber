# Animation Test Chamber — Unity Adapter (generated)

This folder is **generated output**. Regenerate with `pnpm unity:export`.
Do not hand-edit it and do not treat it as a source of truth: the browser side
holds the canonical data, and there is no import-back path in the MVP.

## Install

Copy `AnimationTestChamberAdapter/` into your Unity project's `Assets/`
folder, and the JSON bundle next to it (or into `StreamingAssets/`).

Then use **Tools > Animation Test Chamber > Import Chamber Project**.

## What works

- Deserializing the canonical bundle into typed DTOs (`ChamberDtos.cs`)
- A runtime state machine with the same transition ordering, cancel windows,
  exit times and input buffering semantics as the web runtime
- Adapter interfaces for input, haptics and terrain

## LIMITATIONS

These are real, and listed so nobody discovers them the hard way:

1. **No Animator Controller is generated.** The state machine here is driven
   from JSON at runtime. Generating a `.controller` asset is out of scope.
2. **No clip binding.** `AnimationClipDefinition.assetPath` is carried through,
   but wiring clips to a Playable graph or Animator is left to the project.
3. **Terrain is not reimplemented.** `IChamberTerrain` is an interface with a
   flat-ground default. The web runtime's height-field sampling is not ported,
   so terrain states will differ until you implement it against your colliders.
4. **Foot IK is not ported.** Use Unity's own IK; the tuned parameters come
   across as data.
5. **Haptics are a no-op by default.** `IChamberHaptics` has an empty
   implementation; wire it to your platform's gamepad API.
6. **Float precision differs.** Do not expect the web replay traces to match
   bit-for-bit; use them as behavioural references, not golden values.
