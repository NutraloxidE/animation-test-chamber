# Animation Asset Reuse System — completion report

Branch: `claude/new-session-9h6hb7`
Base: `30f3972` (merge of #11, "equipment branching, three weapon modes and timing controls")
Head at this report: `adda607...` and later (see git log — this file is
updated alongside the branch, not pinned to one commit)

This report originally described the initial asset-split pass on
`claude/new-session-7d9k61` and was `PARTIAL`. It is rewritten here to
track the branch this work actually landed and shipped on
(`claude/new-session-9h6hb7`, PR #12), through the foundation-hardening
pass and the critical-integrity finalization that followed it. The
detailed hardening narrative — the transaction state machine, the original
fault-injection matrix, the visual-suite conversion to a fixed-tick driver
— lives in `reports/animation-asset-foundation-hardening-report.md`; the
critical-integrity fixes on top of it (point-of-no-return safety,
ownership-safe rollback, atomic/corruption-safe journals, tuning-patch
refusal, and their own fault-injection matrix) are in
`reports/pr12-critical-integrity-finalization.md`. This file is the short,
current summary all three periods land in.

## Declaration

```text
Animation Asset Reuse System: PASS

Schema:                 PASS
Migration:              PASS
Shared Behavior:        PASS
Motion Slot Resolution: PASS
Asset Library:          PASS
Variant / Fork:         PASS
Replay Compatibility:   PASS
Protection:             PASS
Atomic Transaction:     PASS — hardened further; see critical-integrity report
Static Build:           PASS
Visual 320px:           PASS
One-shot Harness:       PASS — two consecutive clean runs, 26/26 stages each
```

`PASS` is not written where it is not earned. The transaction line notably
means more here than it originally did: not just "commits or refuses
cleanly," but "commits, refuses, *or fails partway through and recovers* —
including the final journal write itself failing after every file is
already promoted, a rollback discovering it cannot prove ownership of a
file, and a torn journal on disk at startup — without ever reporting a
change that happened as if it hadn't, and without ever crashing recovery."
See `reports/pr12-critical-integrity-finalization.md` for the fault
injection matrix that backs that claim.

## What changed since the original asset split

- **Generic, crash-safe repository transactions**
  (`packages/repository-transaction`) replaced the earlier
  `.chamber-asset-transactions/` staging approach the original version of
  this report referred to. It is domain-agnostic (never imports animation
  types): prepare → validate → backup → promote-by-rename → verify, with a
  durable, atomically-written journal (`journal.json.next` + rename, not an
  in-place overwrite) so a process that dies mid-promotion is resolved by
  the same rollback logic the next process runs at startup. This now
  covers not only a failure *before* files are promoted, but a failure at
  any point up to and including the final commit record, a rollback
  discovering it cannot prove ownership of a file it would otherwise
  delete, and a corrupt or ambiguous journal at startup — none of which the
  original transaction only failing before assets moved was designed to
  survive.
- **True variant inheritance**, strict published-reference hashing, staged
  patches that name their own destination, static character drafts, and a
  deterministic fixed-tick visual test driver — see
  `reports/animation-asset-foundation-hardening-report.md`.
- **Tuning-profile saves refuse structural patches explicitly** (409, no
  partial success) rather than silently dropping them — see
  `reports/pr12-critical-integrity-finalization.md`.

## Test totals (current head)

| | Count |
| --- | --- |
| Unit | 252/252 |
| Integration | 87/87 |
| Replay | 91/91 |
| Shadow comparison | 9/9 replays identical |
| Repo guard | 8/8 |
| Animation asset checks | 7/7 |
| Visual (one-shot run 1) | 114/114 |
| Visual (one-shot run 2) | 114/114 |
| One-shot harness | 26/26 stages, two consecutive clean runs |

No test was deleted, skipped or weakened at any point across the three
periods this report now covers.

## Known limitations

1. **Two visual tests are flaky under this container's load**
   (`chamber.spec.ts:232` mobile-landscape, `animation-assets.spec.ts:37`
   narrow): failed in one standalone `pnpm harness:visual` run, passed in
   both one-shot runs recorded above. Neither touches
   `packages/repository-transaction`, `packages/animation-asset-runtime`,
   or the transaction/save code this report's Atomic Transaction line
   covers. See `reports/pr12-critical-integrity-finalization.md` for detail.
2. **The Motion Set Editor's clip picker is read-mostly**; a rebinding
   routes through Publish rather than happening inline.
3. **Retargeting is not implemented**, as originally scoped. A
   `conversion-required` rig pair is never played silently — the UI shows
   the reason.
4. **`Simulation.rootLocked()` still uses the global recovery default**
   when a clip authors none, rather than the state's `recoveryPolicy`
   — unchanged from the original hardening pass; routing it through the
   policy would be a real behaviour change, not a refactor.
