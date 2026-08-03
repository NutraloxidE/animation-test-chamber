# 0009 — Definition versus runtime instance

## Status

Accepted.

## Context

`ProjectDefinition.characters` holds reusable character definitions, and the
chamber ran exactly one of them: `activeCharacterId` chose a character, one
`Simulation` ran it, and every panel, path and trace assumed there was only ever
one of it.

That assumption is load-bearing in a way that is easy to miss. "Show two
characters at once" is not a rendering change — it is the question of whether a
character definition is a *thing that runs* or a *thing that runs are made
from*. As long as those are the same concept, a second copy of a character can
only be a second copy of its data, and the asset references introduced in schema
v2 exist precisely so that copying stops happening.

## Decision

Split the two concepts explicitly.

A `CharacterDefinition` stays a reusable definition. A new
`RuntimeInstanceDefinition` is a *use* of one: an identity, a placement, a bound
intent source, and an explicitly scoped set of overrides. A `WorldDefinition`
holds instances, the intent tracks scripted instances sample, and which instance
the camera and the focused view follow.

Three consequences are deliberate:

**`ProjectDefinition.world` is optional and nothing rewrites it on load.** A
project without a world resolves through `synthesizeLegacyWorld` into a
one-instance world built from `activeCharacterId`. The focused chamber is
therefore a *view over a one-instance world*, not a second runtime kept alive
beside the new one. Any bug the world path has, the focused path has too — which
is the only version of "compatible" worth the name. Auto-migrating on load was
rejected: it would turn opening a project into a diff, and the first casualty
would be the guarantee that a read-only repository stays byte-identical.

**Declaration order is tick order.** Sorting instances by id would have been
equally deterministic and much worse to author against: renaming an instance
would silently reorder the world. The tick loop iterates a `string[]` captured
at construction, never a `Map` — map iteration is insertion-ordered today and
would keep working by accident, which is exactly why it is not what the loop
reads.

**Resolved documents are cached by asset reference, never by character id.** Two
instances of one character share one `ResolvedProject` object and share no
mutable state. Keying that cache on the character id would be correct until the
day two resolutions of the same id differed — one preview override is enough —
and the cache would then hand one instance the other's graph with nothing able
to notice.

Instance overrides are an enumerated list of fields, not a patch list.
"Override any canonical path" would let one instance rewrite the shared
behaviour asset for every instance referencing it, which is the sharing this
whole contract exists to protect.

## Intent sources, and what they are not

An instance receives normalized intent from an `IntentSourceDefinition`:
`local-input`, `scripted-track`, `replay`, or `none`. These are *sources*, not
behaviours. `scripted-track` samples authored keyframes and has no opinion about
what the instance should do next; anything that decided would be a behaviour
system, which this repository does not have and is not adding.

Track sampling **holds**: every field keeps the value of the latest keyframe at
or before the sampled tick. Interpolating analog sticks would have been
defensible on its own, but a button cannot be interpolated, and a track whose
two halves obeyed different rules is a track nobody can read. Holding is the one
rule that means the same thing for every field, and it makes a press edge
something an author can point at in the document rather than infer.

Tracks are keyed by **simulation tick**, never milliseconds. A track sampled
from wall-clock time would produce different intent on a 30Hz laptop and a 144Hz
desktop, which would make every scripted test a measurement of the machine that
ran it.

## Consequences

- Two instances can share a definition and diverge completely at runtime.
- Selecting an instance in the UI cannot affect the simulation, because
  selection is not an input to anything the runtime reads.
- A new source kind is an added union member rather than a replaced contract.
  Speculative members are not added: an unused variant is a contract nobody has
  had to honour.
- The demo project now ships the two-instance acceptance world, so a human
  opening the chamber can see the capability without composing one first.
  Legacy synthesis is consequently no longer the default path, which is why it
  has a fixture of its own rather than being assumed.
