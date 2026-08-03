# 08 — PR #14 critical fix audit (Gate A), and gate reviews B–D

**Performed by:** the main agent (`claude-opus-5`). **No subagent ran** — see
the orchestration note at the end. The gate reviews below are self-reviews and
should be read as "the implementing agent looked for these specific failures",
not as an independent audit.

**Base:** `4521873b4943935f73480b995e40f05c3e477040`, branch
`claude/multi-instance-world-harness`, worktree clean.

## The three defects, confirmed

All three are real. None is theoretical.

**A — the resolution cache shared a whole `ResolvedProject`.** The key was built
from animation asset references; the *value* was the output of
`resolveCharacterAnimation`, which spreads the project and adds a
`ResolvedCharacter`. Two characters sharing one animation set therefore shared
one `modelAssetPath`, one capsule radius, one capsule height, one display name
and one id. Invisible in the shipped fixture, where both instances are the same
character — which is precisely why it needed a fixture that is not.

Worse, PR #14 contained a test asserting `controlled.resolved === scripted.resolved`.
That assertion did not miss the bug; it *encoded* it.

**B — the HTTP command surface advertised a sequence it could not perform.** The
route built a `WorldRuntime` per request. `world.preview` advanced one and
discarded it; `world.read_observations` built another at tick zero and read
that. The in-process integration test passed because one `CommandContext` held
one runtime for the whole test. Over HTTP the advertised
`preview → read_observations` flow returned a tick-zero world with a 200 on it.

**C — world replay dropped camera yaw.** `WorldReplayRecorder` hard-coded
`cameraYawRad: 0` and `createReplayRuntime` bound no control source. Since
movement is camera-relative, a run recorded while the camera turned replays as a
different path with byte-identical input frames — the exact shape of failure
deterministic replay exists to rule out.

## Decisions taken at this gate

1. **Bundle boundary.** `ResolvedAnimationBundle` holds graph, clips, motion
   bindings, contextual bindings, context keys, clip asset sources, resolution
   provenance, skeleton and rig compatibility key. It lives in
   `@atc/animation-asset-runtime` — derived runtime data, not canonical schema.
   `resolveCharacterAnimation` stays the public wrapper so no existing caller
   learns about bundles.
2. **Key inputs.** Four asset references (tuning's absence distinguished from
   its presence), character animation `instanceOverrides`, and preview
   overrides. Not: id, display name, model path, capsules, protection. Patch
   values are serialized with sorted keys at every depth.
3. **`world.preview` is replaced, not aliased.** The name invites exactly the
   reading that was wrong, and PR #14 is unmerged, so there is no caller to keep
   working. Retaining a deprecated alias would have preserved the misleading
   sequence in the discovery listing.
4. **`world.read_observations` stays registered, refused over HTTP.** The
   browser and the in-process tests genuinely observe a runtime they own; an
   HTTP request does not have one. The route returns 400 with a structured issue
   naming `world.simulate`. Option 2 of §4.4.
5. **Simulate output.** tick, worldHash, instanceOrder, full `WorldObservation`,
   optional flat observations, optional trace. Runs capped at 10,000 ticks;
   `includeTrace` capped at 600, because an unbounded per-tick trace is a
   response body a caller can request by accident.
6. **Replay control: Option 1**, a `WorldControlSource` sampled inside
   `WorldRuntime.step()`. Smaller than a wrapper runtime and does not duplicate
   the tick loop, which Option 2 would have risked.
7. **Version policy.** `WORLD_REPLAY_VERSION` → 2. v1 is read *explicitly* as
   constant zero yaw — which is what it meant — and every other version is
   refused with a named error. Nothing is silently interpreted.
8. **The incorrect test is replaced, not deleted.** The new name states the
   corrected invariant: *shares immutable animation bundle members without
   sharing resolved project wrappers*. The report says so in as many words.

**Gate A: PASS**, no unresolved blocker.

---

## Gate B — resolution boundary review

Rejects sought: a key based on character id; continued whole-`ResolvedProject`
sharing; cloning every graph and losing the sharing; stale preview resolution;
tests comparing values instead of identity.

| Check | Finding |
| --- | --- |
| Key based on character id | No. `animationResolutionKey` takes a character and reads only `animation`. Rename-invariance is asserted in a unit test and in `harness:world`. |
| Whole-project sharing | Gone. `resolveWorld`'s cache value type is `ResolvedAnimationBundle`; `harness:world` asserts by identity that two wrappers differ and one bundle is shared. |
| Over-cloning | No. Graph, clips, bindings, clip sources and skeleton are asserted `toBe` (identity) across instances. |
| Stale preview | No. Preview overrides participate in the key, and a test asserts two resolutions with different previews produce different graph objects. |
| Value comparisons masquerading as identity | The new tests use `toBe`/`not.toBe` throughout for the sharing claims. |

**Gate B: PASS.**

---

## Gate C — stateless API review

Rejects sought: hidden process-local session maps; preview responses without
final observation; cross-request state claims; direct repository writes;
duplicated simulation in the API; unbounded traces; a read-only exemption for
mutating commands.

| Check | Finding |
| --- | --- |
| Session map | None. The route attaches no `runtime`; `simulateWorld` builds and discards one per call. |
| Final observation in the response | Yes, asserted over the real Hono app, including that the scripted instance is not at its tick-zero state. |
| Cross-request claims | The `world.simulate` description says "stateless" and "same response"; a test asserts both words. `world.read_observations` is refused over HTTP. |
| Repository writes | A test reads `project.json` before and after a staged simulation and asserts byte equality, and that no transaction directory exists. |
| Duplicated implementation | One `simulateWorld`, called by the command, and the command is called by the route. The route contains no simulation code. |
| Unbounded trace | Capped at 600 ticks with a structured refusal above it; a test asserts the default omits the trace entirely. |
| Read-only exemption scope | Still keyed on `command.mutating`. A test asserts `world.duplicate_instance` is 503 in read-only mode while `world.simulate` is 200. |

**Gate C: PASS.**

---

## Gate D — replay fidelity review

Rejects sought: hardcoded yaw zero; yaw applied after the tick; wall-clock
controls; caller-managed camera replay; unversioned semantic change; legacy
baseline regeneration; tolerance where byte-identity is expected.

| Check | Finding |
| --- | --- |
| Hardcoded zero | Gone. The recorder reads `runtime.cameraYawRad` before each step. |
| Ordering | `step()` samples controls before instance intent and before any simulation step. Asserted both at the sampler (29 vs 30) and end to end through the runtime. |
| Wall clock | None. Control keyframes are tick-keyed. |
| Caller-managed replay | No. `createReplayRuntime` binds the control source itself; the C1/C2 tests set no camera yaw during playback. |
| Versioning | `WORLD_REPLAY_VERSION` 2, v1 explicitly interpreted, everything else refused. |
| Legacy baselines | Untouched. The legacy projection suite still asserts byte-identity on all four fixtures. |
| Tolerances | The camera tests compare `JSON.stringify` of tick records. No tolerance anywhere. |

**Not covered, stated rather than hidden:** the browser sets camera yaw once per
*frame*, so at 30Hz two ticks share a yaw where at 60Hz they would not. That is
a property of sampling a continuous input at frame rate — the same as device
input — and not something the replay contract can fix. The cadence test supplies
yaw per tick, which is the right comparison for "identical per-tick inputs
produce identical results" and does not claim the browser's frame-sampled camera
is cadence-independent.

**Gate D: PASS, with that note.**

---

## Orchestration

The work package specifies five subagents across three model tiers. **None ran**,
for the same reason recorded in the previous pass: the tiered models it names are
not addressable as separate agents in this environment. No handoff was
fabricated; the main agent performed every task; orchestration is recorded as
**not followed**, and `Agent Orchestration Evidence` stays FAIL in the report.
