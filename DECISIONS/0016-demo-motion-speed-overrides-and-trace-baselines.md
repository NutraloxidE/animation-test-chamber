# 0016 — The demo speed overrides are authored behaviour, and the trace oracle advances with them

## Status

Accepted.

## Context

Commit `2e5b2a2` added two canonical animation overrides to the demo character:

```text
/graph/states/walk/speed = 1.53
/graph/states/run/speed  = 1.21
```

`harness:replay` and `harness:animation-assets` went red at that commit and
stayed red, because both compare against a captured oracle in
`tests/fixtures/animation-assets/legacy-replay-traces.json` that was recorded
before those overrides existed.

A red oracle has exactly two honest resolutions, and choosing between them is
not a code question. Either the motion change was unintended, and the overrides
should go; or it was authored, and the oracle is now describing a character that
no longer exists. Regenerating the oracle *without deciding* would destroy the
only evidence that the runtime still behaves as it did — which is the entire
reason the fixture is captured rather than derived.

## Decision

The overrides are **authored behaviour**. The commit added them deliberately to
canonical project data under the message "demo overrides"; they are not
generated drift. The oracle is advanced to match.

Regeneration was licensed only after causality was proven in all four
directions (`reports/trace-baseline-resolution.md`):

```text
A  d4be2df, old oracle                          green
B  2e5b2a2, old oracle                          6 of 9 replays differ
C  2e5b2a2 minus only the two overrides         green again
D  d4be2df plus only the two overrides          byte-identical to B
```

C and D are the halves that matter. C shows nothing else in `2e5b2a2` moved the
traces; D shows the overrides alone reproduce them exactly.

The oracle is never hand-edited. `pnpm traces:generate` rebuilds every entry
from the same functions the test compares against, and `pnpm traces:check`
fails when the committed fixture and canonical behaviour disagree.

## Consequences

What changed is bounded and explained: 6 of 9 replays travel further, gaining
foot contacts in proportion. What did **not** change is the part that would have
meant something else was wrong — replay length, locomotion sequence, action
sequence, and non-foot event identity and order are identical in all 9 replays,
and the 3 replays with no locomotion distance are untouched byte for byte.

The fixture keeps the name "legacy": it is still a historical oracle, and its
provenance is still "the runtime as it stood before the asset split". What it
now additionally records is one deliberate, documented advance of the authored
tuning. A future unexplained difference is still a failure, and still must not
be regenerated away.
