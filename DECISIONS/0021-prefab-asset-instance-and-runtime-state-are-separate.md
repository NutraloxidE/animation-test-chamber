# 0021 — Prefab Asset, Scene Instance and Runtime State are three different things

## Status

Accepted.

## Context

A `CharacterDefinition` lived inside `project.json` and was, in practice, three
things at once: a reusable authored thing, the thing a Scene entity pointed at,
and — through `CHARACTER_PRESETS` before DECISION 0019 — a place where
presentation state accumulated. Sharing worked because `CharacterSceneEntity`
referenced a character by id, but the reusable thing itself was not versioned,
not content-hashed, and not immutable: editing it changed it for every holder,
silently and immediately.

Animation assets had already solved this (PLAN Part II–IV): versioned,
content-hashed, immutable after publication, validated, indexed, transactionally
published. Characters had not.

## Decision

Four layers, and nothing does two jobs.

```text
GameObjectPrefabAsset          versioned, content-hashed, immutable
        ↓  resolution
ResolvedGameObjectPrefab       deep-owned immutable value
        ↓  + GameObjectInstanceDefinition
ResolvedGameObjectDefinition   one Prefab as one Scene placement sees it
        ↓  instantiation
RuntimeGameObject              every mutable byte, never serialized
```

### A Prefab is immutable after publication

Changing a Prefab means publishing `1.0.1`. It never means rewriting
`assets/prefabs/<id>/1.0.0.json`. The content hash is what makes an in-place edit
a detectable event rather than a silent behaviour change, and every reference
carries one.

### A Scene references a version exactly

`GameObjectInstanceDefinition.prefab` carries asset type, id, version and content
hash. No floating "latest" is representable in canonical data, so a Scene cannot
drift onto a Prefab version nobody approved.

### A variant stores patches, never a copy

`root` is not a legal key on `VariantGameObjectPrefabAsset`. A variant that is
secretly a full snapshot is therefore *unrepresentable* rather than merely
discouraged — which matters because a snapshot silently keeps the parent's old
behaviour forever, and nothing can tell that from an intentional override.

A variant may patch a component, add one its parent lacks, remove one, or move a
node. `humanoid-character-base` carries no `ModelRenderer` at all and each of the
five concrete characters *adds* one, because a base that shipped a placeholder
model would be a second, wrong answer to "which model is this?".

A fork stores a full snapshot plus provenance and never reads its parent again.
`tests/unit/prefabs/derivation.test.ts` resolves a fork with its parent absent
from the registry, which is the difference between a fork and a variant stated as
a test.

### Overrides address stable ids

```text
nodeId: root, componentId: animator, path: /assignment/motionSet
```

Never array indexes: inserting a component would otherwise re-target every
override after it. A patch may change *which* Behavior or Motion Set is
referenced; it cannot reach through that reference into the asset's contents. To
change a Behavior you publish a Behavior version.

A patch may not touch `componentId`, `componentType` or `schemaVersion` — an
override that could change the type would be a component replacement wearing an
override's name, and every consumer that had already narrowed on the type would
be holding the wrong shape.

### Runtime state is never canonical

None of these appear in a Prefab or a Scene: animation time, current state,
mixer, skeleton instance, velocity, input buffer, active action, transition
progress, runtime handles, WebGL objects, React state, device handles, AI session
handles.

Enforced twice, because the schema alone cannot do it: `additionalProperties:
false` refuses an unknown field, but `CanonicalPatch.value` is `unknown` by
necessity — it has to hold whatever the patched field holds — so a denylist runs
over the whole document as well, and `harness:repo-guard` runs it over the files
on disk.

### Nested Prefabs

A child is either inline (this Prefab owns it) or a nested Prefab instance (this
Prefab references another). Nested cycles are refused by the registry rather than
the schema, because a schema cannot see the other file. A nested instance's
transform composes with the nested root's own; discarding either would move every
nested object the moment someone gave the nested root an offset.

An override on a nested instance affects that instance only. Resolution marks
nested nodes so that an override addressed at the outer Prefab's `nodeId` cannot
accidentally match a node the nested Prefab happens to have called `root` too.

## Consequences

- Two instances of one Prefab share the Prefab document, the resolved animation
  bundle and the source clips; they share no `ControllableCharacter`, no
  `Simulation`, no component runtime, no transform and no attachment state.
  `tests/unit/game-objects/isolation.test.ts` asserts this by *moving* one and
  checking the other did not follow — object identity alone would pass while a
  captured reference quietly shared a simulation.
- Runtime spawn and despawn do not touch the canonical Scene. A game that spawned
  a projectile must not thereby author a document change.
- The animation engine is not duplicated. A GameObject with Animator +
  CharacterMotor composes the existing `ControllableCharacter`; the adapter
  presents its Components as the `CharacterDefinition` the existing resolver
  already accepts, and decides nothing itself.
