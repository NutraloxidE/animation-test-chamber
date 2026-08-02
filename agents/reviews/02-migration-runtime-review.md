# 02 — Migration and runtime review (Gate C)

Reviewer: main agent (Opus 5) in the architecture-and-audit role.
Scope: `migration.ts`, `motion-resolver.ts`, the `graph.ts` rewrite, and the
`simulation.ts` policy substitutions.

## The oracle

The pre-migration runtime is the authority on what correct means. Its traces
were captured by checking out `30f3972` into a git worktree and running the
**old code** against all nine replay fixtures — not by reasoning about
equivalence, and not by re-deriving expected values from the new code.

`harness/shadow-compare.ts` compares a SHA-256 over the entire tick array. Every
field the plan §35 lists — locomotion state, action state, normalized time,
blend weight, semantic events, root motion, position — is inside that hash. The
sequences and metrics stored alongside it exist so a failure is readable; they
are not the check.

Result: **9/9 replays byte-identical.**

## Each translation, verified individually

`tests/unit/animation-assets/migration.test.ts` asserts each rule separately, so
a shadow failure says which one broke rather than only that something did:

- `attack-*` → `completionPolicy.mode = 'hold-final-frame'`; looping states →
  `'loop'`; everything else → `'immediate-fallback'`. For a looping clip the
  post-advance completion check is always false, so `'loop'` and
  `'immediate-fallback'` are behaviourally identical there — the distinction is
  descriptive, and the migration picks the honest one.
- `*-recovery` → `recoveryPolicy.authorityReturnAtNormalized = 0`; every other
  action state → `0.78`, the old `DEFAULT_DODGE_RECOVERY_START_NORMALIZED`.
  Precedence is preserved exactly: an authored clip value still wins.
- `attack-*` → `locksMovementUntilRecovery`. Note this is true for
  `attack-01-recovery` too, because `startsWith('attack-')` was true for it —
  reproducing the old rule, including the part that reads like an accident.
- `dodge` and `*-recovery` → `returnsAuthorityOnRecovery`.
- `walk`/`run` → `providesLocomotionAuthority` and `locomotionSpeedReference`.

## What was deliberately not changed

`Simulation.rootLocked()` still falls back to
`DEFAULT_DODGE_RECOVERY_START_NORMALIZED` when a clip authors no recovery point,
rather than consulting the state's `recoveryPolicy`. Routing it through the
policy would have changed behaviour for `*-recovery` states (0 instead of 0.78)
— a real behaviour change smuggled in under a refactor. It is not a name-based
branch, so it was left exactly as it was.

## Motion resolution

`AnimationGraphRuntime` no longer receives a clip array. It receives a
`MotionResolver` and asks it per state, per tick. The resolver holds every
context's bindings and selects one from the tick's `AnimationContext`.

Layer iteration now comes from `graph.layers` rather than a hard-coded
`['locomotion', 'action']`. The old loop would have silently dropped every
transition on a third layer a behaviour variant added.

## Gate C: PASS

Legacy and new traces are identical; state-name dependence is gone from the
runtime and guarded against; motion slots resolve to clips; and one character's
bindings and overrides provably do not reach another
(`derivation-and-resolution.test.ts`, "keeps one character's overrides out of
another's document").
