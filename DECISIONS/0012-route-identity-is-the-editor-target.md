# 0012 — Route identity is the editor target

## Status

Accepted.

## Context

Before this, the chamber had no router. Which character was being edited was
answered by `ProjectDefinition.activeCharacterId`, a store field a picker wrote
and every panel read. Three other values claimed to answer the same question in
practice — the asset library's selection, the visual preset id, and the world's
`focusedInstanceId` — and all four were independently writable.

The failure mode is specific and quiet. A panel that reads a stale or different
one of those values renders perfectly, with plausible data, while editing a
document the user is not looking at. Nothing on screen contradicts it. The first
sign is a tuning change that landed on the wrong character.

## Decision

The URL is the editor target.

```text
/edit/rig/:characterId    edits exactly that Character Definition
/edit/scene/:sceneId      edits exactly that Scene Definition
```

- Resolution is an **exact id match**. No case folding, no prefix matching, no
  "closest" id, and above all **no fallback to the first item**.
- An unknown id renders a not-found state that names the id that failed and
  lists the ids that exist.
- `activeCharacterId` and `activeSceneId` survive as *navigation preferences*,
  read only to answer "where should `/` go" and "where should a list link to".
  Once the browser is on a route, neither is consulted again.
- A character switcher **navigates**. It does not assign a global id and hope
  every panel follows.
- Identity in a route is a stable repository id, never a display name, and it is
  encoded and decoded exactly once.
- Query parameters carry transient view state only (`?panel=graph`). Canonical
  state never depends on them.

## Consequences

The fallback is the thing this gives up, and giving it up is the point: a route
that always renders something is a route that can always render the wrong thing.
A not-found page is a worse demo and a far better editor.

`react-router`'s `BrowserRouter` owns matching and navigation. A second
hand-written routing state machine in the store would need its own history
handling, and browser Back would then disagree with the app about where it is.
`HashRouter` was rejected because `#/edit/rig/…` is not a path a server, a deep
link or a crawler can reason about; the cost is a SPA rewrite in `vercel.json`
that preserves `/api/*` and `/assets/*`.

Enforced by `tests/unit/routing/route-targets.test.ts`, whose assertions are
mostly negative — the fallback behaviours that must *not* happen.
