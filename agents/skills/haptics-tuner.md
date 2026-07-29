# Skill: haptics-tuner

## Purpose

Bind haptic responses to semantic events and make them feel right across every
capability tier.

## Inputs

- The semantic event to respond to
- The current capability profile of the test device
- The haptic profile

## Outputs

- Adjusted bindings, with the tier each one will actually play at
- A statement of what happens on a device one and two tiers lower

## May change

`/haptics/masterIntensity` and any binding's duration, start delay, low/high
frequency magnitude, curve, trigger magnitudes, adaptive trigger preset,
resistance and break point.

## Must not

- Write haptics into an animation clip. They attach to semantic events so that
  hitbox, audio, VFX and haptics stay in sync from one anchor.
- Solve a weak-feeling effect by raising magnitude to 1. Shape it: delay, curve
  and duration matter more than amplitude.
- Delete or bypass a fallback so an effect "works properly" on the dev machine.
- Claim a capability from a controller's product name. Probe for the actuator.

## Fallback chain

`advanced → trigger rumble → generic rumble → no-op`

Trigger energy folds into the main rumble when triggers are unavailable, so the
beat survives degradation. Nothing ever blocks playback.

## Verify

```bash
npx vitest run tests/unit/haptics.test.ts
```

Then test on a real controller and on a device with none.
