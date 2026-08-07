# 0015 — ControllableCharacter is the only normal control boundary

## Status

Accepted.

## Context

A character is tuned once — transition rules, input windows, root-motion policy,
equipment context, the animation graph. Anything that reaches past that tuning
is not controlling the character; it is puppeteering a clip.

The temptation is concrete. `playAnimation("dodge")` is one line and works
immediately. It also skips every rule the tuning consists of, so the character
behaves one way for a human and another way for whatever called it.

## Decision

Every controller produces **normalized intent**, and intent is the existing
`ActionSample`:

```text
keyboard / gamepad ─┐
AI channel ─────────┤
scripted track ─────┼→ CharacterIntentSource → ControllableCharacter
replay ─────────────┤                              ↓
network injection ──┘                   state machine / movement
                                                   ↓
                                          animation graph / pose
```

- `CharacterIntent = ActionSample`. A second intent shape would need a
  conversion at every boundary, and the first thing to rot would be the two
  definitions of what "Move" means.
- The host polls each device once per frame and injects the sample. A character
  never reaches for the keyboard itself, which would make "which character did
  that keypress reach?" a question about enumeration order.
- Human and AI share **one** injected implementation, so there is one path to
  test. They differ only in the identity an observation reports.
- `playAnimation` / `forceState` / `setClip` remain available as explicitly
  labelled preview tools. They are never a controller.

## Consequences

Enforced two ways. `tests/unit/character-control/controllable-character.test.ts`
asserts that identical normalized frames produce **byte-identical** tick records
through an injected human source, an AI channel and an equivalent authored
track. And a repo-guard stage fails any direct `Simulation.step` outside the
runtime packages that legitimately own one — the browser engine was exactly that
violation, and it was the one controller a human actually uses.
