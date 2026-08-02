# 07–10 — Gate reviews B, C, D, E

**These are self-reviews.** The work package assigns them to a separate
reviewer; no reviewer subagent ran (see
`agents/handoffs/multi-instance-world-harness.md`). They record real checks
against real code, and they are weaker evidence than an independent review.
Read them as "the implementing agent looked for these specific failures and says
what it found", not as an audit.

---

## Gate B — World contract review

The reviewer's brief was to reject: an accidental general ECS, mutable state
cached by a shared definition id, game-specific schema, runtime imports from
web/API, compatibility claims not proven by tests, unstable path semantics,
intent-source ambiguity, and over-generalization.

| Check | Finding |
| --- | --- |
| Accidental ECS | No. An instance owns a `Simulation`, not a component set. There is no system registry, no component store and no query API. |
| Mutable state keyed by a shared id | No. `resolutionKey` is built from asset references and caches only the immutable resolved document; mutable state lives in `RuntimeInstanceState`, keyed by instance id. Asserted by `world-contract.test.ts` ("shares one resolved document", "gives each instance its own mutable simulation") and by a repo-guard pattern. |
| Game-specific schema | No. `world.ts` declares no field named for the example use case. A repo-guard rule scans the canonical field names and fails on `enemy`, `player`, `attack`, `combat`, `soulslike`, `health`, `damage`, `hitbox`, `hurtbox`. |
| Runtime importing web/API | No. Repo-guard rejects `react`, `three`, `hono`, `node:fs`, DOM globals and `apps/*` imports in `packages/world-runtime` and `packages/capability-runtime`. |
| Compatibility claims proven | Yes. Legacy synthesis, no-rewrite-on-load, and single-instance replay projection each have a test; the projection is byte-identical on all four committed fixtures. |
| Path/index semantics | Ids only. Asserted in a unit test, in `harness:world`, and by a repo-guard pattern. |
| Intent-source ambiguity | Sampling rules are written down (hold semantics, tick-keyed) and tested at exact tick boundaries, including the button edge at 150/152. |
| Over-generalization | `RuntimeInstanceSource` has exactly one member. No speculative source kinds were added. |

**Objection raised and acted on during the gate:** the first draft of
`resolutionKey` used the character id. It was changed to asset references
before any instance code was written, and the test now asserts that renaming a
character does not change its key.

**Gate B: PASS.**

---

## Gate C — Determinism review

The brief was to reject: wall-clock input in simulation, nondeterministic
map/object order, shared mutable controller state, replay tied to DOM events,
baseline regeneration without comparison, and unversioned incompatible trace
changes.

| Check | Finding |
| --- | --- |
| Wall-clock in simulation | No. Tracks are tick-keyed; the browser's accumulator converts frame deltas to whole fixed steps and nothing downstream sees a delta. |
| Nondeterministic iteration | No. `WorldRuntime.step` iterates `this.order`; `hashWorldTrace` walks `instanceOrder`. Neither reads a `Map` or `Object.keys`. |
| Shared controller state | No. One `IntentSource` per instance; `injectLocalIntent` routes by declared player index, and instances never poll. |
| Replay tied to DOM | No. `WorldReplay` stores normalized `ActionSample` frames. The Node replay tests run with no browser. |
| Baselines regenerated | No baseline was regenerated. The legacy fixtures are byte-identical through the new path. |
| Unversioned trace change | No. `WORLD_TRACE_VERSION` and `WORLD_REPLAY_VERSION` are new containers; the legacy shapes are untouched. |

**Not covered, stated rather than hidden:** the work package asks for a
30/60/120 render-cadence test on the *world* trace. The existing
`tests/replay/determinism.test.ts` proves cadence independence for the
`FixedStepAccumulator` and the `Simulation`, and the world engine reuses both
without modifying either — but there is no test that drives `WorldChamberEngine`
at three cadences. That is a gap, and it is listed in the report's limitations
rather than claimed as covered.

**Gate C: PASS, with the cadence gap recorded.**

---

## Gate D — Authoring boundary review

The brief was to reject UI-driven domain decisions and duplicated runtime logic
in React.

| Check | Finding |
| --- | --- |
| UI state reaching the runtime | No. `selectedInstanceId` is read only by the panel and the selection ring. A visual test advances 60 ticks, changes selection, and asserts the tick and every instance position are unchanged. |
| Domain logic in React | No. Every world edit goes through `runWorldCommand`, which calls the same registry the API calls. The store never constructs a `WorldDefinition` except for focus/camera-target, which are two-field assignments on a validated document. |
| Duplicated rendering logic | No. `ProceduralCharacter` gained an optional pose closure instead of gaining a sibling. |
| Labels/ranges duplicated | No. They come from the authoring surface declaration. |

**Scope note, not a pass:** `setFocusedInstance` and `setCameraTargetInstance`
assign directly rather than going through a command, because no command exists
for them. They validate the target is enabled, and the world validator catches
the invalid case at publication. A `world.set_focus` command would be more
consistent and is not in this branch.

**Gate D: PASS, with the scope note.**

---

## Gate E — AI operability review

The brief was to reject: an "edit arbitrary JSON" command, hidden filesystem
writes, undocumented command outputs, decorative capability declarations,
model-provider-specific canonical data, browser credentials, and commands that
bypass staged validation.

| Check | Finding |
| --- | --- |
| Arbitrary-JSON command | None. A test iterates every registered command and asserts no input schema accepts `path`, `patch` or `value`. |
| Hidden writes | None. A test reads `project.json`, runs every mutating command, and asserts the file is byte-identical. |
| Undocumented outputs | Every command declares an output schema; the API serves both schemas. |
| Decorative declarations | The harness fails on a declaration pointing at a missing command, observation, fixture or script. Ten deliberately-broken manifests are asserted to fail. |
| Provider-specific data | None. No command or manifest field names a model or a vendor. |
| Browser credentials | None added. The capability routes read no secret. |
| Bypassing staged validation | No. `stagedOrIssues` re-validates the whole staged world before any command returns it, and protection is checked first. |

**Gate E: PASS.**
