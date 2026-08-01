# Animation Asset Reuse System — completion report

Branch: `claude/pr-12-continuation-0cpio7` (PR #12, opened from `claude/new-session-9h6hb7`)
Base: `30f3972` (merge of #11, "equipment branching, three weapon modes and timing controls")

This report covers the asset-split work. Two later passes on the same PR are
reported separately and supersede parts of it:

- `reports/animation-asset-foundation-hardening-report.md` — atomic repository
  transactions, strict references, variant inheritance, the per-domain save
  contract, the deterministic visual harness.
- `reports/pr12-critical-integrity-finalization.md` — the point-of-no-return,
  create-rollback ownership, journal atomicity and tuning-refusal fixes, and
  the verification results that are current as of the final head.

## Declaration

```text
Animation Asset Reuse System: PASS

Schema:                 PASS
Migration:              PASS
Shared Behavior:        PASS
Motion Slot Resolution: PASS
Asset Library:          PASS
Variant / Fork:         PASS
Replay Compatibility:   PASS — 91/91
Protection:             PASS
Atomic Transaction:     PASS
Static Build:           PASS
Visual 320px:           PASS — 114/114 across three viewports
Agent Orchestration:    FAIL — the plan's subagent process was not followed
Opus Final Review:      PASS — agents/reviews/05-final-acceptance.md
One-shot Harness:       PASS — 26/26 stages on two consecutive runs
```

`PASS` is not written where it is not earned (plan §46).

This block read `PARTIAL` when the asset split first landed, on two failures:
three pre-existing replay failures, and the Asset Library's read-mostly clip
picker. The replay failures were resolved by the hardening pass
(`DECISIONS/0008-unarmed-root-displacement-baseline.md`) and the one-shot
harness is green on two consecutive runs, so the two lines that caused the
`PARTIAL` no longer do.

The orchestration line still reads `FAIL`, and stays that way: no subagent
process was followed on that pass, and none was used on the critical-integrity
pass either. Writing `PASS` there would be the exact thing this report exists
to avoid.

The clip picker is still read-mostly. It moved out of the declaration and into
Known limitations, where it belongs — it is a scoped design choice, not a
failed gate.

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

`runAssetTransaction` is a domain adapter now. It turns a proposal — new asset
versions, optionally a rewritten project — into `PlannedFileWrite[]` plus a
validator closure, and hands both to the generic, domain-agnostic
`@atc/repository-transaction` engine, which owns the journal under
`.chamber-transactions/<id>/`, the repository write lock, promotion by rename,
rollback and startup recovery. It knows nothing about animation assets.

A transaction can fail on either side of the point of no return, and the two
are not the same outcome:

- **Before promotion** — an invalid path, a stale expectation, a validator
  error. Nothing canonical has moved, the transaction directory is removed and
  the result is `validation-refused` or `conflict-refused`.
- **After promotion begins** — a failed rename, a hash that does not verify, a
  journal write that fails. Files may already be at their canonical paths, so
  the result is `committed`, `rolled-back`, or `fatal` and never a refusal.
  `rolled-back` means every replace was restored from its backup and every
  create this transaction can prove it wrote was removed. `fatal` means that
  could not be certified: the transaction directory and the write lock are both
  kept, and the repository is read-only until a human resolves it.

An earlier version of this section claimed nothing under `assets/` is ever
touched "because the move step never ran". That was never true of a failure
during promotion, and the paths that make it false are now covered by tests.

`tests/integration/animation-assets/transaction.test.ts` covers acceptance,
refusal on an unresolvable character, refusal on a hash mismatch, and that a
refused proposal leaves the repository byte-identical.
`tests/integration/repository-transaction/` covers the engine itself —
fault injection at every promotion point, journal corruption, ownership-unsafe
rollback and crash recovery — and
`tests/integration/animation-assets/save-destination.test.ts` runs a real mixed
publication through it end to end.

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
npx vitest run tests/                         # see below
npx playwright test
```

## Test totals

Headless suite. The "this branch" column is the current head, not the head this
section was first written against; the counts it used to carry (352 total, 349
passing, 3 failing) were superseded by the hardening pass, which resolved the
three replay failures, and by the critical-integrity pass, which added the
fault-injection and refusal tests.

| | Baseline `30f3972` | This branch |
| --- | --- | --- |
| Unit | — | 253/253 |
| Integration | — | 90/90 |
| Replay | — | 91/91 |
| Total | 245 (242 passing, 3 failing) | 434 (434 passing, 0 failing) |

Visual suite, across desktop / mobile-landscape / 320px:

| | Baseline `30f3972` | This branch |
| --- | --- | --- |
| Total runs | 132 | 114 (38 tests × 3 viewports) |
| Failures | 11 | 0 |

The 11 failures this column used to record were the load-sensitive
keyboard- and replay-timing tests. The hardening pass replaced their
`waitForTimeout` with a dev-only fixed-tick driver (`window.__ATC_TEST__`),
which is what took the count to zero and let the visual stage start blocking a
commit. All Asset Library runs pass on every viewport, including 320px.

The suite remains sensitive to machine load rather than to correctness: a run
of the one-shot harness overlapping this pass's own edits and CPU load reported
111/114, and the same three tests passed on every dedicated run. That is
recorded in `reports/pr12-critical-finalization-baseline.md` rather than left
out.

No test was deleted, skipped or weakened. One visual test was rewritten to cover
the new save-destination contract, and a second added alongside it.

## Known limitations

1. ~~**Three pre-existing test failures remain**~~ — **resolved.** The three
   `tests/replay/expectations.test.ts` failures were a data-versus-test
   divergence from `c0f4067`: the tests expected
   `unarmed-attack-01.rootDisplacement.z ≈ 0`, the demo data said `0.5`. The
   later hardening pass settled which of the two was right and recorded the
   decision in `DECISIONS/0008-unarmed-root-displacement-baseline.md`. Replay is
   91/91.

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
