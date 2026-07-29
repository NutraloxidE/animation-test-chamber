# 0001 — The executable specification is the source of truth

Status: accepted

## Context

A comprehensive `spec.md` describing intended behaviour drifts from the code
almost immediately, and then quietly becomes a source of wrong answers. It is
also the document an agent is most likely to "helpfully" restate rather than
implement.

## Decision

There is no comprehensive spec document. The specification is the executable
combination of: TypeBox types, generated JSON Schema, canonical data, defaults,
presets, UI constraints, validation, error messages, automated tests, input
replays, Git history, decision records, and runtime behaviour.

Markdown carries only what code cannot: purpose, rarely-changing design
principles, and the reasoning behind significant judgement calls.

## Consequences

- A behaviour change requires changing code or canonical data — it cannot be
  achieved by editing prose.
- `ARCHITECTURE.md` describes boundaries and limitations, never field lists.
- When runtime behaviour and schema disagree, neither automatically wins:
  suspect a bug, a temporary implementation, or an unapplied change.
