# Trace baseline resolution

Continuation start SHA: `d126b93db3a98664d2c3bba13b33a4a3f7c7642c`
Work package: `WP_ROUTE_SCOPED_EDITOR_FINALIZATION_AND_HARDENING.md` §5

Resolves the two harness failures that had been red since `2e5b2a2` and that
blocked Phase 11 for the whole of the preceding work package.

## The question

`harness:replay` and `harness:animation-assets` compare generated traces against
a captured oracle, `tests/fixtures/animation-assets/legacy-replay-traces.json`.
Both went red at `2e5b2a2`, which added two canonical overrides:

```text
demo-humanoid.animation.instanceOverrides
  /graph/states/walk/speed = 1.53
  /graph/states/run/speed  = 1.21
```

Regenerating an oracle to make a failure disappear destroys the only evidence
that the runtime still behaves as it did. So the oracle was not touched until
causality was proven exactly.

## Method

Four isolated `git worktree` checkouts, each with its own
`pnpm install --frozen-lockfile`. A shared `node_modules` was tried first and
rejected: pnpm's symlink farm resolves third-party deps per package directory,
so the worktrees could not have run their own code honestly.

The same generator (`harness/generate-legacy-traces.ts --stdout`) was used in
each checkout, so the comparison is between outputs of one function over
different canonical data — never between two differently-written scripts.

## Results

| State | Configuration | `shared-behavior.test.ts` |
| --- | --- | --- |
| A | `d4be2df` canonical data + committed oracle | **26/26 pass** |
| B | `2e5b2a2` canonical data + committed oracle | **1 fail / 25 pass** |
| C | `2e5b2a2` with *only* the two overrides removed | **26/26 pass** |
| D | `d4be2df` with *only* the two overrides added | **1 fail / 25 pass** |

C and D are the halves that carry the argument. C shows nothing else in
`2e5b2a2` moved the traces. D shows the overrides alone reproduce them.

Then, decisively:

```text
diff <(B: 2e5b2a2 generated traces) <(D: d4be2df + only the 2 overrides)
  → byte-identical (18,385 bytes)
```

## What changed, and why every field is explained

| Replay | final z | foot contacts | hash moved |
| --- | --- | --- | --- |
| `run-to-attack-forward` | 8.231 → 8.921 | 7 → 8 | yes |
| `attack-01-to-attack-02` | 0.000 → 0.000 | 0 → 0 | no |
| `late-dodge-cancel` | 3.500 → 3.500 | 0 → 0 | no |
| `jump-buffer-before-landing` | 14.205 → 14.978 | 8 → 9 | yes |
| `dodge-jump-queued` | 15.866 → 16.694 | 9 → 10 | yes |
| `downhill-root-motion` | 19.755 → 21.326 | 13 → 15 | yes |
| `stair-foot-ik` | 22.765 → 24.625 | 14 → 17 | yes |
| `moving-platform-jump` | 8.000 → 8.000 | 0 → 0 | no |
| `ice-surface-stop` | 6.929 → 7.433 | 5 → 6 | yes |
Both overrides are greater than 1, so more distance per tick — and therefore
more foot contacts in the same number of ticks — is the expected direction. The
three replays with no locomotion distance are unchanged byte for byte.

## What did not change

These are the invariants §5.2 requires, and all of them hold across all 9
replays:

```text
tickCount (replay length)          unchanged in 9/9
locomotionSequence                 unchanged in 9/9
actionSequence                     unchanged in 9/9
non-foot event identity and order  identical in 9/9
```

No `JumpTakeoff`, `Landing`, `DodgeStart` or attack event changed identity,
count or ordering. Controller sampling, equipment state, seeds and transition
sequencing are unchanged: any movement in those would have shown up as an
action-sequence or non-foot-event difference, and none did.

## Regeneration

```text
generator      harness/generate-legacy-traces.ts   (new)
command        pnpm traces:generate
check command  pnpm traces:check
idempotent     second run reports "already matches canonical behaviour"
fixture sha256 4fcbbc728d5fc35f6343ec26e2e5037de625ec1e3c443991e1d5bef439924839
```

No expected value was edited by hand. The regenerated fixture is byte-identical
to the output proven causal in states B and D.

## Verification after regeneration

```text
pnpm harness:replay              5 files, 129/129 tests pass
pnpm harness:animation-assets    7/7 checks pass
```

Both had been failing continuously since `2e5b2a2`.

## Limitations

- The proof covers the replay oracle only. It does not claim the two overrides
  are good tuning values; that is an authoring judgement, and this report takes
  the commit that introduced them at its word.
- The fixture keeps the name "legacy". It remains a historical oracle whose
  provenance is the pre-asset-split runtime; what it now additionally records is
  one deliberate, documented advance. A future unexplained difference is still a
  failure and must not be regenerated away.
