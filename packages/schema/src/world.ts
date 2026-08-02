/**
 * Canonical multi-instance world contract.
 *
 * A `CharacterDefinition` is a reusable *definition*. A `RuntimeInstanceDefinition`
 * is a *use* of one: a placement, an identity, an intent binding, and an
 * explicitly scoped set of overrides. Two instances may reference the same
 * character — and therefore the same behaviour, motion set, rig, tuning and
 * clips — without either one copying a byte of it.
 *
 * Nothing mutable lives here. Clocks, active states, buffered inputs, velocity
 * and root-motion accumulation belong to the runtime, which is why this file
 * has no field that could hold them: a world document is the same document
 * before and after a million ticks.
 */
import { Type, type Static } from '@sinclair/typebox';
import { Id, ProtectionMetadata, SchemaVersion, Vec3 } from './common.ts';
import { BUTTON_ACTIONS } from './input.ts';

/** Bounds keep a transform finite *and* inside a space a camera can find. */
const WORLD_COORD = Type.Number({ minimum: -10000, maximum: 10000 });

export const TransformDefinition = Type.Object(
  {
    position: Vec3,
    /** Radians. Pitch and roll are deliberately absent: the runtime is yaw-only. */
    yawRad: Type.Number({ minimum: -1000, maximum: 1000 }),
  },
  { $id: 'TransformDefinition', additionalProperties: false },
);
export type TransformDefinition = Static<typeof TransformDefinition>;

/**
 * What an instance is made of.
 *
 * A discriminated union with one member today. The union is the point: a later
 * source kind (a prop, a camera rig, a spawner) is an added member rather than
 * a replaced contract. Speculative members are *not* added here — an unused
 * variant is a contract nobody has had to honour.
 */
export const RuntimeInstanceSource = Type.Union(
  [
    Type.Object(
      { kind: Type.Literal('character'), characterId: Id },
      { additionalProperties: false },
    ),
  ],
  { $id: 'RuntimeInstanceSource' },
);
export type RuntimeInstanceSource = Static<typeof RuntimeInstanceSource>;

/**
 * Where an instance's normalized intent comes from.
 *
 * These are *sources*, not behaviours. `scripted-track` in particular is a
 * deterministic composition and test primitive; it samples authored data and
 * has no opinion about what the instance should do next. Anything that decides
 * would be a behaviour system, which this package does not have.
 */
export const IntentSourceDefinition = Type.Union(
  [
    Type.Object(
      { kind: Type.Literal('local-input'), playerIndex: Type.Integer({ minimum: 0, maximum: 7 }) },
      { additionalProperties: false },
    ),
    Type.Object(
      { kind: Type.Literal('scripted-track'), trackId: Id },
      { additionalProperties: false },
    ),
    Type.Object({ kind: Type.Literal('replay'), replayId: Id }, { additionalProperties: false }),
    Type.Object({ kind: Type.Literal('none') }, { additionalProperties: false }),
  ],
  { $id: 'IntentSourceDefinition' },
);
export type IntentSourceDefinition = Static<typeof IntentSourceDefinition>;

const ButtonMap = Type.Object(
  Object.fromEntries(BUTTON_ACTIONS.map((action) => [action, Type.Optional(Type.Boolean())])),
  { additionalProperties: false },
);

/**
 * One authored point on an intent track.
 *
 * Keyed by simulation tick, never by milliseconds: a track sampled from
 * wall-clock time would produce different intent on a 30Hz laptop and a 144Hz
 * desktop, and the whole reason this type exists is that it must not.
 */
export const IntentTrackKeyframe = Type.Object(
  {
    tick: Type.Integer({ minimum: 0, maximum: 1_000_000 }),
    move: Type.Optional(
      Type.Object(
        { x: Type.Number({ minimum: -1, maximum: 1 }), y: Type.Number({ minimum: -1, maximum: 1 }) },
        { additionalProperties: false },
      ),
    ),
    look: Type.Optional(
      Type.Object(
        { x: Type.Number({ minimum: -1, maximum: 1 }), y: Type.Number({ minimum: -1, maximum: 1 }) },
        { additionalProperties: false },
      ),
    ),
    buttons: Type.Optional(ButtonMap),
  },
  { $id: 'IntentTrackKeyframe', additionalProperties: false },
);
export type IntentTrackKeyframe = Static<typeof IntentTrackKeyframe>;

/**
 * A deterministic authored intent track.
 *
 * Sampling holds the last keyframe's values until the next one (DECISION 0009):
 * step semantics, not interpolation. Interpolating analog sticks would be
 * defensible; interpolating a button press is not, and a track where the two
 * halves obeyed different rules would be a track nobody could read. Holding is
 * the rule that is the same for every field.
 */
export const IntentTrackDefinition = Type.Object(
  {
    schemaVersion: SchemaVersion,
    id: Id,
    displayName: Type.String(),
    loop: Type.Boolean(),
    durationTicks: Type.Integer({ minimum: 1, maximum: 1_000_000 }),
    keyframes: Type.Array(IntentTrackKeyframe, { minItems: 1 }),
    protection: Type.Optional(ProtectionMetadata),
  },
  { $id: 'IntentTrackDefinition', additionalProperties: false },
);
export type IntentTrackDefinition = Static<typeof IntentTrackDefinition>;

/**
 * Instance-scoped overrides.
 *
 * Explicitly enumerated, and deliberately not a patch list. "Override any
 * canonical path" would let an instance rewrite the shared behaviour asset for
 * everyone referencing it, which is exactly the sharing this contract exists to
 * protect. Every field here is a value the instance holds by itself.
 */
export const RuntimeInstanceOverrides = Type.Object(
  {
    /** Movement scale, 1 = the character's authored speed. */
    moveSpeedScale: Type.Optional(Type.Number({ minimum: 0, maximum: 4 })),
    /** Deterministic per-instance RNG seed. */
    seed: Type.Optional(Type.Integer({ minimum: 0, maximum: 2_147_483_647 })),
    /** Weapon/motion context this instance opens in. */
    weaponModeId: Type.Optional(Type.String({ minLength: 1, maxLength: 96 })),
    /** Equipment slot id -> equipped, for slots this instance disagrees with. */
    equipped: Type.Optional(Type.Record(Type.String(), Type.Boolean())),
  },
  { $id: 'RuntimeInstanceOverrides', additionalProperties: false },
);
export type RuntimeInstanceOverrides = Static<typeof RuntimeInstanceOverrides>;

export const RuntimeInstanceDefinition = Type.Object(
  {
    schemaVersion: SchemaVersion,
    id: Id,
    displayName: Type.String(),
    source: RuntimeInstanceSource,
    transform: TransformDefinition,
    intentSource: IntentSourceDefinition,
    /** A disabled instance does not tick. It stays inspectable. */
    enabled: Type.Boolean(),
    overrides: Type.Optional(RuntimeInstanceOverrides),
    protection: Type.Optional(ProtectionMetadata),
  },
  { $id: 'RuntimeInstanceDefinition', additionalProperties: false },
);
export type RuntimeInstanceDefinition = Static<typeof RuntimeInstanceDefinition>;

export const WorldDefinition = Type.Object(
  {
    schemaVersion: SchemaVersion,
    id: Id,
    displayName: Type.String(),
    /**
     * Declaration order is tick order (DECISION 0009). Sorting by id would
     * have been equally deterministic and much harder to author against: a
     * human who renames an instance would silently reorder the world.
     */
    instances: Type.Array(RuntimeInstanceDefinition, { minItems: 1 }),
    intentTracks: Type.Array(IntentTrackDefinition),
    /** Which instance the focused (single-character) chamber view opens on. */
    focusedInstanceId: Id,
    cameraTargetInstanceId: Id,
    protection: Type.Optional(ProtectionMetadata),
  },
  { $id: 'WorldDefinition', additionalProperties: false },
);
export type WorldDefinition = Static<typeof WorldDefinition>;

/** The transform a synthesized legacy instance opens at. */
export const DEFAULT_INSTANCE_TRANSFORM: TransformDefinition = {
  position: { x: 0, y: 2, z: 0 },
  yawRad: 0,
};
