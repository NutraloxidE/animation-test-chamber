# 0014 — Preview, Stage, Apply and commit are four different things

## Status

Accepted.

## Context

An editor that writes as you type cannot be trusted with canonical data, and an
editor that only writes on "Save" cannot show you what you are about to write.
Both problems are solved by making the steps explicit — and by never letting a
button claim more than it did.

## Decision

```text
Preview   changes the page's document and the live runtime. No repository write.
Stage     records typed operations against one observed baseline. No write.
Validate  checks the staged result. No write.
Apply     validates server-side and writes canonical files atomically.
Commit    a separate, separately invocable git action.
```

- Apply replays the **typed operations** server-side rather than accepting a
  document. A full-document request asks the server to trust something the
  client assembled, and a client that mis-assembled one is indistinguishable
  from a client that meant it.
- Apply refuses a stale baseline with `409` instead of overwriting. Two editors,
  or a human and an agent, must not have the second write silently erase the
  first; last-writer-wins is what makes that invisible.
- A failed Apply leaves the staged operations in place. The next move is usually
  to fix one issue and apply again, not to redo everything.
- Apply never creates a git commit, and the apply report deliberately carries no
  commit SHA. A report inventing one before a commit existed would be the most
  convincing possible form of a fabricated result.
- With no API — a static deployment — Apply is refused with a precise reason. It
  never reports success and never degrades into a browser-local save that
  resembles one.

## Consequences

Four visible states instead of one Save button: PREVIEW, STAGED, APPLIED,
CONFLICT/INVALID. CONFLICT and INVALID outrank the local states, because a
session still showing STAGED after a refused Apply would be saying the work is
fine and waiting, when it is neither.
