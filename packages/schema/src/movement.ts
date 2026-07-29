import { Type, type Static } from '@sinclair/typebox';
import { Id, ProtectionMetadata, SchemaVersion, ValueProvenance } from './common.ts';
import { RootMotionMode } from './animation.ts';

/** Per-axis authority split used when rootMotionMode is Hybrid (PLAN 10.1). */
export const RootMotionProfile = Type.Object(
  {
    schemaVersion: SchemaVersion,
    id: Id,
    mode: RootMotionMode,
    /** 0 = code drives the axis, 1 = the clip drives it. */
    horizontalAuthority: Type.Number({ minimum: 0, maximum: 1 }),
    verticalAuthority: Type.Number({ minimum: 0, maximum: 1 }),
    rotationAuthority: Type.Number({ minimum: 0, maximum: 1 }),
    /** Project root displacement onto the ground plane before applying it. */
    terrainProjection: Type.Boolean(),
    /** 0 = kinematic, 1 = physics owns the body. Reserved; MVP is kinematic. */
    physicsAuthority: Type.Number({ minimum: 0, maximum: 1 }),
    protection: Type.Optional(ProtectionMetadata),
    provenance: Type.Optional(ValueProvenance),
  },
  { $id: 'RootMotionProfile', additionalProperties: false },
);
export type RootMotionProfile = Static<typeof RootMotionProfile>;

export const MovementProfile = Type.Object(
  {
    schemaVersion: SchemaVersion,
    id: Id,
    walkSpeed: Type.Number({ minimum: 0, maximum: 20 }),
    runSpeed: Type.Number({ minimum: 0, maximum: 40 }),
    acceleration: Type.Number({ minimum: 0.1, maximum: 200 }),
    deceleration: Type.Number({ minimum: 0.1, maximum: 200 }),
    /** Radians per second. */
    rotationSpeed: Type.Number({ minimum: 0.1, maximum: 40 }),
    airControl: Type.Number({ minimum: 0, maximum: 1 }),
    jumpHeight: Type.Number({ minimum: 0.05, maximum: 10 }),
    gravity: Type.Number({ minimum: 0.1, maximum: 100 }),
    coyoteTimeMs: Type.Number({ minimum: 0, maximum: 500 }),
    jumpBufferMs: Type.Number({ minimum: 0, maximum: 500 }),
    stopBehavior: Type.Union([
      Type.Literal('instant'),
      Type.Literal('decelerate'),
      Type.Literal('slide'),
    ]),
    /** How much the character may move while an action-layer state is active. */
    actionMovementAuthority: Type.Number({ minimum: 0, maximum: 1 }),
    momentumRetention: Type.Number({ minimum: 0, maximum: 1 }),
    cameraRelative: Type.Boolean(),
    protection: Type.Optional(ProtectionMetadata),
    provenance: Type.Optional(ValueProvenance),
  },
  { $id: 'MovementProfile', additionalProperties: false },
);
export type MovementProfile = Static<typeof MovementProfile>;

export const CameraProfile = Type.Object(
  {
    schemaVersion: SchemaVersion,
    id: Id,
    distance: Type.Number({ minimum: 0.5, maximum: 40 }),
    height: Type.Number({ minimum: 0, maximum: 20 }),
    /** Vertical offset of the look target above the character root. */
    lookAtHeight: Type.Number({ minimum: 0, maximum: 5 }),
    /** Position smoothing, in seconds to reach ~63% of the target. */
    followLagSec: Type.Number({ minimum: 0, maximum: 2 }),
    minPitchRad: Type.Number({ minimum: -1.5, maximum: 0 }),
    maxPitchRad: Type.Number({ minimum: 0, maximum: 1.5 }),
    fovDeg: Type.Number({ minimum: 20, maximum: 120 }),
    protection: Type.Optional(ProtectionMetadata),
  },
  { $id: 'CameraProfile', additionalProperties: false },
);
export type CameraProfile = Static<typeof CameraProfile>;
