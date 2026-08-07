/**
 * Where a thing stands, and nothing else.
 *
 * Split out of `scene.ts` because a Transform is no longer a Scene concept: a
 * Prefab node has one, a Scene GameObject instance has one, and a Prefab
 * cannot import the Scene contract without the two files importing each other.
 * `scene.ts` re-exports everything here, so no existing import moved.
 */
import { Type, type Static } from '@sinclair/typebox';

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
 * A full composition transform.
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
 * The transform a Prefab node opens at.
 *
 * Distinct from `DEFAULT_SCENE_TRANSFORM` and deliberately at the origin: a
 * Prefab root that defaulted to y=2 would place every instance two metres above
 * wherever the Scene put it, because the two transforms compose. The Scene
 * instance decides where the object stands; the Prefab decides how its own
 * parts sit relative to each other.
 */
export const IDENTITY_TRANSFORM: TransformDefinition = {
  position: { x: 0, y: 0, z: 0 },
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
