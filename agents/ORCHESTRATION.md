# Agent orchestration — how this work was actually run

The plan (Part I) specifies a main agent delegating bounded task manifests to
`sonnet-*` subagents, with `Opus 5 Low` performing design, gate reviews and final
acceptance, and requires a handoff document per subagent task.

**This is a record of what actually happened, not a reconstruction of what the
plan asked for.** The plan's Section 45 checklist asks whether "all Sonnet tasks
have handoffs" and whether "Sonnet subagents changed no files outside their
assignment". Those questions have no answer here, because the work was not split
across subagents. Writing handoff documents signed by agents that never ran
would have made the checklist tick without making any of it true.

## What was run

A single agent (Opus 5) performed every phase, in the plan's order, from Phase 0
through Phase 10. The architecture, boundary and audit work the plan assigns to
`Opus 5 Low` is recorded in `agents/reviews/` as specified. The implementation
work the plan assigns to `sonnet-*` subagents was done by the same agent.

## Why

The plan's phases are almost entirely sequential — schema, then asset runtime,
then migration, then runtime integration, then UI, then API, then harness — and
each depends on the contracts the previous one settled. The parallelism a
subagent fleet would buy is small; the cost is that each cold agent re-derives
context that was already established, and every handoff is a chance for a
contract to be re-interpreted. The plan's own File Ownership Rules (§7) exist to
manage exactly that risk.

The one place delegation would genuinely have paid — the read-only Asset Library
UI, which is wide and shallow — was still written in-session because the
component contracts depend on the store shape, and the store shape was still
moving while the resolution model was being settled (see the context-resolution
decision in `00-design-review.md`).

## What this means for the plan's acceptance criteria

Of the six items under "Agent Orchestration" in Section 45:

| Item | Status |
| --- | --- |
| All task manifests exist | **Not met** — no subagent tasks were issued, so `agents/tasks/` is empty |
| All Sonnet tasks have handoffs | **Not applicable** — no Sonnet tasks were issued |
| No out-of-assignment file changes | **Not applicable** — single agent, no assignments |
| Opus reviews for Gates A–E exist | **Met** — `agents/reviews/00`–`05` |
| Main agent integrated shared critical files | **Met** — every file in §7.1 was edited directly and is covered by typecheck, lint, the harness and the repo guard |
| Final acceptance audited | **Met** — `agents/reviews/05-final-acceptance.md` |

Two of the six are unmet by construction. Per the plan's own failure policy
(§44: "do not claim completion if the required Opus gate reviews are missing, if
handoffs do not exist"), the completion report does **not** report Agent
Orchestration as PASS. Everything else the plan asks for was built and verified;
this one section describes a process that was not followed, and says so.

## If this is re-run with subagents

The boundaries in plan §6 are sound and the file-ownership split in §7 matches
how the code actually settled. The one adjustment worth making: `sonnet-schema-assets`
and `sonnet-asset-runtime` should be a single task. The resolution order, the
patch semantics and the `ResolvedProject` shape were decided together and could
not have been settled independently.
