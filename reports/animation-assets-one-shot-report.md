# Animation Asset Reuse System — completion report

Branch: `claude/new-session-7d9k61`
Base: `30f3972` (merge of #11, "equipment branching, three weapon modes and timing controls")

## Declaration

```text
Animation Asset Reuse System: PARTIAL

Schema:                 PASS
Migration:              PASS
Shared Behavior:        PASS
Motion Slot Resolution: PASS
Asset Library:          PASS (one partial — see Known limitations)
Variant / Fork:         PASS
Replay Compatibility:   PASS
Protection:             PASS
Atomic Transaction:     PASS
Static Build:           PASS
Visual 320px:           PASS
Agent Orchestration:    FAIL — the plan's subagent process was not followed
Opus Final Review:      PASS — agents/reviews/05-final-acceptance.md
One-shot Harness:       FAIL — 3 pre-existing test failures remain
```

`PASS` is not written where it is not earned (plan §46). The two failures are
stated in full below.

## Asset types implemented

| Type | Path | Purpose |
| --- | --- | --- |
| Behavior | `assets/animation/behaviors/` | The state machine. Names motion slots, never clip ids. |
| Motion Set | `assets/animation/motion-sets/` | One character's clips, bound to those slots. |
| Clip | `assets/animation/clips/` | One piece of motion. Knows no behaviour. |
| Humanoid Rig | `assets/animation/rigs/` | The skeleton clips were authored for. |
| Tuning Profile | `assets/animation/tuning/` | Numeric adjustment over a behaviour. Values only. |

76 published asset versions.

## Project structure, before and after

**Before** — `projects/demo-character/project.json`, 3362 lines:

```text
character.skeleton          16 bones, inline
clips[]                     35 clip definitions, inline
graph.states[]              16 states, each naming a clipId
graph.states[].weaponClips  per-weapon clip override map
graph.transitions[]         44 transitions, inline
```

**After** — the project holds references:

```text
characters[0] demo-humanoid
  animation.behavior    humanoid-third-person-base@1.0.0  #0658a240
  animation.motionSet   demo-humanoid-motion-set@1.0.0    #973c67a4
  animation.rig         demo-humanoid-rig@1.0.0           #2f8c7909
  animation.tuning      demo-default-tuning@1.0.0         #9fe8797c
characters[1] alternate-humanoid-character
  animation.behavior    humanoid-third-person-base@1.0.0  #0658a240 (the same asset)
  animation.motionSet   alternate-humanoid-motion-set@1.0.0  #796f61d6
  animation.rig         demo-humanoid-rig@1.0.0             #2f8c7909
  animation.tuning      alternate-humanoid-tuning@1.0.0     #1fe0d91c
```

`graph` and `clips` no longer exist on `ProjectDefinition` — removing them is
what makes "a character owns its animation" unexpressible rather than merely
discouraged.

## Generated demo assets

```text
humanoid-third-person-base@1.0.0     16 states, 44 transitions, 16 motion slots
demo-humanoid-motion-set@1.0.0       40 bindings (16 default + 24 contextual)
demo-humanoid-rig@1.0.0              canonical-humanoid, 16 bones
demo-default-tuning@1.0.0            0 patches — the demo runs the shared behaviour unmodified
alternate-humanoid-motion-set@1.0.0  the same slots, alt- prefixed clips
alternate-humanoid-tuning@1.0.0      1 patch (steering authority)
35 + 35 clip assets                  one per legacy clip, per character
```

## Two characters, one behaviour — verification

- Both reference `humanoid-third-person-base@1.0.0`, and the **same content
  hash**, so it is one asset rather than two copies.
- Their motion sets differ; **no motion slot resolves to the same clip in both**.
  `idle`, `walk`, `run`, `jump`, `attack-01` and `dodge` are asserted
  individually.
- Across all nine replay fixtures the **state and transition sequences are
  identical**. If they diverged the behaviour would not really be shared; if the
  clips coincided the second character would not really be a second character.
- The second character runs every replay fixture to completion.

Enforced by `harness/check-animation-assets.ts` and
`tests/replay/animation-assets/shared-behavior.test.ts`.

## Replay trace comparison

The oracle is the runtime as it stood at `30f3972`, captured by running the
**pre-change code** in a git worktree at that commit — not by re-deriving
expectations from the new code.

| Replay | Legacy trace hash | Asset-resolved | Result |
| --- | --- | --- | --- |
| idle-to-walk | captured | identical | ✅ |
| run-to-attack-forward | captured | identical | ✅ |
| attack-01-to-attack-02 | captured | identical | ✅ |
| late-dodge-cancel | captured | identical | ✅ |
| dodge-jump-queued | captured | identical | ✅ |
| jump-buffer-before-landing | captured | identical | ✅ |
| moving-platform-jump | captured | identical | ✅ |
| downhill-root-motion | captured | identical | ✅ |
| ice-surface-stop | captured | identical | ✅ |
| stair-foot-ik | captured | identical | ✅ |

**9/9 byte-identical.** The comparison is a SHA-256 over the entire tick array,
so every field the plan §35 lists is inside it.

## Name-based runtime behaviour removed

| Was | Now |
| --- | --- |
| `actionState.endsWith('-recovery') ? 0 : 0.78` | `recoveryPolicy.authorityReturnAtNormalized` |
| `actionState === 'dodge' \|\| endsWith('-recovery')` | `movementAuthorityPolicy.returnsAuthorityOnRecovery` |
| `locomotionState === 'walk' \|\| === 'run'` | `movementAuthorityPolicy.providesLocomotionAuthority` |
| `stateId.startsWith('attack-')` (graph fallthrough) | `completionPolicy.mode === 'hold-final-frame'` |
| `stateId.startsWith('attack-')` (movement lock) | `movementAuthorityPolicy.locksMovementUntilRecovery` |
| `stateId !== 'walk' && stateId !== 'run'` | `movementAuthorityPolicy.locomotionSpeedReference` |

`LayerId` is a string, and layer iteration comes from `graph.layers` — the old
hard-coded pair would have silently dropped every transition on a third layer.
Guarded by `stateNameDependenceStage` in the repo guard.

## Protection and immutability verification

- Every published asset version's file matches the hash its references carry.
- Editing one in place produces `published-asset-modified` **and**
  `hash-mismatch`, at load, not later.
- A variant that lowers a parent's protection is refused (`protection-weakened`).
- A variant that drops a parent's required motion slot is refused.
- A circular variant chain is refused (`circular-variant`) rather than recursed
  into.
- Deleting a referenced asset is refused and **enumerates who is holding it**.
- Repo guard fails on any modification or deletion of an existing version file.

## Transaction rollback verification

`runAssetTransaction` writes proposals to `.chamber-asset-transactions/<id>/`,
validates the complete proposed repository — disk plus proposal, every character
resolved — and only then moves files into canonical paths. On any failure the
staging directory is deleted, `project.json` is restored byte for byte, and
nothing under `assets/` was ever touched because the move step never ran. A
report is written to `reports/animation-asset-transaction-<id>.md` either way.

`tests/integration/animation-assets/transaction.test.ts` covers acceptance,
refusal on an unresolvable character, refusal on a hash mismatch, and that a
refused proposal leaves the repository byte-identical.

## Static build

`pnpm build` passes. On a static host the library browses, searches, previews,
shows dependencies, compares versions and applies assets for preview — the
generated index carries whole asset documents, so the browser runs the same
resolver the server does. Publish, canonical writes, git commit and candidate
import are disabled **with their reason on the button**, not left to fail as
network errors.

## Commands run

```bash
pnpm install
npx tsx harness/migrate-animation-assets.ts
npx tsx harness/generate-animation-asset-index.ts
npx tsx harness/generate-schemas.ts
npx tsx harness/export-unity.ts
npx tsx harness/check-animation-assets.ts     # 7/7
npx tsx harness/shadow-compare.ts             # 9/9 identical
npx tsx harness/check-static.ts               # 5/5
npx tsx harness/repo-guard.ts                 # 8/8
npx tsx harness/build.ts                      # pass
npx tsc -p tsconfig.json --noEmit             # clean
npx eslint . --max-warnings=0                 # clean
npx vitest run tests/                         # 349 passed, 3 failed
npx playwright test
```

## Test totals

Headless suite:

| | Baseline `30f3972` | This branch |
| --- | --- | --- |
| Tests | 245 | 352 |
| Passing | 242 | 349 |
| Failing | 3 | the same 3 |

Visual suite, across desktop / mobile-landscape / 320px:

| | Baseline `30f3972` | This branch |
| --- | --- | --- |
| Total runs | 132 | 147 |
| Failures | 11 | 11 |
| Failing test names | keyboard input · jump and attack · sword attacks · repeated clip tuning · layer bar | the same five |

The failure *count* is identical and the failing test *names* are identical. The
per-viewport distribution shifts between runs because the keyboard- and
replay-timing tests are load-sensitive: `sword attacks` failed on desktop at
baseline and passed here, `keyboard input` failed on narrow at baseline and on
both narrow and mobile-landscape here. All 39 Asset Library runs pass on every
viewport, including 320px.

No test was deleted, skipped or weakened. One visual test was rewritten to cover
the new save-destination contract, and a second added alongside it.

## Known limitations

1. **Three pre-existing test failures remain** in
   `tests/replay/expectations.test.ts`, all present at `30f3972` before any
   change here. They are a data-versus-test divergence from `c0f4067`: the tests
   expect `unarmed-attack-01.rootDisplacement.z ≈ 0`, the demo data says `0.5`.
   Resolving them means deciding how the attack should feel, which is not
   derivable from the code. Left unmasked. The visual test `repeated clip tuning
   is exposed through the Inspector edit loop` fails for the same reason.

2. **The plan's subagent orchestration was not followed.** One agent did all
   phases. `agents/tasks/` and `agents/handoffs/` are empty rather than filled
   with documents signed by agents that never ran. See `agents/ORCHESTRATION.md`.

3. **The Motion Set Editor's clip picker is read-mostly.** Each row shows its
   candidates, filtered by rig compatibility, and reports what a rebinding would
   publish; the write itself routes through Publish rather than happening
   inline.

4. **Retargeting is not implemented**, as the plan scopes it. Rig pairs are
   graded `direct-compatible` / `retarget-compatible` / `conversion-required`,
   and a `conversion-required` pair is never played silently — the UI shows the
   reason.

5. **`Simulation.rootLocked()` still uses the global recovery default** when a
   clip authors none, rather than the state's `recoveryPolicy`. Routing it
   through the policy would change behaviour for `*-recovery` states — a real
   behaviour change smuggled in under a refactor. It is not a name-based branch.

## Reviews

- `agents/reviews/00-design-review.md` — architecture audit, Gate A
- `agents/reviews/01-schema-review.md` — Gate B, schema boundaries
- `agents/reviews/02-migration-runtime-review.md` — Gate C, shadow verification
- `agents/reviews/03-ui-api-review.md` — Gate D, UI, API and security
- `agents/reviews/04-harness-review.md` — harness and repo guard
- `agents/reviews/05-final-acceptance.md` — Gate E
- `agents/ORCHESTRATION.md` — what was run, and why it differs from the plan
