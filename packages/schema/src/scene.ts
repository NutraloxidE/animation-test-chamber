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

/** Bounds keep a transform finite *and* inside a space a camera can find. */
const SCENE_COORD = Type.Number({ minimum: -10000, maximum: 10000 });

/**
 * A unit quaternion component.
 *
 * Bounded to [-1, 1] because that is the only range a unit quaternion can
 * occupy. The bound does not prove the quaternion is normalized — nothing a
 * JSON Schema can say does — so `validateSceneReferences` checks the magnitude
 * separately. Both exist: the bound catches garbage cheaply, the magnitude
 * check catches the plausible-looking rotation that would silently scale
 * everything it touches.
 */
const QUAT_COMPONENT = Type.Number({ minimum: -1, maximum: 1 });

/** Scale is positive and bounded; a zero or negative axis flips or erases geometry. */
const SCALE_COMPONENT = Type.Number({ minimum: 0.001, maximum: 1000 });

/**
 * A full scene-composition transform.
 *
 * Wider than the World contract's position-plus-yaw, deliberately. The old
 * transform was yaw-only because the *runtime* is yaw-only, which conflated
 * what a character can do with what a scene can express — a prop that cannot be
 * tilted and a light that cannot be aimed are not modelling decisions, they are
 * a locomotion constraint that leaked into the document.
 *
 * The runtime stays yaw-only. `SceneRuntime` derives yaw from this quaternion
 * when it constructs a `Simulation`; the authored rotation is never discarded
 * to make that easier.
 */
export const TransformDefinition = Type.Object(
  {
    position: Type.Object(
      { x: SCENE_COORD, y: SCENE_COORD, z: SCENE_COORD },
      { additionalProperties: false },
    ),
    rotation: Type.Object(
      { x: QUAT_COMPONENT, y: QUAT_COMPONENT, z: QUAT_COMPONENT, w: QUAT_COMPONENT },
      { additionalProperties: false },
    ),
    scale: Type.Object(
      { x: SCALE_COMPONENT, y: SCALE_COMPONENT, z: SCALE_COMPONENT },
      { additionalProperties: false },
    ),
  },
  { $id: 'TransformDefinition', additionalProperties: false },
);
export type TransformDefinition = Static<typeof TransformDefinition>;

export const IDENTITY_ROTATION: TransformDefinition['rotation'] = { x: 0, y: 0, z: 0, w: 1 };
export const UNIT_SCALE: TransformDefinition['scale'] = { x: 1, y: 1, z: 1 };

/** The transform a newly created or migrated entity opens at. */
export const DEFAULT_SCENE_TRANSFORM: TransformDefinition = {
  position: { x: 0, y: 2, z: 0 },
  rotation: { ...IDENTITY_ROTATION },
  scale: { ...UNIT_SCALE },
};

/**
 * A rotation about world Y, as a unit quaternion.
 *
 * The migration path from the World contract's `yawRad`, and the only one: a
 * legacy yaw must land on exactly one quaternion or the migration is not
 * deterministic, and two callers rounding it differently is precisely how
 * "idempotent" quietly stops being true.
 */
export function yawToQuaternion(yawRad: number): TransformDefinition['rotation'] {
  const half = yawRad / 2;
  return { x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) };
}

/**
 * The yaw a runtime should spawn at, recovered from an authored quaternion.
 *
 * Exact inverse of `yawToQuaternion` for rotations about Y, and a best-effort
 * projection for any other rotation: a prop tilted on X has no yaw a yaw-only
 * locomotion runtime can honour, and reporting the Y component of its swing is
 * a more useful answer than refusing to spawn it.
 */
export function quaternionToYaw(rotation: TransformDefinition['rotation']): number {
  const { x, y, z, w } = rotation;
  return Math.atan2(2 * (w * y + x * z), 1 - 2 * (y * y + z * z));
}

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

export const SceneDefinition = Type.Object(
  {
    schemaVersion: SchemaVersion,
    id: Id,
    displayName: Type.String(),
    /**
     * Declaration order is tick order (DECISION 0009). Sorting by id would be
     * equally deterministic and much harder to author against: a human who
     * renamed an entity would silently reorder the scene.
     */
    entities: Type.Array(SceneEntityDefinition),
    intentTracks: Type.Array(IntentTrackDefinition),
    /** Which camera entity the scene plays through. Optional: an editor viewport suffices. */
    activeCameraEntityId: Type.Optional(Id),
    protection: Type.Optional(ProtectionMetadata),
  },
  { $id: 'SceneDefinition', additionalProperties: false },
);
export type SceneDefinition = Static<typeof SceneDefinition>;

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
