/**
 * The canonical Scene contract.
 *
 * A Scene is a *composition*: which entities exist, where they stand, what
 * drives them, and in what order they tick. It is the successor to the
 * multi-instance World document, and the rename is not cosmetic — the old
 * document could only hold character instances, and a scene that cannot hold a
 * light or a camera is not a scene, it is a cast list.
 *
 * The definition/instance split from the World contract survives intact, and is
 * the reason this file has no mutable field anywhere in it:
 *
 *   CharacterDefinition    reusable authored behaviour and animation references
 *   CharacterSceneEntity   one placement + one controller binding of that definition
 *   ControllableCharacter  the runtime instance built from the two (never serialized)
 *
 * A scene document is the same document before and after a million ticks.
 */
import { Type, type Static } from '@sinclair/typebox';
import { Id, ProtectionMetadata, SchemaVersion } from './common.ts';
import { IntentTrackDefinition } from './intent-track.ts';
import { GameObjectPrefabReference, PrefabComponentOverride } from './prefab.ts';
import {
  DEFAULT_SCENE_TRANSFORM,
  IDENTITY_ROTATION,
  IDENTITY_TRANSFORM,
  TransformDefinition,
  UNIT_SCALE,
  quaternionToYaw,
  yawToQuaternion,
} from './transform.ts';

/**
 * The transform contract moved to `transform.ts` when Prefabs gained nodes that
 * also need one. Re-exported here so that every existing `from './scene.ts'`
 * and `from '@atc/schema'` import keeps resolving to the same declaration.
 */
export {
  DEFAULT_SCENE_TRANSFORM,
  IDENTITY_ROTATION,
  IDENTITY_TRANSFORM,
  TransformDefinition,
  UNIT_SCALE,
  quaternionToYaw,
  yawToQuaternion,
};

/**
 * Where an entity's normalized intent comes from.
 *
 * Authored configuration, not a live connection. Nothing here is a socket, a
 * callback, a device handle or a cursor — `SceneRuntime` constructs the
 * concrete `CharacterIntentSource` from this declaration, which is what lets
 * the same scene file open in a browser, in Node, and in a Unity adapter that
 * has never heard of a gamepad API.
 *
 * `ai` carries a channel id rather than reusing `human`, so an observation can
 * still say which side produced a frame after the two have been proven to
 * produce identical behaviour.
 */
export const CharacterControllerBindingDefinition = Type.Union(
  [
    Type.Object(
      { kind: Type.Literal('human'), playerIndex: Type.Integer({ minimum: 0, maximum: 7 }) },
      { additionalProperties: false },
    ),
    Type.Object({ kind: Type.Literal('script'), trackId: Id }, { additionalProperties: false }),
    Type.Object({ kind: Type.Literal('ai'), channelId: Id }, { additionalProperties: false }),
    Type.Object({ kind: Type.Literal('replay'), replayId: Id }, { additionalProperties: false }),
    Type.Object({ kind: Type.Literal('none') }, { additionalProperties: false }),
  ],
  { $id: 'CharacterControllerBindingDefinition' },
);
export type CharacterControllerBindingDefinition = Static<
  typeof CharacterControllerBindingDefinition
>;

/**
 * Entity-scoped overrides of a shared Character Definition.
 *
 * Explicitly enumerated, and deliberately not a patch list. "Override any
 * canonical path" would let one placement rewrite the shared behaviour asset
 * for every other placement referencing it, which is exactly the sharing this
 * contract exists to protect. Every field here is a value the entity holds by
 * itself.
 */
export const CharacterInstanceOverrides = Type.Object(
  {
    /** Movement scale, 1 = the character's authored speed. */
    moveSpeedScale: Type.Optional(Type.Number({ minimum: 0, maximum: 4 })),
    /** Deterministic per-entity RNG seed. */
    seed: Type.Optional(Type.Integer({ minimum: 0, maximum: 2_147_483_647 })),
    /** Weapon/motion context this entity opens in. */
    weaponModeId: Type.Optional(Type.String({ minLength: 1, maxLength: 96 })),
    /** Equipment slot id -> equipped, for slots this entity disagrees with. */
    equipped: Type.Optional(Type.Record(Type.String(), Type.Boolean())),
  },
  { $id: 'CharacterInstanceOverrides', additionalProperties: false },
);
export type CharacterInstanceOverrides = Static<typeof CharacterInstanceOverrides>;

/**
 * A reference to something a prop entity renders.
 *
 * A union of two resolvable forms, and neither of them is a URL a browser
 * happened to mint. `blob:` and `data:` references are refused structurally
 * (`validateSceneReferences`): they resolve exactly once, in the tab that
 * created them, which makes a scene file that contains one a file that looked
 * fine when it was written and is broken for everyone who opens it.
 */
export const SceneAssetReference = Type.Union(
  [
    Type.Object(
      {
        kind: Type.Literal('model'),
        /** Repository-relative model path, e.g. `assets/props/crate.glb`. */
        assetPath: Type.String({ minLength: 1, maxLength: 512 }),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        kind: Type.Literal('asset'),
        assetId: Id,
        version: Type.Optional(Type.String({ minLength: 1, maxLength: 32 })),
      },
      { additionalProperties: false },
    ),
  ],
  { $id: 'SceneAssetReference' },
);
export type SceneAssetReference = Static<typeof SceneAssetReference>;

const SceneEntityBaseFields = {
  schemaVersion: SchemaVersion,
  id: Id,
  displayName: Type.String(),
  /** A disabled entity does not tick and is not rendered. It stays inspectable. */
  enabled: Type.Boolean(),
  transform: TransformDefinition,
  protection: Type.Optional(ProtectionMetadata),
};

/**
 * One use of a Character Definition in one Scene.
 *
 * Holds a placement, a controller binding and explicitly scoped overrides —
 * and nothing else. Rig mapping, behaviour graph contents, motion-set contents
 * and clip contents are named by the Character it references and are never
 * copied here, so two entities on one character genuinely share one authored
 * tuning rather than two copies free to drift apart.
 */
export const CharacterSceneEntity = Type.Object(
  {
    ...SceneEntityBaseFields,
    kind: Type.Literal('character'),
    characterId: Id,
    controller: CharacterControllerBindingDefinition,
    overrides: Type.Optional(CharacterInstanceOverrides),
  },
  { $id: 'CharacterSceneEntity', additionalProperties: false },
);
export type CharacterSceneEntity = Static<typeof CharacterSceneEntity>;

export const PropSceneEntity = Type.Object(
  {
    ...SceneEntityBaseFields,
    kind: Type.Literal('prop'),
    asset: SceneAssetReference,
  },
  { $id: 'PropSceneEntity', additionalProperties: false },
);
export type PropSceneEntity = Static<typeof PropSceneEntity>;

export const LightSceneEntity = Type.Object(
  {
    ...SceneEntityBaseFields,
    kind: Type.Literal('light'),
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
  { $id: 'LightSceneEntity', additionalProperties: false },
);
export type LightSceneEntity = Static<typeof LightSceneEntity>;

/**
 * An authored camera that belongs to the Scene.
 *
 * Deliberately distinct from the editor's viewport camera, which is transient
 * UI state and appears in no document: if the two were one type, orbiting the
 * viewport to look at something would stage a scene edit, and "I only looked at
 * it" would produce a diff.
 */
export const CameraSceneEntity = Type.Object(
  {
    ...SceneEntityBaseFields,
    kind: Type.Literal('camera'),
    projection: Type.Union([Type.Literal('perspective'), Type.Literal('orthographic')]),
    fieldOfViewDeg: Type.Optional(Type.Number({ minimum: 1, maximum: 179 })),
    orthographicSize: Type.Optional(Type.Number({ minimum: 0.01, maximum: 1000 })),
    /** Entity this camera follows, by entity id. */
    targetEntityId: Type.Optional(Id),
  },
  { $id: 'CameraSceneEntity', additionalProperties: false },
);
export type CameraSceneEntity = Static<typeof CameraSceneEntity>;

/**
 * What a scene is made of.
 *
 * A discriminated union rather than a universal component bag. A general ECS
 * would express all four of these and every future kind, and would also make
 * "what fields does this entity have?" a question with no answer a schema can
 * give — which is the question the Inspector, the validator, the Unity exporter
 * and the apply transaction each have to answer before they can do anything.
 */
export const SceneEntityDefinition = Type.Union(
  [CharacterSceneEntity, PropSceneEntity, LightSceneEntity, CameraSceneEntity],
  { $id: 'SceneEntityDefinition' },
);
export type SceneEntityDefinition = Static<typeof SceneEntityDefinition>;

/* -------------------------------------------------------------------------- */
/* GameObject instances (work package §6)                                     */
/* -------------------------------------------------------------------------- */

/**
 * How this instance connects to the Scene and the runtime.
 *
 * A binding is authored configuration, not a live connection — the same
 * reasoning as `CharacterControllerBindingDefinition`, which it wraps. It sits
 * on the *instance* rather than in the Prefab because "player one drives this
 * one" is a fact about one placement in one Scene, and a Prefab that carried it
 * could be placed exactly once.
 *
 * Only an object whose resolved Prefab contains a `character-motor` may carry
 * `characterIntent` (§6.1); the registry refuses the rest.
 */
export const GameObjectInstanceBindings = Type.Object(
  {
    characterIntent: Type.Optional(CharacterControllerBindingDefinition),
  },
  { $id: 'GameObjectInstanceBindings', additionalProperties: false },
);
export type GameObjectInstanceBindings = Static<typeof GameObjectInstanceBindings>;

/**
 * How this instance points at *other* instances.
 *
 * Stable GameObject ids, never indexes (§6.2): an index relation breaks the
 * moment anything is reordered, and reordering is a first-class Scene
 * operation. Only an object with a Camera Component may carry a camera target.
 */
export const GameObjectInstanceRelations = Type.Object(
  {
    cameraTargetGameObjectId: Type.Optional(Id),
  },
  { $id: 'GameObjectInstanceRelations', additionalProperties: false },
);
export type GameObjectInstanceRelations = Static<typeof GameObjectInstanceRelations>;

/**
 * One placement of one Prefab version in one Scene.
 *
 * This single type replaces the four-branch entity union. There is no `kind`:
 * what the object *is* comes from the Components its resolved Prefab carries,
 * so a Camera, a Light, an animated prop and a character carrying a lantern are
 * all this shape, and adding the next capability adds a Component rather than a
 * fifth branch here.
 *
 * The Prefab reference is exact (§3.5) — type, id, version and content hash —
 * so a Scene cannot drift onto a Prefab version nobody approved.
 */
export const GameObjectInstanceDefinition = Type.Object(
  {
    schemaVersion: SchemaVersion,
    id: Id,
    displayName: Type.String(),
    /** A disabled object does not tick and is not rendered. It stays inspectable. */
    enabled: Type.Boolean(),
    prefab: GameObjectPrefabReference,
    transform: TransformDefinition,
    /** Instance-scoped component overrides, addressed by stable node/component id. */
    componentOverrides: Type.Array(PrefabComponentOverride),
    bindings: GameObjectInstanceBindings,
    relations: GameObjectInstanceRelations,
    protection: Type.Optional(ProtectionMetadata),
  },
  { $id: 'GameObjectInstanceDefinition', additionalProperties: false },
);
export type GameObjectInstanceDefinition = Static<typeof GameObjectInstanceDefinition>;

/**
 * What the Scene Asset Panel can place (§6.4).
 *
 * One thing, not four. "Place a Light" and "place a Character" were different
 * actions producing different entity kinds; they are now the same action
 * producing the same instance type, differing only in which Prefab it names.
 */
export const PlaceablePrefabAsset = Type.Object(
  { kind: Type.Literal('prefab'), prefab: GameObjectPrefabReference },
  { $id: 'PlaceablePrefabAsset', additionalProperties: false },
);
export type PlaceablePrefabAsset = Static<typeof PlaceablePrefabAsset>;

export const SceneDefinition = Type.Object(
  {
    schemaVersion: SchemaVersion,
    id: Id,
    displayName: Type.String(),
    /**
     * Declaration order is tick order (DECISION 0009). Sorting by id would be
     * equally deterministic and much harder to author against: a human who
     * renamed an entity would silently reorder the scene.
     *
     * @deprecated The entity-kind union is superseded by `gameObjects`
     * (DECISION 0020). It is still the field the current runtime, renderer and
     * Unity exporter read; see the migration audit for what remains to move.
     */
    entities: Type.Array(SceneEntityDefinition),
    /**
     * Every GameObject instance in the Scene, in declaration order.
     *
     * Optional *only* for the length of the migration: `pnpm prefabs:migrate`
     * derives it from `entities`, and the two are checked against each other by
     * `harness:game-objects` so a Scene cannot be edited through one view and
     * silently disagree with the other.
     */
    gameObjects: Type.Optional(Type.Array(GameObjectInstanceDefinition)),
    intentTracks: Type.Array(IntentTrackDefinition),
    /** Which camera entity the scene plays through. Optional: an editor viewport suffices. */
    activeCameraEntityId: Type.Optional(Id),
    /** The GameObject-instance spelling of `activeCameraEntityId`. */
    activeCameraGameObjectId: Type.Optional(Id),
    protection: Type.Optional(ProtectionMetadata),
  },
  { $id: 'SceneDefinition', additionalProperties: false },
);
export type SceneDefinition = Static<typeof SceneDefinition>;

/**
 * What the Asset Panel can place. Not every asset kind is placeable.
 */
export const PlaceableAsset = Type.Union(
  [
    Type.Object(
      { kind: Type.Literal('character'), characterId: Id },
      { additionalProperties: false },
    ),
    Type.Object(
      { kind: Type.Literal('prop'), asset: SceneAssetReference },
      { additionalProperties: false },
    ),
    Type.Object(
      { kind: Type.Literal('light'), lightType: LightSceneEntity.properties.lightType },
      { additionalProperties: false },
    ),
    Type.Object({ kind: Type.Literal('camera') }, { additionalProperties: false }),
  ],
  { $id: 'PlaceableAsset' },
);
export type PlaceableAsset = Static<typeof PlaceableAsset>;

const DisplayName = Type.String({ minLength: 1, maxLength: 200 });

/**
 * The typed repository operations, as a *runtime* contract.
 *
 * The TypeScript union alone is a compile-time claim about a client that the
 * server has no way to check: `POST /api/repository/apply` receives JSON, and a
 * cast is not a check. Anything the server cannot describe as one of these — an
 * unknown `type`, a missing field, an extra field — has to be refused by name,
 * because an operation the server half-understands is the one that writes a
 * document nobody asked for.
 *
 * `additionalProperties: false` throughout is the load-bearing part: it is what
 * makes a typo'd field a refusal rather than a silently ignored intent.
 */
export const SceneOperation = Type.Union(
  [
    Type.Object(
      { type: Type.Literal('scene.rename'), displayName: DisplayName },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        type: Type.Literal('scene.place_asset'),
        entityId: Id,
        displayName: DisplayName,
        asset: PlaceableAsset,
        transform: Type.Optional(TransformDefinition),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      { type: Type.Literal('scene.delete_entity'), entityId: Id },
      { additionalProperties: false },
    ),
    Type.Object(
      { type: Type.Literal('scene.duplicate_entity'), entityId: Id },
      { additionalProperties: false },
    ),
    Type.Object(
      { type: Type.Literal('scene.rename_entity'), entityId: Id, displayName: DisplayName },
      { additionalProperties: false },
    ),
    Type.Object(
      { type: Type.Literal('scene.set_transform'), entityId: Id, transform: TransformDefinition },
      { additionalProperties: false },
    ),
    Type.Object(
      { type: Type.Literal('scene.set_enabled'), entityId: Id, enabled: Type.Boolean() },
      { additionalProperties: false },
    ),
    Type.Object(
      { type: Type.Literal('scene.set_character_source'), entityId: Id, characterId: Id },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        type: Type.Literal('scene.bind_controller'),
        entityId: Id,
        controller: CharacterControllerBindingDefinition,
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        type: Type.Literal('scene.reorder_entity'),
        entityId: Id,
        toIndex: Type.Integer({ minimum: 0 }),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        type: Type.Literal('scene.set_active_camera'),
        entityId: Type.Union([Id, Type.Null()]),
      },
      { additionalProperties: false },
    ),
  ],
  { $id: 'SceneOperation' },
);
export type SceneOperation = Static<typeof SceneOperation>;

/**
 * The GameObject-based repository operations (§6.5).
 *
 * Every kind-specific operation collapses: `scene.place_asset` with a
 * four-branch payload becomes `scene.place_prefab`, and
 * `scene.set_character_source` plus `scene.bind_controller` become
 * `scene.set_prefab_source` and `scene.set_instance_binding` — which work for a
 * light and a camera too, because there is nothing character-shaped about
 * "point this instance at a different Prefab".
 *
 * `additionalProperties: false` throughout, for the same reason as
 * `SceneOperation`: a typo'd field must be a refusal, not a silently ignored
 * intent.
 */
export const GameObjectSceneOperation = Type.Union(
  [
    Type.Object(
      {
        type: Type.Literal('scene.place_prefab'),
        gameObjectId: Id,
        displayName: DisplayName,
        prefab: GameObjectPrefabReference,
        transform: Type.Optional(TransformDefinition),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      { type: Type.Literal('scene.delete_game_object'), gameObjectId: Id },
      { additionalProperties: false },
    ),
    Type.Object(
      { type: Type.Literal('scene.duplicate_game_object'), gameObjectId: Id },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        type: Type.Literal('scene.rename_game_object'),
        gameObjectId: Id,
        displayName: DisplayName,
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        type: Type.Literal('scene.set_transform'),
        gameObjectId: Id,
        transform: TransformDefinition,
      },
      { additionalProperties: false },
    ),
    Type.Object(
      { type: Type.Literal('scene.set_enabled'), gameObjectId: Id, enabled: Type.Boolean() },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        type: Type.Literal('scene.set_prefab_source'),
        gameObjectId: Id,
        prefab: GameObjectPrefabReference,
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        type: Type.Literal('scene.set_component_override'),
        gameObjectId: Id,
        override: PrefabComponentOverride,
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        type: Type.Literal('scene.clear_component_override'),
        gameObjectId: Id,
        nodeId: Id,
        componentId: Id,
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        type: Type.Literal('scene.set_instance_binding'),
        gameObjectId: Id,
        bindings: GameObjectInstanceBindings,
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        type: Type.Literal('scene.set_relation'),
        gameObjectId: Id,
        relations: GameObjectInstanceRelations,
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        type: Type.Literal('scene.reorder_game_object'),
        gameObjectId: Id,
        toIndex: Type.Integer({ minimum: 0 }),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        type: Type.Literal('scene.set_active_camera'),
        gameObjectId: Type.Union([Id, Type.Null()]),
      },
      { additionalProperties: false },
    ),
  ],
  { $id: 'GameObjectSceneOperation' },
);
export type GameObjectSceneOperation = Static<typeof GameObjectSceneOperation>;

/** The GameObject instance with this id, or undefined. Never an index lookup. */
export function sceneGameObject(
  scene: SceneDefinition,
  gameObjectId: string,
): GameObjectInstanceDefinition | undefined {
  return scene.gameObjects?.find((gameObject) => gameObject.id === gameObjectId);
}

/** Narrowing helper; used wherever only character entities are relevant. */
export function isCharacterEntity(
  entity: SceneEntityDefinition,
): entity is CharacterSceneEntity {
  return entity.kind === 'character';
}

/** The entity with this id, or undefined. Never an index lookup. */
export function sceneEntity(
  scene: SceneDefinition,
  entityId: string,
): SceneEntityDefinition | undefined {
  return scene.entities.find((entity) => entity.id === entityId);
}

/** The scene with this id, or undefined. Route identity is authoritative. */
export function sceneById(
  scenes: readonly SceneDefinition[],
  sceneId: string,
): SceneDefinition | undefined {
  return scenes.find((scene) => scene.id === sceneId);
}
