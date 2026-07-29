import { Type, type Static } from '@sinclair/typebox';
import { Id, ProtectionMetadata, SchemaVersion, ValueProvenance } from './common.ts';
import { AnimationClipDefinition, AnimationGraphDefinition, SkeletonDefinition } from './animation.ts';
import { InputMapDefinition } from './input.ts';
import { CameraProfile, MovementProfile, RootMotionProfile } from './movement.ts';
import { TerrainInteractionProfile } from './terrain.ts';
import { HapticProfile } from './haptics.ts';
import { CandidateAsset } from './acquisition.ts';

export const CharacterDefinition = Type.Object(
  {
    schemaVersion: SchemaVersion,
    id: Id,
    displayName: Type.String(),
    /** null selects the procedural fallback character so the app boots assetless. */
    modelAssetPath: Type.Union([Type.String(), Type.Null()]),
    skeleton: SkeletonDefinition,
    /** Meters; used for capsule probes and step-up checks. */
    capsuleRadius: Type.Number({ minimum: 0.05, maximum: 2 }),
    capsuleHeight: Type.Number({ minimum: 0.2, maximum: 4 }),
    protection: Type.Optional(ProtectionMetadata),
  },
  { $id: 'CharacterDefinition', additionalProperties: false },
);
export type CharacterDefinition = Static<typeof CharacterDefinition>;

/**
 * Learned per-project preferences (PLAN 14.4). This is not model training —
 * it is canonical data the rule-based provider reads before proposing.
 */
export const PreferenceProfile = Type.Object(
  {
    schemaVersion: SchemaVersion,
    preferredBlendMinSec: Type.Number({ minimum: 0, maximum: 2 }),
    preferredBlendMaxSec: Type.Number({ minimum: 0, maximum: 2 }),
    /** 0 = weighty, 1 = twitchy. */
    responsiveness: Type.Number({ minimum: 0, maximum: 1 }),
    momentumPreference: Type.Number({ minimum: 0, maximum: 1 }),
    rootMotionPolicy: Type.Union([
      Type.Literal('prefer-in-place'),
      Type.Literal('prefer-root-motion'),
      Type.Literal('prefer-hybrid'),
    ]),
    ikCorrectionPreference: Type.Number({ minimum: 0, maximum: 1 }),
    hapticIntensityPreference: Type.Number({ minimum: 0, maximum: 1 }),
    /** Accepted/rejected proposal variants, newest last. */
    acceptanceHistory: Type.Array(
      Type.Object(
        {
          proposalVariant: Type.String(),
          accepted: Type.Boolean(),
          humanAdjustedAfter: Type.Boolean(),
          at: Type.String(),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { $id: 'PreferenceProfile', additionalProperties: false },
);
export type PreferenceProfile = Static<typeof PreferenceProfile>;

export const RevisionDefinition = Type.Object(
  {
    schemaVersion: SchemaVersion,
    id: Type.String({ minLength: 1 }),
    parentId: Type.Union([Type.String(), Type.Null()]),
    createdAt: Type.String(),
    author: Type.String(),
    message: Type.String(),
    /** Canonical paths touched by this revision. */
    changedPaths: Type.Array(Type.String()),
    provenance: Type.Optional(ValueProvenance),
    /** Git commit SHA once the revision reaches a branch. */
    commitSha: Type.Optional(Type.String()),
  },
  { $id: 'RevisionDefinition', additionalProperties: false },
);
export type RevisionDefinition = Static<typeof RevisionDefinition>;

export const ProjectDefinition = Type.Object(
  {
    schemaVersion: SchemaVersion,
    id: Id,
    displayName: Type.String(),
    /** Current revision id; bumped on every applied change. */
    revisionId: Type.String({ minLength: 1 }),
    character: CharacterDefinition,
    clips: Type.Array(AnimationClipDefinition, { minItems: 1 }),
    graph: AnimationGraphDefinition,
    inputMap: InputMapDefinition,
    movement: MovementProfile,
    rootMotion: RootMotionProfile,
    terrain: TerrainInteractionProfile,
    camera: CameraProfile,
    haptics: HapticProfile,
    preferences: PreferenceProfile,
    /** Terrain preset selected when the chamber opens. */
    defaultTerrainPresetId: Id,
    candidates: Type.Array(CandidateAsset),
    revisions: Type.Array(RevisionDefinition),
    /**
     * Project-wide invariants. Repo Guard fails when any of these paths is
     * removed or has its protection weakened.
     */
    invariants: Type.Array(
      Type.Object(
        {
          path: Type.String(),
          reason: Type.String(),
        },
        { additionalProperties: false },
      ),
    ),
    protection: Type.Optional(ProtectionMetadata),
  },
  { $id: 'ProjectDefinition', additionalProperties: false },
);
export type ProjectDefinition = Static<typeof ProjectDefinition>;
