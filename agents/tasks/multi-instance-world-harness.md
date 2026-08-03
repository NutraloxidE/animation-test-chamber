# Task map — Multi-Instance World and Operability Harness

**Base commit:** `c684dafb1ceadc252ab9621674c32e32d117bcf7`
**Branch:** `claude/multi-instance-world-harness`
**Executing agent:** `main-opus-world-harness`, model `claude-opus-5`.

## Orchestration status — read this first

The work package specifies seven subagent tasks across four model tiers
(Opus 5 Low for gate reviews, Sonnet 5 High for contract-sensitive work,
Sonnet 5 Low for mechanical generation), each with its own worktree, task
manifest and returned handoff.

**No subagent ran.** The tiered models named in the work package
("Claude Opus 5 Low", "Claude Sonnet 5 High", "Claude Sonnet 5 Low") are not
addressable as separate agents in this environment, and the schema, runtime,
intent-routing and capability contracts are coupled tightly enough that
splitting them across isolated worktrees would have meant integrating four
divergent versions of the same contract rather than reviewing one.

Every task below was therefore performed by the main agent. Per §8.2 of the
work package: **orchestration is recorded as not followed.** The gate *reviews*
are real analyses and are recorded as such; they are self-reviews by the
implementing agent, which is weaker evidence than an independent reviewer and
is labelled that way wherever it appears.

This file is the scope record the manifests were meant to be. The single
handoff is `agents/handoffs/multi-instance-world-harness.md`.

---

## Task 00 — Architecture inventory and contract gate (Gate A)

Read-only. Output: `agents/reviews/06-multi-instance-architecture-audit.md`.
Decides the additive schema shape, legacy synthesis policy, replay versioning,
iteration policy, runtime ownership boundary, observation path format, the
capability manifest contract, and which fields stay project-global.

**Status:** done. Gate A recorded PASS.

## Task 01 — Schema and world-runtime foundation (Gate B)

Owned: `packages/schema/src/world.ts`, `packages/schema/src/project.ts`,
`packages/schema/src/validate.ts`, `packages/world-runtime/**`,
`tests/unit/world/**`, `tests/fixtures/world/**`.

Schema and runtime are one task by the same rule the repository's prior
orchestration record applied to assets: the contracts are too coupled to split
safely.

**Status:** done. 20 unit tests. Gate B recorded PASS.

## Task 02 — Intent routing, replay, trace, observation (Gate C)

Owned: `packages/world-runtime/src/{intent,trace,world-replay,observation}.ts`,
one bounded export added to `packages/replay-runtime` (`computeMetrics`),
`tests/replay/world/**`.

**Status:** done. 12 replay tests, including a byte-identical projection onto
the legacy trace for all four committed fixtures. Gate C recorded PASS.

## Task 03 — Web viewport and human authoring surface (Gate D)

Owned: `apps/web/src/components/world/**`, `apps/web/src/world/**`, styles,
`tests/visual/world/**`; store integration in `apps/web/src/store.ts`.

**Status:** done. Gate D recorded PASS with a scope note: the world viewport
renders the procedural character on a flat plane and does not yet show terrain
meshes, GLB characters, debug overlays or the ghost trace.

## Task 04 — Capability registry and command surface (Gate E)

Owned: `packages/capability-runtime/**`, `apps/api/src/routes/capabilities.ts`,
`harness/check-capabilities.ts`, `tests/unit/capabilities/**`,
`tests/integration/api/capabilities.test.ts`.

**Status:** done. 16 unit tests, 8 API tests, 5 AI-workflow integration tests.
Gate E recorded PASS.

## Task 05 — Unity contract export

Owned: `packages/unity-export/src/scaffold.ts`, `generated/unity/**`,
`tests/integration/unity/world-export.test.ts`.

The DTO generator is schema-driven, so the world types came across without a
generator change; the work was the `IChamberWorld` adapter seam and an honest
README.

**Status:** done. 6 tests.

## Task 06 — Generated artifact synchronization

`pnpm schema:generate`, `pnpm assets:animation:index`, `pnpm unity:export`, run
twice with a no-diff check.

**Status:** done.

## Task 07 — Harness and failure injection

Owned: `harness/check-world.ts`, `harness/check-capabilities.ts`, repo-guard
additions, `reports/**`.

**Status:** done. Two new one-shot stages plus a ninth repo-guard check.
