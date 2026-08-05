# 0022 — Reference adoption always names exact targets

## Status

Accepted. The request contract, the usage graph and the planning procedure are
implemented and tested; the HTTP route that applies a plan is not yet built. See
`reports/gameobject-prefab-migration-audit.md`.

## Context

A specific, reproducible ambiguity. The UI could describe an edit to a shared
Behavior as affecting every Character that holds it, while the server published a
new version and re-pointed only the *active* Character. The sentence a human read
and the change the machine made were two different claims, and nothing in the
system compared them.

The mechanism that allowed it was a scope: a request said *what kind* of change
this was — "shared", "all" — and the server worked out what that meant at write
time, against whatever the repository happened to look like by then. Two things
go wrong with a scope, and the second is worse than the first:

1. The set the human approved and the set the server computed can differ,
   because they are computed at different moments from different snapshots.
2. Nothing can detect that. There is no artifact recording what the human
   approved, so there is nothing to compare the write against.

## Decision

### Publishing is not adoption

Publishing `Behavior 1.0.1` or `Prefab 1.0.1` creates a version. It moves no
reference. "Publish the version, adopt it nowhere yet" is a legal, useful and
tested request — and it is the case that proves the two acts are separate.

### A request enumerates its targets

There is no `updateScope` field in `packages/schema/src/prefab-save.ts`, and
`tests/unit/prefabs/adoption.test.ts` asserts that adding one is a schema
refusal. What travels is:

```ts
targetPrefabIds: string[]
targets: { sceneId: string; gameObjectId: string }[]
```

The UI may still offer "This Prefab only", "Selected Prefabs", "All current
holder Prefabs" and "No Prefabs — publish only". Those are *buttons*. What goes
on the wire is the ids the button expanded to, which is the thing the human
looked at.

### The snapshot travels with the request

`expected` carries the source content hash, the project revision id, and the full
holder list the client believed when it drew the confirmation dialog. The server
compares all three. A holder list that has moved since is a 409 with no writes.

The server does **not** recompute "all holders" and proceed. If a sixth Prefab
started holding the Behavior between the dialog and the submit, including it and
excluding it are both wrong answers to a question only the human can settle.

### One usage graph answers "who holds this?"

`describePrefabUsage` is the single source. The Inspector's badges, the Asset
Library's "Used By", the save blast radius, the delete policy, the audit report
and the adoption plan all read it. Two scans that agree today are two scans that
disagree the first time one of them learns about nested Prefabs — which is not
hypothetical: the first version of this graph read *stored* Prefab payloads, so
it reported the shared Behavior as held by the abstract base alone while five
variants inherited it. A holder list wrong in that direction draws a blast radius
smaller than the truth, so the graph resolves before it counts.

### The equality that has to hold

```text
displayed target ids === request target ids === changed target ids
```

The confirmation dialog renders from the request object that will be sent, not
from a separately computed prose string, and the plan is computed from that same
object. The three lists are then equal by construction rather than by review.

## Consequences

- A plan reports `targets` and `untouched` as separate lists, so "what did I
  deliberately not change?" is answerable — which is what makes a non-target
  immutability assertion writable at all.
- Optimistic concurrency is per-request rather than global: a stale snapshot
  fails this adoption without locking the repository.
- One transaction may publish an asset version, publish Prefab versions, update
  Scene references, bump the project revision and refresh the generated indexes.
  Either all land or none do.
