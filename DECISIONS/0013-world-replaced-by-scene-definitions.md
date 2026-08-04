# 0013 — The World concept is replaced by Scene Definitions

## Status

Accepted. Supersedes the user-facing half of 0009 and 0010; their *contracts*
survive unchanged under Scene naming.

## Context

`WorldDefinition` could hold exactly one thing: character instances. A document
that cannot hold a light or a camera is not a scene, it is a cast list. Meanwhile
the product had grown a "World mode" toggle and a World tab inside a screen whose
actual job is tuning one character, so "which character is this panel about"
had two answers depending on a toggle.

## Decision

```text
WorldDefinition        -> SceneDefinition
RuntimeInstance        -> SceneEntity / CharacterSceneEntity
WorldRuntime           -> SceneRuntime
world.* commands       -> scene.* commands
ProjectDefinition.world -> ProjectDefinition.scenes[]
```

A Scene entity is a **discriminated union** of character, prop, light and
camera — not a general ECS and not a universal component bag. An ECS would
express all four and every future kind, and would also make "what fields does
this entity have?" a question no schema can answer — which is the question the
Inspector, the validator, the apply transaction and the Unity exporter each
have to answer before they can do anything.

The transform widens from position-plus-yaw to position, quaternion rotation and
scale. The *runtime* stays yaw-only: `SceneRuntime` projects yaw out of the
authored quaternion when it constructs a `Simulation`. The document is not
narrowed to what the runtime happens to support.

## Consequences

This is a controlled migration, not a deletion and rewrite. Every guarantee the
world runtime had is carried across rather than re-derived: declaration-order
ticking, the bundle cache keyed on animation inputs alone, per-entity mutable
isolation, reset-by-reconstruction, and the versioned camera-yaw control track.

`tests/replay/scene/scene-equivalence.test.ts` runs the committed acceptance
fixture through both runtimes and asserts byte-identical per-character tick
records. That equivalence is the only evidence the rename preserved behaviour; a
fresh baseline for the new runtime would have been less work and would have
proved nothing.
