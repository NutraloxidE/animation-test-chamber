/**
 * GameObject Prefab Assets.
 *
 * The rule this whole file exists to make structural:
 *
 *   Prefab Asset ≠ Scene Instance ≠ Runtime State.
 *
 * A Prefab is a versioned, content-hashed, immutable-after-publication asset
 * describing *what a thing is made of*. It says nothing about where a copy of
 * it stands (that is `GameObjectInstanceDefinition`, in `scene.ts`) and nothing
 * about what a copy is currently doing (that is `RuntimeGameObject`, in
 * `@atc/game-object-runtime`, and it is never serialized).
 *
 * It replaces the entity-kind union — Character, Prop, Light, Camera — that
 * `scene.ts` used to carry. That union was better than an untyped component
 * bag, and its limitation was not typing but *arity*: a character that also
 * casts light had nowhere to live, because "kind" admits exactly one answer.
 * Capability now comes from Components:
 *
 *   Character      ModelRenderer + Animator + CharacterMotor
 *   Camera         Camera
 *   Light          Light
 *   Animated prop  ModelRenderer + Animator
 *
 * and a character carrying a lantern is that first row plus `Light`, which is
 * an authoring act rather than a schema change.
 *
 * "Everything is a GameObject" is emphatically *not* `Record<string, unknown>`
 * (§3.2). `GameObjectComponentDefinition` is a closed discriminated union with
 * `additionalProperties: false` on every member, so an unknown component type
 * and a misspelled field are both refusals — which is what keeps the Inspector,
 * the validator, the Unity exporter and the apply transaction able to answer
 * "what fields does this have?" without guessing.
 */
import { Type, type Static } from '@sinclair/typebox';
import { Id, ProtectionMetadata, SchemaVersion, Vec3 } from './common.ts';
import {
  AssetVersion,
  CanonicalPatch,
  PublishedContentHash,
  assetDerivationProvenanceFields,
  assetMetadataFields,
} from './assets.ts';
import { AssetReference, CharacterAnimationAssignment } from './animation-assets.ts';
import { TransformDefinition } from './transform.ts';

export const GAME_OBJECT_PREFAB_ASSET_TYPE = 'game-object-prefab' as const;

export const GameObjectPrefabAssetType = Type.Literal(GAME_OBJECT_PREFAB_ASSET_TYPE, {
  $id: 'GameObjectPrefabAssetType',
});
export type GameObjectPrefabAssetType = Static<typeof GameObjectPrefabAssetType>;

/**
 * An exact reference to one published Prefab version.
 *
 * The same four fields, and the same reason for each, as the animation
 * `AssetReference`: no floating "latest" is representable in canonical data
 * (§3.5), and the hash is what makes "someone edited a published version in
 * place" a detectable event rather than a silent behaviour change.
 *
 * It is a *distinct* type rather than a widened `AssetReference` (§4.2). If
 * one reference type covered both families, `resolveBehaviorAsset` would have
 * to check at runtime whether it had been handed a Prefab, and every animation
 * resolver signature would stop stating what it actually accepts.
 */
export const GameObjectPrefabReference = Type.Object(
  {
    assetType: GameObjectPrefabAssetType,
    assetId: Id,
    version: AssetVersion,
    contentHash: PublishedContentHash,
  },
  { $id: 'GameObjectPrefabReference', additionalProperties: false },
);
export type GameObjectPrefabReference = Static<typeof GameObjectPrefabReference>;

/**
 * Either family's reference, for the tooling that genuinely spans both: the
 * Asset Library's browse list, a resolved Prefab's dependency list, the delete
 * policy. Deliberately not accepted anywhere in the animation resolvers.
 */
export const RepositoryAssetReference = Type.Union(
  [AssetReference, GameObjectPrefabReference],
  { $id: 'RepositoryAssetReference' },
);
export type RepositoryAssetReference = Static<typeof RepositoryAssetReference>;

export function isPrefabReference(
  reference: RepositoryAssetReference,
): reference is GameObjectPrefabReference {
  return reference.assetType === GAME_OBJECT_PREFAB_ASSET_TYPE;
}

export function prefabReferenceKey(reference: GameObjectPrefabReference): string {
  return `${reference.assetType}:${reference.assetId}@${reference.version}`;
}

export function prefabReferencesEqual(
  left: GameObjectPrefabReference,
  right: GameObjectPrefabReference,
): boolean {
  return left.assetId === right.assetId && left.version === right.version;
}

/** Repository location of one published Prefab version (§5.1). */
export function prefabAssetFilePath(assetId: string, version: string): string {
  return `assets/prefabs/${assetId}/${version}.json`;
}

export const PrefabDerivationProvenance = Type.Object(
  assetDerivationProvenanceFields(GameObjectPrefabReference),
  { $id: 'PrefabDerivationProvenance', additionalProperties: false },
);
export type PrefabDerivationProvenance = Static<typeof PrefabDerivationProvenance>;

export const GameObjectPrefabMetadata = Type.Object(
  assetMetadataFields({
    assetType: GameObjectPrefabAssetType,
    id: Id,
    assetProvenance: PrefabDerivationProvenance,
  }),
  { $id: 'GameObjectPrefabMetadata', additionalProperties: false },
);
export type GameObjectPrefabMetadata = Static<typeof GameObjectPrefabMetadata>;

/* -------------------------------------------------------------------------- */
/* Model binding                                                              */
/* -------------------------------------------------------------------------- */

const ProceduralHumanoidBinding = Type.Object(
  {
    kind: Type.Literal('procedural-humanoid'),
    /** Appearance preset id, resolved by the renderer against its own catalog. */
    presetId: Id,
  },
  { additionalProperties: false },
);

const RepositoryModelBinding = Type.Object(
  {
    kind: Type.Literal('repository-model'),
    /** Path the web app can fetch, e.g. `/assets/characters/<id>/<file>.glb`. */
    assetPath: Type.String({ minLength: 1 }),
    scale: Type.Number({ minimum: 0.001, maximum: 1000 }),
    rotationYRad: Type.Number({ minimum: -Math.PI * 2, maximum: Math.PI * 2 }),
  },
  { additionalProperties: false },
);

/**
 * What a renderable thing *is*, authored rather than previewed.
 *
 * Renamed from `CharacterModelBinding` because nothing about a mesh reference
 * is character-specific: an animated prop and a lantern resolve their model the
 * same way. The old name survives as a type alias for the migration only.
 *
 * `rightHandBone` and `weaponGrips` are deliberately *not* here any more
 * (§5.2). An attachment point is a property of the object, not of the mesh
 * binding — a procedural humanoid can hold a lantern too — so they moved to
 * `EquipmentSocketsComponent`, where a socket is not called "weapon" because a
 * hand may hold a tool, a lantern or an instrument.
 */
export const RenderableModelBinding = Type.Union(
  [ProceduralHumanoidBinding, RepositoryModelBinding],
  { $id: 'RenderableModelBinding' },
);
export type RenderableModelBinding = Static<typeof RenderableModelBinding>;

/**
 * `project.ts` still exports a `CharacterModelBinding`, and this is deliberately
 * *not* an alias for it. The legacy type carries `rightHandBone` and
 * `weaponGrips`; this one does not, because those moved to
 * `EquipmentSocketsComponent`. Aliasing two differently-shaped types under one
 * name would make the migration look finished while the grips still had two
 * homes. The legacy type stays in `project.ts` and retires with
 * `CharacterDefinition`.
 */

/* -------------------------------------------------------------------------- */
/* Components                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Every component carries these, and `componentId` is the load-bearing one:
 * overrides address a component by stable id, never by array index (§5.8), so
 * inserting a component into a Prefab cannot silently re-target a Scene
 * instance's override at a different component.
 */
function componentFields<TType extends ReturnType<typeof Type.Literal>>(componentType: TType) {
  return {
    schemaVersion: SchemaVersion,
    componentId: Id,
    componentType,
    enabled: Type.Boolean(),
    protection: Type.Optional(ProtectionMetadata),
  } as const;
}

export const ModelRendererComponent = Type.Object(
  {
    ...componentFields(Type.Literal('model-renderer')),
    model: RenderableModelBinding,
    castShadow: Type.Boolean(),
    receiveShadow: Type.Boolean(),
  },
  { $id: 'ModelRendererComponent', additionalProperties: false },
);
export type ModelRendererComponent = Static<typeof ModelRendererComponent>;

/**
 * The animation assignment, unchanged.
 *
 * `CharacterAnimationAssignment` moves here from `CharacterDefinition`
 * verbatim — Behavior, Motion Set, Rig, Tuning and instance overrides keep
 * their exact meaning, so the Rig Editor, the resolver and every replay fixture
 * still see the same four references they always did. Contents are never
 * copied in: a Prefab that inlined a behaviour graph would be a Prefab that
 * cannot share one.
 */
export const AnimatorComponent = Type.Object(
  {
    ...componentFields(Type.Literal('animator')),
    assignment: CharacterAnimationAssignment,
    /** Motion context (the demo's weapon mode) this object opens in. */
    defaultContextKey: Type.Optional(Type.String({ minLength: 1, maxLength: 96 })),
  },
  { $id: 'AnimatorComponent', additionalProperties: false },
);
export type AnimatorComponent = Static<typeof AnimatorComponent>;

/**
 * What makes a GameObject controllable.
 *
 * Presence is the whole signal: "is this a character?" is answered by
 * `Animator + CharacterMotor`, not by a `kind` field, which is why an animated
 * prop needs no Character concept and a Character carrying a light needs no new
 * entity kind.
 */
export const CharacterMotorComponent = Type.Object(
  {
    ...componentFields(Type.Literal('character-motor')),
    /** Which normalized-intent channel drives this object. */
    intentChannel: Type.String({ minLength: 1, maxLength: 96 }),
    movementScale: Type.Number({ minimum: 0, maximum: 4 }),
    turnScale: Type.Number({ minimum: 0, maximum: 4 }),
  },
  { $id: 'CharacterMotorComponent', additionalProperties: false },
);
export type CharacterMotorComponent = Static<typeof CharacterMotorComponent>;

export const CapsuleColliderComponent = Type.Object(
  {
    ...componentFields(Type.Literal('capsule-collider')),
    radius: Type.Number({ minimum: 0.05, maximum: 2 }),
    height: Type.Number({ minimum: 0.2, maximum: 4 }),
    center: Vec3,
  },
  { $id: 'CapsuleColliderComponent', additionalProperties: false },
);
export type CapsuleColliderComponent = Static<typeof CapsuleColliderComponent>;

export const EquipmentSocketDefinition = Type.Object(
  {
    socketId: Id,
    /** Bone the socket rides, e.g. `Palm.R`. Absent means it rides the node. */
    boneName: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    localPosition: Type.Tuple([Type.Number(), Type.Number(), Type.Number()]),
    localRotation: Type.Tuple([Type.Number(), Type.Number(), Type.Number()]),
    /** Which items this socket will accept. Empty means "anything". */
    acceptedItemTags: Type.Array(Type.String({ minLength: 1, maxLength: 96 })),
  },
  { $id: 'EquipmentSocketDefinition', additionalProperties: false },
);
export type EquipmentSocketDefinition = Static<typeof EquipmentSocketDefinition>;

/**
 * Where this object can hold something.
 *
 * The old `rightHandBone` plus `weaponGrips` map onto this one-for-one, and the
 * rename is the point: the previous names asserted that a hand holds a weapon,
 * which made "the same grip, for a lantern" unrepresentable without a second
 * field. A socket accepts item *tags*.
 */
export const EquipmentSocketsComponent = Type.Object(
  {
    ...componentFields(Type.Literal('equipment-sockets')),
    sockets: Type.Array(EquipmentSocketDefinition),
  },
  { $id: 'EquipmentSocketsComponent', additionalProperties: false },
);
export type EquipmentSocketsComponent = Static<typeof EquipmentSocketsComponent>;

/**
 * An authored camera.
 *
 * Which GameObject it follows is *not* here: a follow target names another
 * object in one particular Scene, so it is an instance relation
 * (`GameObjectInstanceRelations`), not Prefab identity. Baking it in would make
 * a reusable camera Prefab impossible to reuse.
 */
export const CameraComponent = Type.Object(
  {
    ...componentFields(Type.Literal('camera')),
    projection: Type.Union([Type.Literal('perspective'), Type.Literal('orthographic')]),
    fieldOfViewDeg: Type.Optional(Type.Number({ minimum: 1, maximum: 179 })),
    orthographicSize: Type.Optional(Type.Number({ minimum: 0.01, maximum: 1000 })),
  },
  { $id: 'CameraComponent', additionalProperties: false },
);
export type CameraComponent = Static<typeof CameraComponent>;

export const LightComponent = Type.Object(
  {
    ...componentFields(Type.Literal('light')),
    lightType: Type.Union([
      Type.Literal('directional'),
      Type.Literal('point'),
      Type.Literal('spot'),
    ]),
    intensity: Type.Number({ minimum: 0, maximum: 1000 }),
    /** `#rrggbb`. A named colour would be one more table to keep in sync. */
    color: Type.String({ pattern: '^#[0-9a-fA-F]{6}$' }),
    range: Type.Optional(Type.Number({ minimum: 0, maximum: 10000 })),
    spotAngleRad: Type.Optional(Type.Number({ minimum: 0, maximum: Math.PI })),
  },
  { $id: 'LightComponent', additionalProperties: false },
);
export type LightComponent = Static<typeof LightComponent>;

/** Authoring metadata. Not runtime-mutable state, and never written back to. */
export const TagComponent = Type.Object(
  {
    ...componentFields(Type.Literal('tags')),
    tags: Type.Array(Type.String({ minLength: 1, maxLength: 96 })),
  },
  { $id: 'TagComponent', additionalProperties: false },
);
export type TagComponent = Static<typeof TagComponent>;

/**
 * The closed component union.
 *
 * Closed is the whole contract (§3.2, §5.5). A future Script, Audio, Physics or
 * Inventory component joins this union *with* its schema, resolver, runtime,
 * UI, export and tests — there is deliberately no untyped escape hatch to park
 * one in early, because an escape hatch is how a typed union becomes a bag.
 */
export const GameObjectComponentDefinition = Type.Union(
  [
    ModelRendererComponent,
    AnimatorComponent,
    CharacterMotorComponent,
    CapsuleColliderComponent,
    EquipmentSocketsComponent,
    CameraComponent,
    LightComponent,
    TagComponent,
  ],
  { $id: 'GameObjectComponentDefinition' },
);
export type GameObjectComponentDefinition = Static<typeof GameObjectComponentDefinition>;

export const GAME_OBJECT_COMPONENT_TYPES = [
  'model-renderer',
  'animator',
  'character-motor',
  'capsule-collider',
  'equipment-sockets',
  'camera',
  'light',
  'tags',
] as const;
export type GameObjectComponentType = (typeof GAME_OBJECT_COMPONENT_TYPES)[number];

/* -------------------------------------------------------------------------- */
/* Overrides                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * One component's worth of overrides, addressed by stable ids (§5.8).
 *
 * A patch path is relative to the component, so the canonical example reads:
 *
 *   nodeId: root, componentId: animator, path: /assignment/motionSet
 *
 * A patch can change *which* Behavior or Motion Set is referenced. It cannot
 * reach inside one — `/assignment/motionSet/bindings/0/clip` is refused — because
 * editing shared contents through a reference is precisely the sharing failure
 * the asset system exists to prevent. To change a Behavior's contents you
 * publish a Behavior version.
 */
export const PrefabComponentOverride = Type.Object(
  {
    nodeId: Id,
    componentId: Id,
    patches: Type.Array(CanonicalPatch),
  },
  { $id: 'PrefabComponentOverride', additionalProperties: false },
);
export type PrefabComponentOverride = Static<typeof PrefabComponentOverride>;

/**
 * What a variant is allowed to change about its parent.
 *
 * A variant stores these and no payload (§3.4, §5.7). Patching an existing
 * component is the common case; the other four exist because an abstract base
 * genuinely does not know things its concrete children do — `humanoid-character-base`
 * carries no `ModelRenderer` at all, because a base that shipped a placeholder
 * model would make "which model is this?" answerable in two places.
 *
 * The alternative — letting a variant re-state a whole root node — is exactly
 * the copied snapshot this schema makes unrepresentable.
 */
export const PrefabPatch = Type.Union(
  [
    Type.Object(
      {
        kind: Type.Literal('patch-component'),
        nodeId: Id,
        componentId: Id,
        patches: Type.Array(CanonicalPatch),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        kind: Type.Literal('add-component'),
        nodeId: Id,
        component: GameObjectComponentDefinition,
      },
      { additionalProperties: false },
    ),
    Type.Object(
      { kind: Type.Literal('remove-component'), nodeId: Id, componentId: Id },
      { additionalProperties: false },
    ),
    Type.Object(
      { kind: Type.Literal('set-node-transform'), nodeId: Id, transform: TransformDefinition },
      { additionalProperties: false },
    ),
    Type.Object(
      { kind: Type.Literal('set-node-enabled'), nodeId: Id, enabled: Type.Boolean() },
      { additionalProperties: false },
    ),
  ],
  { $id: 'PrefabPatch' },
);
export type PrefabPatch = Static<typeof PrefabPatch>;

/* -------------------------------------------------------------------------- */
/* Hierarchy                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A node in a Prefab, and its children.
 *
 * Transform is mandatory and intrinsic (§3.3) — not an optional component a
 * malformed GameObject can omit. A node's effective placement is its Prefab
 * transform composed with the Scene instance's root transform, and a missing
 * one would have to mean "identity, probably", which is a default masquerading
 * as data.
 *
 * A child is either inline (this Prefab owns it) or a nested Prefab instance
 * (this Prefab *references* another one). Nested cycles are refused by the
 * registry rather than the schema, because a schema cannot see the other file.
 *
 * Declaration order is deterministic traversal order (§9.7). Sorting by display
 * name would be equally deterministic and would silently reorder a Prefab when
 * a human renamed a node.
 */
export const PrefabNodeDefinition = Type.Recursive(
  (Self) =>
    Type.Object(
      {
        nodeId: Id,
        displayName: Type.String({ minLength: 1, maxLength: 200 }),
        enabled: Type.Boolean(),
        transform: TransformDefinition,
        components: Type.Array(GameObjectComponentDefinition),
        children: Type.Array(
          Type.Union([
            Type.Object(
              { kind: Type.Literal('inline'), node: Self },
              { additionalProperties: false },
            ),
            Type.Object(
              {
                kind: Type.Literal('prefab-instance'),
                instanceId: Id,
                prefab: GameObjectPrefabReference,
                transform: TransformDefinition,
                overrides: Type.Array(PrefabComponentOverride),
              },
              { additionalProperties: false },
            ),
          ]),
        ),
        protection: Type.Optional(ProtectionMetadata),
      },
      { additionalProperties: false },
    ),
  { $id: 'PrefabNodeDefinition' },
);
export type PrefabNodeDefinition = Static<typeof PrefabNodeDefinition>;

export type PrefabChildDefinition = PrefabNodeDefinition['children'][number];

/* -------------------------------------------------------------------------- */
/* Derivation and the asset document                                          */
/* -------------------------------------------------------------------------- */

const BasePrefabDerivation = Type.Object(
  { mode: Type.Literal('base') },
  { additionalProperties: false },
);
const VariantPrefabDerivation = Type.Object(
  {
    mode: Type.Literal('variant'),
    parent: GameObjectPrefabReference,
    patches: Type.Array(PrefabPatch),
  },
  { additionalProperties: false },
);
const ForkPrefabDerivation = Type.Object(
  {
    mode: Type.Literal('fork'),
    forkedFrom: GameObjectPrefabReference,
    forkIntent: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export const PrefabDerivation = Type.Union(
  [BasePrefabDerivation, VariantPrefabDerivation, ForkPrefabDerivation],
  { $id: 'PrefabDerivation' },
);
export type PrefabDerivation = Static<typeof PrefabDerivation>;

/**
 * Whether a Prefab can be placed.
 *
 * An abstract Prefab (§5.9) is a variant parent and nothing else: it cannot be
 * put in a Scene and cannot be instantiated by a game. `humanoid-character-base`
 * is abstract because "a humanoid with no model" is a shape to inherit, not a
 * thing to stand somewhere.
 */
const PREFAB_ABSTRACT_FIELD = { abstract: Type.Boolean() } as const;

export const BaseGameObjectPrefabAsset = Type.Object(
  {
    metadata: GameObjectPrefabMetadata,
    derivation: BasePrefabDerivation,
    ...PREFAB_ABSTRACT_FIELD,
    root: PrefabNodeDefinition,
  },
  { $id: 'BaseGameObjectPrefabAsset', additionalProperties: false },
);
export type BaseGameObjectPrefabAsset = Static<typeof BaseGameObjectPrefabAsset>;

export const ForkGameObjectPrefabAsset = Type.Object(
  {
    metadata: GameObjectPrefabMetadata,
    derivation: ForkPrefabDerivation,
    ...PREFAB_ABSTRACT_FIELD,
    root: PrefabNodeDefinition,
  },
  { $id: 'ForkGameObjectPrefabAsset', additionalProperties: false },
);
export type ForkGameObjectPrefabAsset = Static<typeof ForkGameObjectPrefabAsset>;

/**
 * A variant stores its parent and its patches, and `root` is not a legal key
 * here at all — which is what makes "a variant that is secretly a full copy"
 * unrepresentable rather than merely discouraged. Every node and component a
 * variant has is derived at resolve time from the parent, so a component the
 * parent gains later is visible to every existing variant without touching it.
 */
export const VariantGameObjectPrefabAsset = Type.Object(
  {
    metadata: GameObjectPrefabMetadata,
    derivation: VariantPrefabDerivation,
    ...PREFAB_ABSTRACT_FIELD,
  },
  { $id: 'VariantGameObjectPrefabAsset', additionalProperties: false },
);
export type VariantGameObjectPrefabAsset = Static<typeof VariantGameObjectPrefabAsset>;

/**
 * The stored document.
 *
 * Registered in `SCHEMA_REGISTRY` as its three members rather than as this
 * union: `PrefabNodeDefinition` is recursive, so it carries a `$id` that a
 * `$ref` inside it resolves against, and a union that embedded that `$id` twice
 * would be ambiguous to a JSON Schema validator. Validation dispatches on
 * `derivation.mode`, which is the same discriminator the union uses.
 */
export type GameObjectPrefabAsset =
  | BaseGameObjectPrefabAsset
  | ForkGameObjectPrefabAsset
  | VariantGameObjectPrefabAsset;

/** The three stored shapes, by the discriminator that selects them. */
export const PREFAB_SCHEMA_NAME_BY_DERIVATION = {
  base: 'BaseGameObjectPrefabAsset',
  fork: 'ForkGameObjectPrefabAsset',
  variant: 'VariantGameObjectPrefabAsset',
} as const;

/** A stored Prefab that carries its own root payload, i.e. is not a variant. */
export function prefabHasStoredRoot(
  asset: GameObjectPrefabAsset,
): asset is BaseGameObjectPrefabAsset | ForkGameObjectPrefabAsset {
  return asset.derivation.mode !== 'variant';
}

/* -------------------------------------------------------------------------- */
/* Narrowing helpers                                                          */
/* -------------------------------------------------------------------------- */

export function componentOfType<TType extends GameObjectComponentType>(
  components: readonly GameObjectComponentDefinition[],
  componentType: TType,
): Extract<GameObjectComponentDefinition, { componentType: TType }> | undefined {
  return components.find((component) => component.componentType === componentType) as
    | Extract<GameObjectComponentDefinition, { componentType: TType }>
    | undefined;
}

/**
 * Whether a set of components makes a controllable animated character (§12.3).
 *
 * This function is the replacement for `kind === 'character'`, and the reason
 * the "Character Prefabs" filter is a *derived* view rather than a stored flag.
 */
export function isCharacterComposition(
  components: readonly GameObjectComponentDefinition[],
): boolean {
  return (
    componentOfType(components, 'animator') !== undefined &&
    componentOfType(components, 'character-motor') !== undefined
  );
}
