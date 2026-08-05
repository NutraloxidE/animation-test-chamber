# 0020 — Everything authored in a Scene is a GameObject

## Status

Accepted. Partially in force: the canonical contract and the runtime exist; the
renderer, the Scene runtime, the editor routes and the API still read the entity
view. See `reports/gameobject-prefab-migration-audit.md`.

## Context

A Scene held a discriminated union:

```text
CharacterSceneEntity
PropSceneEntity
LightSceneEntity
CameraSceneEntity
```

That union was the right call at the time, and DECISION 0009 argued for it
against a universal component bag: a general ECS makes "what fields does this
entity have?" a question with no answer a schema can give, and the Inspector,
the validator, the Unity exporter and the apply transaction each have to answer
it before they can do anything.

The limitation turned out not to be typing. It was *arity*. `kind` admits
exactly one answer, so:

```text
a Character is one entity kind
a Camera is another
a Light is another
a Prop is another
```

and a single object could not be a model *and* an animator *and* a light *and* a
collider at once. A character carrying a lantern had nowhere to live. An
animated prop had to either become a Character — inheriting a controller binding
and a capsule it has no use for — or stay a Prop and not animate. Every new
capability meant a new top-level entity kind, a new branch in the Inspector, a
new branch in the exporter, a new branch in the apply transaction.

## Decision

A Scene contains one collection:

```text
gameObjects: GameObjectInstanceDefinition[]
```

There is no `kind`. What an object *is* comes from the Components its resolved
Prefab carries:

```text
Character                ModelRenderer + Animator + CharacterMotor
Camera                   Camera
Light                    Light
Animated prop            ModelRenderer + Animator
Character with a lantern  ModelRenderer + Animator + CharacterMotor + Light
```

`isCharacterComposition(components)` is the function that replaces
`entity.kind === 'character'`. The "Character Prefabs" filter is a derived view
over Components, not a stored flag — so an object that gains a motor becomes a
character without anything being told.

## Why this is not an untyped ECS

The objection DECISION 0009 raised is real, and it is answered structurally
rather than by convention.

```ts
components: Record<string, unknown>   // rejected
components: GameObjectComponentDefinition[]   // adopted
```

`GameObjectComponentDefinition` is a **closed** discriminated union. Every
member carries `schemaVersion`, `componentId`, `componentType`, `enabled`, an
optional `protection`, a typed payload, and `additionalProperties: false`.
Therefore:

- an unknown `componentType` is refused;
- an extra field on a known component is refused;
- two components with the same `componentId` on one node are refused;
- "what fields does this component have?" has exactly one answer, from the
  schema, for every consumer.

`tests/unit/prefabs/schema.test.ts` asserts each of those refusals. They are the
whole argument: a union that has not been shown to reject anything is a bag with
better documentation.

There is deliberately **no** placeholder component for Script, Audio, Particle,
Physics, Network, Health, Combat or Inventory. A future component joins the union
with its own schema, resolver, runtime, UI, export and tests. An escape hatch to
park one in early is exactly how a closed union stops being closed.

## Consequences

- Adding a capability adds a Component, not an entity kind. The Inspector, the
  exporter and the apply path gain a case in one union rather than a branch each.
- `scene.place_asset` with a four-branch payload collapses to
  `scene.place_prefab`. `scene.set_character_source` and
  `scene.bind_controller` become `scene.set_prefab_source` and
  `scene.set_instance_binding`, which work for a light and a camera too, because
  nothing about "point this instance at a different Prefab" is character-shaped.
- Transform stops being something a kind might or might not have. It is
  mandatory and intrinsic on every Prefab node, because a missing transform would
  have to mean "identity, probably", which is a default masquerading as data.
- The entity union survives for the length of the migration and is read only
  through migration code and the parity check. Two views of one Scene that are
  allowed to disagree are two Scenes, so `harness:game-objects` compares them
  instance by instance on every run.
