import { Type, type Static } from '@sinclair/typebox';
import {
  CurveKind,
  Id,
  NormalizedTime,
  NormalizedWindow,
  ProtectionMetadata,
  SchemaVersion,
  ValueProvenance,
  Vec3,
} from './common.ts';

/** Semantic events (PLAN 12.1). Hitbox, audio, VFX and haptics all reference these. */
export const SemanticEventKind = Type.Union(
  [
    Type.Literal('FootContactLeft'),
    Type.Literal('FootContactRight'),
    Type.Literal('AttackWindup'),
    Type.Literal('AttackHit'),
    Type.Literal('AttackRecoil'),
    Type.Literal('JumpTakeoff'),
    Type.Literal('Landing'),
    Type.Literal('DamageReceived'),
    Type.Literal('DodgeStart'),
    Type.Literal('DodgeEnd'),
    Type.Literal('GuardImpact'),
  ],
  { $id: 'SemanticEventKind' },
);
export type SemanticEventKind = Static<typeof SemanticEventKind>;

export const SemanticEventDefinition = Type.Object(
  {
    id: Id,
    kind: SemanticEventKind,
    /** Position within the owning clip, normalized. */
    at: NormalizedTime,
    payload: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    protection: Type.Optional(ProtectionMetadata),
  },
  { $id: 'SemanticEventDefinition', additionalProperties: false },
);
export type SemanticEventDefinition = Static<typeof SemanticEventDefinition>;

export const SkeletonBone = Type.Object(
  {
    name: Type.String(),
    parent: Type.Union([Type.String(), Type.Null()]),
    /** Canonical humanoid slot this bone maps to, if any. */
    humanoid: Type.Optional(Type.String()),
    restPosition: Vec3,
  },
  { $id: 'SkeletonBone', additionalProperties: false },
);
export type SkeletonBone = Static<typeof SkeletonBone>;

export const SkeletonDefinition = Type.Object(
  {
    schemaVersion: SchemaVersion,
    id: Id,
    /** Meters from foot to top of head; used to normalize retargeted clips. */
    height: Type.Number({ minimum: 0.1, maximum: 10 }),
    bones: Type.Array(SkeletonBone),
    leftFootBone: Type.String(),
    rightFootBone: Type.String(),
    hipsBone: Type.String(),
  },
  { $id: 'SkeletonDefinition', additionalProperties: false },
);
export type SkeletonDefinition = Static<typeof SkeletonDefinition>;

/** How a clip's root displacement is authored. */
export const RootMotionMode = Type.Union(
  [Type.Literal('InPlace'), Type.Literal('RootMotion'), Type.Literal('Hybrid')],
  { $id: 'RootMotionMode' },
);
export type RootMotionMode = Static<typeof RootMotionMode>;

export const AnimationClipDefinition = Type.Object(
  {
    schemaVersion: SchemaVersion,
    id: Id,
    /** Asset reference, or null when the procedural fallback clip is used. */
    assetPath: Type.Union([Type.String(), Type.Null()]),
    /** Procedural generator name used when assetPath is null. */
    proceduralGenerator: Type.Optional(Type.String()),
    durationSec: Type.Number({ minimum: 0.01, maximum: 120 }),
    loop: Type.Boolean(),
    /** Authored root displacement over the whole clip, in meters. */
    rootDisplacement: Vec3,
    rootMotionMode: RootMotionMode,
    events: Type.Array(SemanticEventDefinition),
    /** Normalized times at which each foot is planted. Drives foot-IK and metrics. */
    footContacts: Type.Object(
      {
        left: Type.Array(NormalizedWindow),
        right: Type.Array(NormalizedWindow),
      },
      { additionalProperties: false },
    ),
    protection: Type.Optional(ProtectionMetadata),
    provenance: Type.Optional(ValueProvenance),
  },
  { $id: 'AnimationClipDefinition', additionalProperties: false },
);
export type AnimationClipDefinition = Static<typeof AnimationClipDefinition>;

export const ConditionOperator = Type.Union(
  [
    Type.Literal('equals'),
    Type.Literal('notEquals'),
    Type.Literal('greaterThan'),
    Type.Literal('lessThan'),
    Type.Literal('greaterOrEqual'),
    Type.Literal('lessOrEqual'),
    Type.Literal('buffered'),
  ],
  { $id: 'ConditionOperator' },
);
export type ConditionOperator = Static<typeof ConditionOperator>;

export const TransitionCondition = Type.Object(
  {
    parameter: Type.String({ minLength: 1 }),
    operator: ConditionOperator,
    value: Type.Union([Type.Number(), Type.Boolean(), Type.String()]),
  },
  { $id: 'TransitionCondition', additionalProperties: false },
);
export type TransitionCondition = Static<typeof TransitionCondition>;

export const TransitionDefinition = Type.Object(
  {
    schemaVersion: SchemaVersion,
    id: Id,
    /** Source state id, or "*" for a limited global interrupt (PLAN 7.1). */
    from: Type.String({ minLength: 1 }),
    to: Id,
    conditions: Type.Array(TransitionCondition),
    blendDurationSec: Type.Number({ minimum: 0, maximum: 2 }),
    /** Where in the destination clip playback begins. */
    startOffsetNormalized: NormalizedTime,
    /** Earliest normalized time in the source state at which this may fire. */
    exitTimeNormalized: Type.Optional(NormalizedTime),
    playbackSpeed: Type.Number({ minimum: 0.05, maximum: 4 }),
    /** Fraction of horizontal velocity carried across the transition. */
    momentumRetention: Type.Number({ minimum: 0, maximum: 1 }),
    /** How much the character may steer during the destination state. */
    rotationAuthority: Type.Number({ minimum: 0, maximum: 1 }),
    /** May this transition itself be interrupted while blending. */
    interruptible: Type.Boolean(),
    /** How long an unconsumed input stays eligible for this transition. */
    inputBufferMs: Type.Number({ minimum: 0, maximum: 1000 }),
    /**
     * Window in the SOURCE state's normalized time during which this transition
     * may fire. This is what makes combo cancels and late dodge-cancels work:
     * attack-01 -> attack-02 with {0.35, 0.75} is cancellable only mid-swing.
     */
    cancelWindow: Type.Optional(NormalizedWindow),
    priority: Type.Integer({ minimum: 0, maximum: 1000 }),
    rootMotionMode: Type.Optional(RootMotionMode),
    protection: Type.Optional(ProtectionMetadata),
    provenance: Type.Optional(ValueProvenance),
  },
  { $id: 'TransitionDefinition', additionalProperties: false },
);
export type TransitionDefinition = Static<typeof TransitionDefinition>;

export const StateDefinition = Type.Object(
  {
    schemaVersion: SchemaVersion,
    id: Id,
    clipId: Id,
    layer: Type.Union([Type.Literal('locomotion'), Type.Literal('action')]),
    loop: Type.Boolean(),
    speed: Type.Number({ minimum: 0.05, maximum: 4 }),
    /** Seconds after which the state force-exits. 0 disables. */
    timeoutSec: Type.Number({ minimum: 0, maximum: 60 }),
    /** State entered when the clip finishes and no transition matched. */
    fallbackState: Type.Optional(Id),
    /** May a transition re-enter this state from itself. */
    allowReEntry: Type.Boolean(),
    interruptible: Type.Boolean(),
    /** Reserved upper/lower body mask structure (PLAN 7.1). */
    bodyMask: Type.Optional(
      Type.Union([Type.Literal('full'), Type.Literal('upper'), Type.Literal('lower')]),
    ),
    protection: Type.Optional(ProtectionMetadata),
  },
  { $id: 'StateDefinition', additionalProperties: false },
);
export type StateDefinition = Static<typeof StateDefinition>;

export const LayerDefinition = Type.Object(
  {
    id: Type.Union([Type.Literal('locomotion'), Type.Literal('action')]),
    /** Higher index composites on top. */
    order: Type.Integer({ minimum: 0, maximum: 8 }),
    defaultState: Id,
    /** Weight of this layer when a non-default state is active. */
    weight: Type.Number({ minimum: 0, maximum: 1 }),
    bodyMask: Type.Union([Type.Literal('full'), Type.Literal('upper'), Type.Literal('lower')]),
  },
  { $id: 'LayerDefinition', additionalProperties: false },
);
export type LayerDefinition = Static<typeof LayerDefinition>;

export const AnimationGraphDefinition = Type.Object(
  {
    schemaVersion: SchemaVersion,
    id: Id,
    layers: Type.Array(LayerDefinition, { minItems: 1 }),
    states: Type.Array(StateDefinition, { minItems: 1 }),
    transitions: Type.Array(TransitionDefinition),
    /**
     * Forced-transition ordering (PLAN 7.1). Earlier entries win. Death is
     * reserved even though the MVP has no death state.
     */
    forcedTransitionOrder: Type.Array(Type.String(), { minItems: 1 }),
    protection: Type.Optional(ProtectionMetadata),
  },
  { $id: 'AnimationGraphDefinition', additionalProperties: false },
);
export type AnimationGraphDefinition = Static<typeof AnimationGraphDefinition>;

export { CurveKind };
