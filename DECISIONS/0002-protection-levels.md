# 0002 — Protection levels guard human-confirmed values

Status: accepted

## Context

The failure mode this project exists to prevent is not "the AI cannot make the
change". It is: a human spends an afternoon finding a value that feels right,
and three commits later an unrelated refactor has moved it, deleted the
fallback that made it work, or relaxed the test that pinned it.

Being unreferenced, redundant, old-looking, or shortenable is not evidence that
something is safe to remove. Frequently it is evidence someone was careful.

## Decision

Every canonical value can carry `editable`, `approval-required`, `locked` or
`invariant`. Protection is inherited down the document and can only be raised by
a nested annotation, never lowered.

The rules that matter:

- An AI may **propose** an `approval-required` change but never apply one
  unapproved. It may not even propose a `locked` or `invariant` change, because
  a proposal is how a settled value gets argued back open.
- Only a human can unlock, and only for the current session — the repository
  stays locked.
- Weakening a protection level is itself a blocking diff finding.

Enforcement is duplicated across four layers (edit session, proposal generator,
API, repo guard) on purpose. One check is one bug away from useless.

## Consequences

- Some legitimate edits require a deliberate unlock. That friction is the point.
- Protection metadata is canonical data, so it is versioned, diffed and
  reviewable like everything else.
