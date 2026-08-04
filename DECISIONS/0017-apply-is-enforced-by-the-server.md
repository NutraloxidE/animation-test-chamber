# 0017 — Apply is enforced by the server, not by the client that calls it

## Status

Accepted.

## Context

`POST /api/repository/apply` was written against a well-behaved client: the
browser's `DocumentEditSession` parses nothing untrusted, checks protection
before every dispatch, and sends only operations it built itself. The endpoint
trusted all of that.

Four things followed from that trust, and each is reachable with `curl`:

1. the request body was cast to `SceneOperation[]`. A cast is a compile-time
   claim; the endpoint receives JSON, so nothing checked it at all;
2. protection was enforced only in the browser. A direct POST edited a locked
   value, and `approval-required` — the whole point of which is that a *human*
   decides — was satisfied by an `actor` field the caller filled in;
3. the project and its apply report were two sequential `writeFileSync` calls,
   so a failure between them left a repository at a revision no report
   describes;
4. `revisionOf` hashed the project *including* its own `revisionId`, and
   `acceptApplied` never adopted the revision the server returned — so a second
   Apply from an open page declared a baseline the first Apply had replaced, and
   was refused as a conflict with itself.

## Decision

**The server enforces the contract, independently of any client.**

- The operation union moves to `@atc/schema` and is validated at the boundary
  (`parseSceneOperation`). Every member is closed (`additionalProperties:
  false`), so a typo'd field is a refusal and not a silently dropped intent. An
  unrecognised `type` is refused by name rather than as an eleven-way `anyOf`
  failure. Every operation is parsed before any is replayed: a request whose
  fourth operation is unrecognisable must not land its first three.
- Protection is evaluated server-side, against the same `evaluateEdit` gate and
  the same changed paths the browser session uses. **An AI actor can never carry
  its own approval or its own unlocks** — a request that tries is refused with
  403 rather than having the field ignored, because an ignored field looks
  exactly like an honoured one from the outside. A human's session unlocks
  travel with the request, since an unlock is a human gesture in front of a
  specific value.
- The project and the report are written through the existing
  `@atc/repository-transaction` engine as one transaction, so they commit or roll
  back together, and a rollback that cannot be certified puts this process into
  the same read-only lockdown the animation-asset path already uses.
- `revisionOf` hashes the project's **content**, excluding `revisionId`, and
  `acceptApplied(document, revisionId)` adopts what the repository reported. An
  Apply whose operations produce the document already on disk writes nothing and
  answers `unchanged: true`.
- Undo and redo move the *operation list*, not only the preview document.
  Undoing a staged operation unstages it; redo restores it unstaged.

## Consequences

The browser checks stay, and are now an optimisation rather than the rule: they
put the refusal next to the control the human moved, instead of at the end of a
round trip. Nothing depends on them being the only check.

The endpoint is now usable directly by an agent without weakening anything —
which is what makes "a human and an AI make the same change through the same
path" a statement about the system rather than about one client.
