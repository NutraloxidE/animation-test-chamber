# 0005 — Every external service is optional, and its absence is visible

Status: accepted

## Context

A tool that only works once four integrations are configured is a tool nobody
evaluates. Worse, an integration that fails silently makes people trust output
that was never produced.

## Decision

The chamber boots and closes its full loop — play, tune, compare, validate,
stage, commit — with an empty `.env`.

- **Git** falls back to an in-memory adapter with identical semantics, including
  base-SHA conflict detection and protected-branch refusal.
- **AI** falls back to a deterministic rule-based provider that produces three
  genuinely different, protection-aware proposals. Determinism is a feature: it
  makes A/B/C comparison reproducible.
- **Animation conversion** without a worker produces an explicit pending job
  naming the missing variable, not a silent failure.
- **Haptics** degrade advanced → trigger → generic → no-op, and never block
  playback.

In every case the degraded state is reported in the UI and in `/api/health`.
Nothing pretends to have succeeded.

## Consequences

- The fallbacks are real implementations that must be maintained and tested,
  not stubs. The rule-based provider carries most of the AI test coverage.
- Deleting a fallback is a blocking repo-guard finding.
