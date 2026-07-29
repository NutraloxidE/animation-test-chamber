# Skill: terrain-interaction-tuner

## Purpose

Diagnose and fix grounding problems: slopes, steps, stairs, ledges, moving
platforms and surface friction.

## Inputs

- The terrain preset that reproduces the problem
- The relevant replay
- Current metrics: foot sliding, floating ticks, penetration, grounded flicker,
  pelvis jerk, root-motion error

## Outputs

- A diagnosis naming which parameter is responsible
- Adjustments to the terrain interaction profile
- Before/after metrics on the same replay

## May change

`/terrain/*` (probe distance and radius, snap strength, downhill adhesion,
step-up height, slope limits, slope speed compensation, foot IK strength and
smoothing, pelvis offset, ledge detect distance, obstacle pushback, platform
inheritance) and the root motion authorities.

## Must not

- Raise `footIkStrength` to 1 to hide a foot-sliding problem that is actually a
  clip timing or root-motion issue.
- Change `groundProbeDistance` far enough that the character grounds through
  geometry — check `maxPenetration` after every change.
- Treat metrics as the verdict. They are advisory; the human's eye decides.

## Common diagnoses

| Symptom | Usual cause |
| --- | --- |
| Foot sliding while running | root motion authority vs code-driven speed mismatch |
| Grounded flicker on a slope | probe distance too short, or snap strength too low |
| Bouncing downhill | `downhillAdhesion` too low |
| Popping on stairs | `footTargetSmoothing` too low |
| Walking through a step | `stepUpHeight` below the step height |
| Slope misread as stairs | the flatness threshold in `resolveTerrain` |

## Verify

```bash
npx vitest run tests/unit/terrain.test.ts
npx vitest run tests/replay
```
