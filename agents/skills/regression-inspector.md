# Skill: regression-inspector

## Purpose

Decide whether a behaviour difference is an intended change or a regression —
and refuse to decide alone when protected behaviour moved.

## Inputs

- Two replay traces produced from the same replay, terrain and seed
- The diff that separates them
- Which values carry protection

## Outputs

- A classification per difference: intended / regression / needs human
- Metrics and a visual comparison for each

## Rules

- A new result is never automatically the new truth.
- A changed **state sequence** (either layer) usually means a transition now
  fires at a different time — treat as a likely regression until shown otherwise.
- If protected behaviour changed, stop and require a human accept/reject.
- Do not rely on golden screenshots alone. Compare state sequences, positions,
  velocities, events and foot metrics — they say *what* changed.

## Must not

- Widen a tolerance to make a comparison pass.
- Re-record an expectation because it is easier than explaining the difference.

## Verify

```bash
npx vitest run tests/replay
```
