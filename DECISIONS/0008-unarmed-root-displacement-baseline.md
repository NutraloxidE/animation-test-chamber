# 0008 — Unarmed attack root displacement is 0.5, and replay expectations must track it

Status: accepted

## Context

At the start of the Animation Asset Foundation Hardening effort, three replay
tests were already failing on the baseline branch:

- `attack-01-to-attack-02 > uses only authored movement for the sword attack`
- `attack-01-to-attack-02 > scales the measured trajectory with the forward
  displacement adjustment`
- `regression detection > rejects a combo press made before the action input
  window opens`

Investigating the first two: `assets/animation/clips/unarmed-attack-01/1.0.0.json`
carries `rootDisplacement.z: 0.5` with `"provenance": { "source": "human-adjustment" }`
— a deliberate hand tuning of the migrated clip, made after the tests were
written. The tests still assumed the pre-tuning value (effectively `0`).

`sampleRootTrack()` (`packages/replay-runtime/src/simulation.ts`) treats
`clip.rootDisplacement` as an *adjustment added to a captured track's own
total displacement*, not a replacement for it:

```text
adjusted(value, sourceTotal, adjustment) = value * (sourceTotal + adjustment) / sourceTotal
```

For the two failing displacement tests, the captured test track
(`swordARootTrack`) totals `z = 0.824524`, and the final position is scaled
again by `rootMotion.horizontalAuthority` (`0.35`). With the canonical `0.5`
displacement:

```text
(0.824524 + 0.5) * 0.35 ≈ 0.4636   // instead of the pre-tuning ≈ 0.2886
```

and the "adjusted vs baseline" delta test compares two *different* overrides
of the same field, so it must scale off the canonical value (`0.5`), not zero:

```text
(0.2 - 0.5) * 0.35 = -0.105   // instead of the pre-tuning 0.2 * 0.35 = 0.07
```

The third failure was a separate, unrelated timing assumption: the fixture's
second attack press lands at ~0.77 normalized through `unarmed-attack-01`
(a fact of the fixture's fixed tick numbers and the clip's `durationSec`, not
of the `0.5` displacement tuning). The test edited
`inputAcceptanceStartNormalized` to `0.75` intending to close the combo
window before that press — but `0.75 < 0.77`, so the window was already open
by the time the press landed, and the edit exercised nothing.

## Decision

Runtime behaviour is not changed. The `0.5` root displacement is a real,
intentional human tuning of the shipped clip — reverting it to make old
tests pass would be discarding shipped Feel to satisfy a stale assertion,
which is exactly what this hardening pass must not do.

Instead:

- The two displacement tests now compute their expected values from
  `project.clips` at the current canonical `rootDisplacement.z` (`0.5`)
  instead of a hardcoded literal derived from the pre-tuning value.
- The combo-rejection test now closes the window at `0.8` (comfortably above
  the fixture's ~0.77 press time) instead of `0.75`, so it actually exercises
  the rejection path it claims to test.

## Consequences

- Future changes to `unarmed-attack-01.rootDisplacement.z` should not require
  editing these tests again, since the displacement assertions derive their
  expectation from the live asset rather than a second hardcoded copy of it.
- If the *feel* of the unarmed attack's forward displacement is deliberately
  changed again, that is a separate tuning task, not part of this hardening
  pass, and it is expected to touch the asset only — these tests will track
  it automatically.
- Fixture-timing assumptions (like the ~0.77 press time) are a property of
  the replay fixture's fixed tick numbers and the clip's `durationSec`, and
  do not move when the displacement is tuned; the two kinds of drift are
  independent and were fixed for independent reasons.
