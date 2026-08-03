# PR #14 critical fixes — baseline

The state of the branch as reviewed, recorded so the "after" numbers mean
something and so the three defects are on the record rather than only in a
review comment.

## Identity

| | |
| --- | --- |
| Reviewed head | `4521873b4943935f73480b995e40f05c3e477040` |
| Branch | `claude/multi-instance-world-harness` |
| Worktree at start | clean |

## Counts before

| Suite | Files | Tests |
| --- | --- | --- |
| vitest | 29 | 519 |
| playwright (3 viewports) | 3 | 141 |
| one-shot stages | — | 29 |
| repo-guard checks | — | 9 |

(519 rather than the 509 reported at PR time: the resolution-isolation suite
landed with the Issue A fix and is counted in the "after" column below; 519 is
the count immediately before Issue B work began. The pre-fix figure is 509.)

## The three defects, as found

**A — the resolution cache shared a whole `ResolvedProject`.** The key was built
from animation asset references; the value was the output of
`resolveCharacterAnimation`, which carries a `ResolvedCharacter` — id, display
name, `modelAssetPath`, capsule radius, capsule height. Two characters sharing
one animation set therefore shared one body.

Invisible in the shipped fixture, because both of its instances are the same
character. That is what made it worth a dedicated fixture with two deliberately
different bodies.

**A′ — a test encoded the bug.** PR #14 asserted
`controlled.resolved === scripted.resolved`. That is not a test that missed the
defect; it is a test that required it.

**B — the HTTP command surface advertised a sequence it could not perform.** The
route built a `WorldRuntime` per request. `world.preview` advanced one and threw
it away; `world.read_observations` built a second at tick zero and read that. The
in-process integration test passed because a single `CommandContext` held one
runtime for the whole test, which is exactly the condition HTTP does not provide.

**C — world replay dropped camera yaw.** `WorldReplayRecorder` wrote
`cameraYawRad: 0` unconditionally and `createReplayRuntime` bound no control
source. Movement is camera-relative, so a run recorded while the camera turned
replayed along a different path with byte-identical input frames.

## What was already true and had to stay true

Optional `ProjectDefinition.world`; legacy synthesis without rewriting;
independent `Simulation` per instance; declaration-order ticking; one device
poll routed by binding; unchanged legacy `ReplayDefinition` and trace semantics;
instance-qualified observation paths; staged-only mutating commands; protection
and read-only enforcement; harness-enforced capability completeness; no test
deleted, skipped or weakened; no legacy baseline regenerated.

All of those are re-asserted by the suites that were already green and are still
green.
