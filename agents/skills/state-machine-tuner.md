# Skill: state-machine-tuner

## Purpose

Turn a feel-based request ("the attack starts too slowly but I don't want to
lose the weight") into concrete transition parameters, as up to three comparable
proposals.

## Inputs

- The target transition's canonical path
- The natural-language request (any language)
- The project's `preferences` profile
- The replay to compare on

## Outputs

Up to three proposals — A responsive, B weighted, C preserve original — each with
changed fields, before/after, rationale, expected trade-offs, protected fields
respected, whether approval is required, and likely test impact.

## May change

`blendDurationSec`, `startOffsetNormalized`, `exitTimeNormalized`,
`playbackSpeed`, `inputBufferMs`, `cancelWindow`, `momentumRetention`,
`rotationAuthority`, `priority`, `interruptible`.

## Must not

- Raise `playbackSpeed` as the default answer to "make it faster". Speeding up
  the clip is what destroys the sense of weight. Reach for the input buffer,
  the blend duration and the start offset first.
- Propose a change to a `locked` or `invariant` field, even as a suggestion.
- Apply an `approval-required` change without explicit human approval.
- Desynchronise a semantic event from the hitbox window that references it.
- Return one proposal. The point is comparison.

## Verify

```bash
npx vitest run tests/unit/state-machine.test.ts
npx vitest run tests/replay
```

Then compare the variants on the same replay, terrain and seed in the chamber.
