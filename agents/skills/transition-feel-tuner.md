# Skill: transition-feel-tuner

## Purpose

Turn a short, feel-based Japanese request about switching speed ("もっさりして
いる", "素早く切り替わってほしい", "再生途中で割り込みたい") into the smallest
correct change to canonical transition data — and leave that value tunable from
the UI afterwards.

This skill is the implementation-side counterpart of `state-machine-tuner.md`.
That one produces A/B/C proposals; this one applies one change end to end.

## Inputs

- The request, usually one or two sentences, naming states by feel not by id
  ("dodge → jump", "アクション同士")
- `projects/demo-character/project.json` — the canonical document
- `packages/animation-runtime/src/graph.ts` — the rules that decide whether a
  transition may fire at all

## Where to edit

- Canonical data is `projects/demo-character/project.json`. Edit it directly.
- `harness/seed-demo-project.ts` has drifted from it (it lacks transitions the
  project has, e.g. `dodge-to-none-on-jump`). Do **not** re-run or "sync" the
  seed to apply a tuning change; it would delete data.
- Never edit anything under `generated/`.
- Bulk edits: a small `node -e` script over the parsed JSON, then
  `npx prettier --write projects/demo-character/project.json` to restore the
  file's formatting. Do **not** run prettier on `.ts`/`.tsx` — this repo has no
  prettier config and the defaults rewrite every quote in the file.
- Schema trap: condition objects must **not** carry `schemaVersion`. Adding it
  fails `validateProject` with "must NOT have additional properties".

## Diagnosis order

Answer "why is it slow?" in this order and stop at the first real cause.

1. **Is there a transition at all?** If two states are only connected via
   "clip ends → `fallbackState` → start the next one", the wait is a whole clip,
   not a blend. Add the direct transition. This is the usual cause of もっさり.
2. **Does the window open too late?** `cancelWindow.start` on the source state
   decides when the input is allowed to take effect. Mid-playback interruption
   ("再生途中で") always means this field.
3. **Is the blend too long?** Only then touch `blendDurationSec`.
4. **Never** raise `playbackSpeed` to make something feel faster. It destroys
   the weight of the motion, which is the thing being tuned.

A state with `interruptible: false` (attack-01, attack-02, dodge) can only be
left by a transition that declares `cancelWindow` or `exitTimeNormalized` — see
`DECISIONS/0004`. A new transition out of one of those states without a window
is dead data.

## Value ranges that match this project's feel

| Pair | blendDurationSec |
|---|---|
| action → action (combo, cancel) | 0.05 – 0.08 |
| action ↔ locomotion | 0.06 – 0.12 |
| locomotion → locomotion | 0.12 – 0.24 |

`DODGE_RECOVERY_BLEND_SEC` (0.28) is deliberately slow and stays slow: it is the
roll handing root authority back, not a switch.

## Must not

- Change a `locked` or `approval-required` field. `run-to-attack-01` is
  human-tuned and its `momentumRetention` is locked; leave that transition alone
  when shortening blends around it.
- Let an input escape hitstun. `hit → dodge` makes damage free; do not add it
  without being asked.
- Hardcode a duration in the renderer. `GltfCharacter.tsx` crossfades for
  exactly `engine.graphLayers[layer].blendDurationSec`, so the authored value is
  what plays. A literal there silently overrides every value the user tunes.
- Loosen a test to make a data change pass. If a test asserts on demo values
  (e.g. the AI harmonization test), fix the test's own fixture value so it stops
  depending on the tuned number.

## Finish condition

- Every value touched is reachable from the Transition Inspector, including the
  `All blend durations` list, so the next round is a slider drag and not a code
  edit.
- One assertion in `tests/unit/state-machine.test.ts` that fails if the new link
  or window disappears.
- Report which files in the working tree were **not** yours; this repo is often
  edited in parallel.

## Verify

```bash
npx vitest run tests/unit tests/replay tests/integration
```

```bash
npx tsc -p tsconfig.json --noEmit && npx eslint . --max-warnings=0
```

The browser pane cannot confirm feel: when it is not displayed the page is
hidden, `requestAnimationFrame` never runs and the simulation stays at tick 0.
Verify the data and the tests, then say plainly that the feel itself needs the
user's own eyes.
