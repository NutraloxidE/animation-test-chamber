import { Type, type Static } from '@sinclair/typebox';
import { Id, ProtectionMetadata, SchemaVersion, ValueProvenance, Vec3 } from './common.ts';

/** Terrain states usable as transition conditions and blend parameters (PLAN 11.3). */
export const TerrainState = Type.Union(
  [
    Type.Literal('Grounded'),
    Type.Literal('SlopeUp'),
    Type.Literal('SlopeDown'),
    Type.Literal('Sliding'),
    Type.Literal('NearLedge'),
    Type.Literal('SteppingUp'),
    Type.Literal('SteppingDown'),
    Type.Literal('Airborne'),
    Type.Literal('LandingLight'),
    Type.Literal('LandingHeavy'),
    Type.Literal('OnMovingPlatform'),
    Type.Literal('AgainstWall'),
  ],
  { $id: 'TerrainState' },
);
export type TerrainState = Static<typeof TerrainState>;

export const SurfaceMaterial = Type.Object(
  {
    id: Id,
    friction: Type.Number({ minimum: 0, maximum: 2 }),
    /** Multiplies acceleration; ice is low, mud is low with high drag. */
    accelerationScale: Type.Number({ minimum: 0, maximum: 2 }),
    dragScale: Type.Number({ minimum: 0, maximum: 4 }),
  },
  { $id: 'SurfaceMaterial', additionalProperties: false },
);
export type SurfaceMaterial = Static<typeof SurfaceMaterial>;

/**
 * Terrain geometry is declarative so the Web runtime and the Unity adapter can
 * rebuild the identical collision field from canonical data.
 */
export const TerrainFeature = Type.Union(
  [
    Type.Object(
      {
        kind: Type.Literal('plane'),
        height: Type.Number(),
        surface: Id,
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        kind: Type.Literal('slope'),
        /** Slope occupies [startZ, endZ] and rises by `rise` meters across it. */
        startZ: Type.Number(),
        endZ: Type.Number(),
        rise: Type.Number(),
        surface: Id,
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        kind: Type.Literal('steps'),
        startZ: Type.Number(),
        stepDepth: Type.Number({ minimum: 0.05 }),
        stepHeight: Type.Number({ minimum: 0.01 }),
        count: Type.Integer({ minimum: 1, maximum: 64 }),
        surface: Id,
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        kind: Type.Literal('box'),
        center: Vec3,
        size: Vec3,
        surface: Id,
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        kind: Type.Literal('ledge'),
        /** Ground exists only for z <= edgeZ. */
        edgeZ: Type.Number(),
        height: Type.Number(),
        surface: Id,
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        kind: Type.Literal('moving-platform'),
        center: Vec3,
        size: Vec3,
        /** Sinusoidal travel; deterministic from simulation time. */
        axis: Type.Union([Type.Literal('x'), Type.Literal('y'), Type.Literal('z')]),
        amplitude: Type.Number({ minimum: 0, maximum: 20 }),
        periodSec: Type.Number({ minimum: 0.5, maximum: 60 }),
        /** Radians per second about Y. */
        angularVelocity: Type.Number({ minimum: -6.28, maximum: 6.28 }),
        surface: Id,
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        kind: Type.Literal('uneven'),
        /** Deterministic noise field: height = amplitude * sin(fx*x) * cos(fz*z). */
        amplitude: Type.Number({ minimum: 0, maximum: 2 }),
        frequencyX: Type.Number({ minimum: 0.01, maximum: 10 }),
        frequencyZ: Type.Number({ minimum: 0.01, maximum: 10 }),
        surface: Id,
      },
      { additionalProperties: false },
    ),
  ],
  { $id: 'TerrainFeature' },
);
export type TerrainFeature = Static<typeof TerrainFeature>;

export const TerrainPreset = Type.Object(
  {
    schemaVersion: SchemaVersion,
    id: Id,
    label: Type.String(),
    features: Type.Array(TerrainFeature, { minItems: 1 }),
    surfaces: Type.Array(SurfaceMaterial, { minItems: 1 }),
    protection: Type.Optional(ProtectionMetadata),
  },
  { $id: 'TerrainPreset', additionalProperties: false },
);
export type TerrainPreset = Static<typeof TerrainPreset>;

export const TerrainInteractionProfile = Type.Object(
  {
    schemaVersion: SchemaVersion,
    id: Id,
    groundProbeDistance: Type.Number({ minimum: 0.01, maximum: 5 }),
    probeRadius: Type.Number({ minimum: 0.01, maximum: 2 }),
    maxWalkableSlopeRad: Type.Number({ minimum: 0, maximum: 1.5 }),
    slideStartAngleRad: Type.Number({ minimum: 0, maximum: 1.5 }),
    stepUpHeight: Type.Number({ minimum: 0, maximum: 2 }),
    /** 0 = no snap, 1 = fully snapped to ground each tick. */
    groundSnapStrength: Type.Number({ minimum: 0, maximum: 1 }),
    /** Keeps the character attached when running downhill. */
    downhillAdhesion: Type.Number({ minimum: 0, maximum: 1 }),
    /** Speed multiplier applied per radian of slope; negative slows uphill. */
    slopeSpeedCompensation: Type.Number({ minimum: -2, maximum: 2 }),
    bodyTiltStrength: Type.Number({ minimum: 0, maximum: 1 }),
    footIkStrength: Type.Number({ minimum: 0, maximum: 1 }),
    footTargetSmoothing: Type.Number({ minimum: 0, maximum: 1 }),
    pelvisOffsetStrength: Type.Number({ minimum: 0, maximum: 1 }),
    rootMotionTerrainProjection: Type.Boolean(),
    /** Downward speed above which a landing counts as heavy. */
    heavyLandingSpeed: Type.Number({ minimum: 0.1, maximum: 50 }),
    lightLandingSpeed: Type.Number({ minimum: 0.01, maximum: 50 }),
    obstaclePushback: Type.Number({ minimum: 0, maximum: 1 }),
    /** Distance to a drop-off at which NearLedge is reported. */
    ledgeDetectDistance: Type.Number({ minimum: 0, maximum: 3 }),
    movingPlatformVelocityInheritance: Type.Number({ minimum: 0, maximum: 1 }),
    movingPlatformRotationInheritance: Type.Number({ minimum: 0, maximum: 1 }),
    protection: Type.Optional(ProtectionMetadata),
    provenance: Type.Optional(ValueProvenance),
  },
  { $id: 'TerrainInteractionProfile', additionalProperties: false },
);
export type TerrainInteractionProfile = Static<typeof TerrainInteractionProfile>;
