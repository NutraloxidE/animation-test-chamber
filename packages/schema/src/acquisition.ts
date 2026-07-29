import { Type, type Static } from '@sinclair/typebox';
import { Id, SchemaVersion } from './common.ts';

/**
 * Tri-state on purpose. An unknown licence term is never silently promoted to
 * `allowed` (PLAN 15.6), and `unknown` blocks raw-asset commits to a public repo.
 */
export const LicenseFlag = Type.Union(
  [Type.Literal('allowed'), Type.Literal('forbidden'), Type.Literal('unknown')],
  { $id: 'LicenseFlag' },
);
export type LicenseFlag = Static<typeof LicenseFlag>;

export const LicenseManifest = Type.Object(
  {
    schemaVersion: SchemaVersion,
    provider: Type.String({ minLength: 1 }),
    sourceType: Type.Union([
      Type.Literal('search'),
      Type.Literal('generate'),
      Type.Literal('capture'),
      Type.Literal('import'),
    ]),
    sourceRef: Type.String(),
    acquiredBy: Type.String({ minLength: 1 }),
    acquiredAt: Type.String({ minLength: 1 }),
    commercialUse: LicenseFlag,
    rawAssetRedistribution: LicenseFlag,
    teamSharing: LicenseFlag,
    publicRepository: LicenseFlag,
    attributionRequired: LicenseFlag,
    attributionText: Type.Optional(Type.String()),
    verificationStatus: Type.Union([
      Type.Literal('unverified'),
      Type.Literal('human-verified'),
    ]),
    notes: Type.Optional(Type.String()),
  },
  { $id: 'LicenseManifest', additionalProperties: false },
);
export type LicenseManifest = Static<typeof LicenseManifest>;

export const AssetProvenance = Type.Object(
  {
    schemaVersion: SchemaVersion,
    /** sha256 of the raw imported bytes. */
    contentHash: Type.String({ minLength: 8 }),
    originalFilename: Type.String(),
    originalFormat: Type.Union([
      Type.Literal('glb'),
      Type.Literal('gltf'),
      Type.Literal('fbx'),
      Type.Literal('bvh'),
    ]),
    importedAt: Type.String(),
    /** Each normalization step that ran, in order. */
    pipeline: Type.Array(Type.String()),
    license: LicenseManifest,
  },
  { $id: 'AssetProvenance', additionalProperties: false },
);
export type AssetProvenance = Static<typeof AssetProvenance>;

/** Structured form of a natural-language motion request (PLAN 15.3). */
export const MotionBrief = Type.Object(
  {
    schemaVersion: SchemaVersion,
    id: Id,
    action: Type.String({ minLength: 1 }),
    purpose: Type.String(),
    style: Type.String(),
    minDurationSec: Type.Number({ minimum: 0 }),
    maxDurationSec: Type.Number({ minimum: 0 }),
    rootMotionRequired: Type.Boolean(),
    loop: Type.Boolean(),
    startPose: Type.String(),
    endPose: Type.String(),
    direction: Type.String(),
    weapon: Type.String(),
    footContactExpectation: Type.String(),
    mirroringAllowed: Type.Boolean(),
  },
  { $id: 'MotionBrief', additionalProperties: false },
);
export type MotionBrief = Static<typeof MotionBrief>;

/** Lifecycle of an acquired asset. Nothing replaces a live clip before HumanAccepted. */
export const AssetState = Type.Union(
  [
    Type.Literal('Imported'),
    Type.Literal('Candidate'),
    Type.Literal('Retargeted'),
    Type.Literal('Validated'),
    Type.Literal('HumanAccepted'),
    Type.Literal('Registered'),
    Type.Literal('Rejected'),
  ],
  { $id: 'AssetState' },
);
export type AssetState = Static<typeof AssetState>;

export const CandidateAsset = Type.Object(
  {
    schemaVersion: SchemaVersion,
    id: Id,
    state: AssetState,
    brief: Type.Optional(MotionBrief),
    provenance: AssetProvenance,
    /** Clip ids discovered inside the imported file. */
    discoveredClips: Type.Array(Type.String()),
    durationSec: Type.Number({ minimum: 0 }),
    /** Validation findings; a non-empty list blocks promotion to Validated. */
    issues: Type.Array(Type.String()),
    /** Clip this candidate would replace once HumanAccepted. */
    replacesClipId: Type.Union([Type.String(), Type.Null()]),
  },
  { $id: 'CandidateAsset', additionalProperties: false },
);
export type CandidateAsset = Static<typeof CandidateAsset>;
