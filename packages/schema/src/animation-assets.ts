/**
 * Animation assets (PLAN "Animation Asset Reuse System", Part II).
 *
 * The point of this file is a single sentence: a character does not own its
 * animation, it *references* it. Everything below exists to make that
 * reference checkable — typed, versioned, content-hashed, and refusable when
 * it no longer matches what it claims to point at.
 *
 * The five asset types divide the job so that none of them has to know about
 * a specific character:
 *
 *   Behavior   — the state machine. Knows motion *slots*, never clip ids.
 *   Motion Set — a character's clips, bound to those slots.
 *   Clip       — one piece of motion. Knows no behavior.
 *   Rig        — the skeleton a clip was authored for.
 *   Tuning     — numeric adjustments layered over a behavior.
 */
import { Type, type Static } from '@sinclair/typebox';
import {
  Id,
  NormalizedTime,
  ProtectionMetadata,
  SchemaVersion,
  ValueProvenance,
} from './common.ts';
import {
  AnimationClipDefinition,
  AnimationGraphDefinition,
  SemanticEventKind,
  SkeletonDefinition,
} from './animation.ts';

export const ANIMATION_ASSET_TYPES = [
  'animation-behavior',
  'animation-motion-set',
  'animation-clip',
  'humanoid-rig',
  'animation-tuning',
] as const;

export const AnimationAssetType = Type.Union(
  [
    Type.Literal('animation-behavior'),
    Type.Literal('animation-motion-set'),
    Type.Literal('animation-clip'),
    Type.Literal('humanoid-rig'),
    Type.Literal('animation-tuning'),
  ],
  { $id: 'AnimationAssetType' },
);
export type AnimationAssetType = Static<typeof AnimationAssetType>;

/** SemVer, exactly three numeric components. Asset files are named after it. */
export const AssetVersion = Type.String({ pattern: '^\\d+\\.\\d+\\.\\d+$' });

/**
 * Lowercase hex SHA-256 of a *published* asset version. Never empty: a
 * reference with no hash is indistinguishable from one nobody checked, which
 * is exactly the bypass PLAN Part III closes. Anything that points at a
 * published asset — `AssetReference`, a character's animation assignment, a
 * motion set binding, a variant's parent — carries this type.
 */
export const PublishedContentHash = Type.String({ pattern: '^[a-f0-9]{64}$' });

/**
 * Lowercase hex SHA-256, or the empty string on a draft that has not been
 * sealed yet. Only `AnimationAssetMetadata.contentHash` uses this — an asset
 * still being authored in memory or inside a prepared transaction view has no
 * hash until `sealAsset()` computes one, and that is fine precisely because
 * nothing else has been allowed to reference it yet.
 */
export const DraftContentHash = Type.String({ pattern: '^([a-f0-9]{64})?$' });

/**
 * Motion slot ids are dotted (`locomotion.idle`), which the plain `Id` pattern
 * deliberately forbids — a dot in a canonical path segment would be ambiguous
 * everywhere else. Slots never appear as a path segment, so they get their own
 * pattern rather than loosening `Id` for everyone.
 */
export const MotionSlotId = Type.String({
  pattern: '^[a-z0-9][a-z0-9-]*(\\.[a-z0-9][a-z0-9-]*)*$',
  minLength: 1,
  maxLength: 128,
});

/**
 * A reference is only usable if all four fields agree with the file on disk.
 * The hash is what makes "someone edited a published version in place" a
 * detectable event instead of a silent behaviour change.
 */
export const AssetReference = Type.Object(
  {
    assetType: AnimationAssetType,
    assetId: Id,
    version: AssetVersion,
    contentHash: PublishedContentHash,
  },
  { $id: 'AssetReference', additionalProperties: false },
);
export type AssetReference = Static<typeof AssetReference>;

/** Where a derived asset came from. Kept even when the link is severed. */
export const AssetDerivationProvenance = Type.Object(
  {
    forkedFrom: Type.Optional(AssetReference),
    duplicatedFrom: Type.Optional(AssetReference),
    promotedFromCandidateId: Type.Optional(Type.String()),
    migratedFromSchemaVersion: Type.Optional(SchemaVersion),
    note: Type.Optional(Type.String()),
  },
  { $id: 'AssetDerivationProvenance', additionalProperties: false },
);
export type AssetDerivationProvenance = Static<typeof AssetDerivationProvenance>;

export const AnimationAssetMetadata = Type.Object(
  {
    schemaVersion: SchemaVersion,
    assetType: AnimationAssetType,
    id: Id,
    version: AssetVersion,
    displayName: Type.String(),
    description: Type.String(),
    tags: Type.Array(Type.String()),
    createdAt: Type.String(),
    createdBy: Type.String(),
    /** SHA-256 of this document with `contentHash` itself blanked out. Empty until sealed. */
    contentHash: DraftContentHash,
    protection: Type.Optional(ProtectionMetadata),
    provenance: Type.Optional(ValueProvenance),
    assetProvenance: Type.Optional(AssetDerivationProvenance),
  },
  { $id: 'AnimationAssetMetadata', additionalProperties: false },
);
export type AnimationAssetMetadata = Static<typeof AnimationAssetMetadata>;

/**
 * A single override addressed by canonical path, relative to the asset it
 * patches. `remove` is what lets a variant drop a state without copying the
 * parent; `value` is ignored for it.
 */
export const CanonicalPatch = Type.Object(
  {
    path: Type.String({ minLength: 1 }),
    op: Type.Union([Type.Literal('set'), Type.Literal('append'), Type.Literal('remove')]),
    value: Type.Optional(Type.Unknown()),
    reason: Type.Optional(Type.String()),
    provenance: Type.Optional(ValueProvenance),
  },
  { $id: 'CanonicalPatch', additionalProperties: false },
);
export type CanonicalPatch = Static<typeof CanonicalPatch>;

export const AnimationParameterDefinition = Type.Object(
  {
    name: Type.String({ minLength: 1 }),
    kind: Type.Union([
      Type.Literal('number'),
      Type.Literal('boolean'),
      Type.Literal('string'),
      Type.Literal('trigger'),
    ]),
    description: Type.Optional(Type.String()),
  },
  { $id: 'AnimationParameterDefinition', additionalProperties: false },
);
export type AnimationParameterDefinition = Static<typeof AnimationParameterDefinition>;

/**
 * A behaviour declares which semantic events downstream systems (hitboxes,
 * haptics, audio) are entitled to expect from it. A motion set whose clips
 * never emit a required event is incompatible, and says so before playback.
 */
export const SemanticEventContract = Type.Object(
  {
    kind: SemanticEventKind,
    required: Type.Boolean(),
    /** Slots that must carry this event. Empty means "somewhere in the set". */
    motionSlots: Type.Array(MotionSlotId),
  },
  { $id: 'SemanticEventContract', additionalProperties: false },
);
export type SemanticEventContract = Static<typeof SemanticEventContract>;

export const MotionSlotDefinition = Type.Object(
  {
    id: MotionSlotId,
    displayName: Type.String(),
    required: Type.Boolean(),
    /** Slot to use when this one has no binding. Must not form a cycle. */
    fallbackSlot: Type.Optional(MotionSlotId),
    expectedLoop: Type.Optional(Type.Boolean()),
    expectedSemanticEvents: Type.Optional(Type.Array(SemanticEventKind)),
    tags: Type.Array(Type.String()),
  },
  { $id: 'MotionSlotDefinition', additionalProperties: false },
);
export type MotionSlotDefinition = Static<typeof MotionSlotDefinition>;

/**
 * How an asset came to exist.
 *
 *   base     — authored outright.
 *   variant  — parent plus patches. Stores *only* the patches, never a copy.
 *   fork     — a snapshot taken from a parent, then detached. Resolving a fork
 *              never reads the parent, so deleting the parent is harmless.
 */
const BaseDerivation = Type.Object({ mode: Type.Literal('base') }, { additionalProperties: false });
const VariantDerivation = Type.Object(
  {
    mode: Type.Literal('variant'),
    parent: AssetReference,
    patches: Type.Array(CanonicalPatch),
  },
  { additionalProperties: false },
);
const ForkDerivation = Type.Object(
  {
    mode: Type.Literal('fork'),
    forkedFrom: AssetReference,
    forkIntent: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export const AssetDerivation = Type.Union([BaseDerivation, VariantDerivation, ForkDerivation], {
  $id: 'AssetDerivation',
});
export type AssetDerivation = Static<typeof AssetDerivation>;

/** Every field a behaviour's payload has, shared by the `base` and `fork` shapes below. */
const ANIMATION_BEHAVIOR_PAYLOAD_FIELDS = {
  parameters: Type.Array(AnimationParameterDefinition),
  motionSlots: Type.Array(MotionSlotDefinition),
  semanticEvents: Type.Array(SemanticEventContract),
  graph: AnimationGraphDefinition,
  defaultTuning: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  replayFixtureIds: Type.Array(Type.String()),
};

export const BaseAnimationBehaviorAsset = Type.Object(
  {
    metadata: AnimationAssetMetadata,
    derivation: BaseDerivation,
    ...ANIMATION_BEHAVIOR_PAYLOAD_FIELDS,
  },
  { $id: 'BaseAnimationBehaviorAsset', additionalProperties: false },
);
export type BaseAnimationBehaviorAsset = Static<typeof BaseAnimationBehaviorAsset>;

export const ForkAnimationBehaviorAsset = Type.Object(
  {
    metadata: AnimationAssetMetadata,
    derivation: ForkDerivation,
    ...ANIMATION_BEHAVIOR_PAYLOAD_FIELDS,
  },
  { $id: 'ForkAnimationBehaviorAsset', additionalProperties: false },
);
export type ForkAnimationBehaviorAsset = Static<typeof ForkAnimationBehaviorAsset>;

/**
 * A variant stores its parent reference and its patches, and nothing else —
 * no payload field is even a legal key here, which is what makes "a variant
 * that is secretly a full copy" unrepresentable rather than merely
 * discouraged (PLAN Part IV §21-22). Every payload value a variant needs is
 * derived at resolve time by applying `derivation.patches` to the *parent's*
 * resolved payload, so a contract the parent gains later — an optional
 * motion slot, a new replay fixture id — is visible to every existing
 * variant without touching it.
 */
export const VariantAnimationBehaviorAsset = Type.Object(
  {
    metadata: AnimationAssetMetadata,
    derivation: VariantDerivation,
  },
  { $id: 'VariantAnimationBehaviorAsset', additionalProperties: false },
);
export type VariantAnimationBehaviorAsset = Static<typeof VariantAnimationBehaviorAsset>;

export const AnimationBehaviorAsset = Type.Union(
  [BaseAnimationBehaviorAsset, ForkAnimationBehaviorAsset, VariantAnimationBehaviorAsset],
  { $id: 'AnimationBehaviorAsset' },
);
export type AnimationBehaviorAsset = Static<typeof AnimationBehaviorAsset>;

/**
 * The payload fields resolution always produces, regardless of the stored
 * asset's derivation mode — a base/fork asset already carries them, a
 * variant's are derived fresh from its parent plus patches every time.
 */
export interface AnimationBehaviorPayload {
  parameters: AnimationParameterDefinition[];
  motionSlots: MotionSlotDefinition[];
  semanticEvents: SemanticEventContract[];
  graph: AnimationGraphDefinition;
  defaultTuning?: Record<string, unknown>;
  replayFixtureIds: string[];
}

/**
 * What `resolveBehaviorAsset` returns as `.asset`: metadata and derivation as
 * stored, plus a payload that is always populated. Never persisted — writing
 * this to disk for a variant would be exactly the snapshot this schema
 * exists to make impossible, so this type only ever lives in memory.
 */
export interface ResolvedAnimationBehaviorAsset extends AnimationBehaviorPayload {
  metadata: AnimationAssetMetadata;
  derivation: AssetDerivation;
}

export const MotionSetBinding = Type.Object(
  {
    motionSlot: MotionSlotId,
    clip: AssetReference,
    /**
     * Context that selects this binding over the unkeyed one — the weapon mode
     * in the demo project. A slot with no contextual bindings resolves the same
     * way for every context.
     */
    contextualKey: Type.Optional(Type.String({ minLength: 1 })),
  },
  { $id: 'MotionSetBinding', additionalProperties: false },
);
export type MotionSetBinding = Static<typeof MotionSetBinding>;

export const AnimationMotionSetAsset = Type.Object(
  {
    metadata: AnimationAssetMetadata,
    /** Behaviour ids this set claims to satisfy. Checked slot by slot anyway. */
    compatibleBehaviorIds: Type.Array(Id),
    rig: AssetReference,
    bindings: Type.Array(MotionSetBinding),
    fallbackBindings: Type.Array(
      Type.Object(
        { missingSlot: MotionSlotId, fallbackSlot: MotionSlotId },
        { additionalProperties: false },
      ),
    ),
  },
  { $id: 'AnimationMotionSetAsset', additionalProperties: false },
);
export type AnimationMotionSetAsset = Static<typeof AnimationMotionSetAsset>;

export const AnimationClipAsset = Type.Object(
  {
    metadata: AnimationAssetMetadata,
    /**
     * The existing clip definition verbatim. Reusing it rather than restating
     * its fields keeps one description of what a clip is, so the timeline,
     * foot-IK solver and Unity exporter need no asset-aware branch.
     */
    clip: AnimationClipDefinition,
    compatibleRigIds: Type.Array(Id),
    sourceCandidateId: Type.Optional(Type.String()),
  },
  { $id: 'AnimationClipAsset', additionalProperties: false },
);
export type AnimationClipAsset = Static<typeof AnimationClipAsset>;

export const RetargetStatus = Type.Union(
  [
    Type.Literal('direct-compatible'),
    Type.Literal('retarget-compatible'),
    Type.Literal('conversion-required'),
  ],
  { $id: 'RetargetStatus' },
);
export type RetargetStatus = Static<typeof RetargetStatus>;

export const HumanoidRigProfileAsset = Type.Object(
  {
    metadata: AnimationAssetMetadata,
    skeleton: SkeletonDefinition,
    /** Rigs sharing this key play each other's clips without retargeting. */
    compatibilityKey: Type.String({ minLength: 1 }),
    coordinateSystem: Type.Object(
      {
        upAxis: Type.Literal('Y'),
        forwardAxis: Type.Literal('+Z'),
        handedness: Type.Literal('right'),
        unitMeters: Type.Number({ minimum: 0.0001, maximum: 1000 }),
      },
      { additionalProperties: false },
    ),
    humanoidBones: Type.Object(
      {
        hips: Type.String(),
        spine: Type.Optional(Type.String()),
        chest: Type.Optional(Type.String()),
        head: Type.Optional(Type.String()),
        leftFoot: Type.String(),
        rightFoot: Type.String(),
        leftHand: Type.Optional(Type.String()),
        rightHand: Type.Optional(Type.String()),
      },
      { additionalProperties: false },
    ),
    retargetStatus: RetargetStatus,
  },
  { $id: 'HumanoidRigProfileAsset', additionalProperties: false },
);
export type HumanoidRigProfileAsset = Static<typeof HumanoidRigProfileAsset>;

export const AnimationTuningProfileAsset = Type.Object(
  {
    metadata: AnimationAssetMetadata,
    compatibleBehavior: AssetReference,
    /**
     * Tuning adjusts values; it never adds or removes structure. A patch that
     * would create or delete a state is refused by the resolver, and the UI
     * offers a behaviour variant instead.
     */
    patches: Type.Array(CanonicalPatch),
  },
  { $id: 'AnimationTuningProfileAsset', additionalProperties: false },
);
export type AnimationTuningProfileAsset = Static<typeof AnimationTuningProfileAsset>;

export const AnimationAsset = Type.Union(
  [
    AnimationBehaviorAsset,
    AnimationMotionSetAsset,
    AnimationClipAsset,
    HumanoidRigProfileAsset,
    AnimationTuningProfileAsset,
  ],
  { $id: 'AnimationAsset' },
);
export type AnimationAsset = Static<typeof AnimationAsset>;

/** What a character plugs into. This is the whole of "adding a character". */
export const CharacterAnimationAssignment = Type.Object(
  {
    behavior: AssetReference,
    motionSet: AssetReference,
    rig: AssetReference,
    tuning: Type.Optional(AssetReference),
    /** Last-wins adjustments belonging to this character alone. */
    instanceOverrides: Type.Array(CanonicalPatch),
  },
  { $id: 'CharacterAnimationAssignment', additionalProperties: false },
);
export type CharacterAnimationAssignment = Static<typeof CharacterAnimationAssignment>;

/** Where a resolved value came from, in application order (PLAN 21). */
export const RESOLUTION_SOURCES = [
  'base-behavior',
  'behavior-variant',
  'motion-set',
  'tuning-profile',
  'character-override',
  'preview-session',
] as const;
export type ResolutionSource = (typeof RESOLUTION_SOURCES)[number];

export interface ResolvedValue {
  value: unknown;
  source: ResolutionSource;
  sourceAsset?: AssetReference;
  canonicalPath: string;
}

export const AssetValidationSeverity = Type.Union([
  Type.Literal('error'),
  Type.Literal('warning'),
]);

export interface AssetIssue {
  code: AssetIssueCode;
  severity: 'error' | 'warning';
  message: string;
  /** Canonical path inside the asset, when the problem has one. */
  path?: string;
  reference?: AssetReference;
}

/**
 * Every way an asset graph can be wrong, named. The UI groups by code and the
 * harness asserts on it, so these strings are part of the contract.
 */
export type AssetIssueCode =
  | 'missing-reference'
  | 'hash-mismatch'
  | 'version-not-found'
  | 'circular-variant'
  | 'missing-required-motion-slot'
  | 'invalid-fallback-cycle'
  | 'motion-set-behavior-incompatible'
  | 'clip-rig-incompatible'
  | 'protection-weakened'
  | 'published-asset-modified'
  | 'orphaned-asset'
  | 'invalid-patch-path'
  | 'tuning-changes-structure'
  | 'schema-invalid'
  | 'missing-semantic-event'
  | 'duplicate-binding'
  | 'duplicate-asset-key'
  | 'asset-metadata-mismatch'
  | 'asset-path-mismatch'
  | 'unsealed-published-asset';

export interface AssetValidationReport {
  valid: boolean;
  issues: AssetIssue[];
}

/** One row of the browsable library index. Deliberately small. */
export interface AnimationAssetSummary {
  assetType: AnimationAssetType;
  id: string;
  version: string;
  contentHash: string;
  displayName: string;
  description: string;
  tags: string[];
  derivation: 'base' | 'variant' | 'fork';
  protectionLevel: string;
  /** Free text pulled out of the asset so browser-side search stays local. */
  searchTerms: string[];
  valid: boolean;
  issueCodes: AssetIssueCode[];
}

export const NEW_ASSET_VERSION = '1.0.0';

export function parseAssetVersion(version: string): [number, number, number] {
  const parts = version.split('.').map((part) => Number.parseInt(part, 10));
  if (parts.length !== 3 || parts.some((part) => !Number.isInteger(part) || part < 0)) {
    throw new Error(`not a semantic version: "${version}"`);
  }
  return [parts[0]!, parts[1]!, parts[2]!];
}

export function compareAssetVersions(left: string, right: string): number {
  const a = parseAssetVersion(left);
  const b = parseAssetVersion(right);
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i]! - b[i]!;
  }
  return 0;
}

export function bumpAssetVersion(
  version: string,
  level: 'major' | 'minor' | 'patch',
): string {
  const [major, minor, patch] = parseAssetVersion(version);
  if (level === 'major') return `${major + 1}.0.0`;
  if (level === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

/** Repository location of one published asset version. */
export function assetFilePath(
  assetType: AnimationAssetType,
  assetId: string,
  version: string,
): string {
  const directory: Record<AnimationAssetType, string> = {
    'animation-behavior': 'behaviors',
    'animation-motion-set': 'motion-sets',
    'animation-clip': 'clips',
    'humanoid-rig': 'rigs',
    'animation-tuning': 'tuning',
  };
  return `assets/animation/${directory[assetType]}/${assetId}/${version}.json`;
}

export function referencesEqual(left: AssetReference, right: AssetReference): boolean {
  return (
    left.assetType === right.assetType &&
    left.assetId === right.assetId &&
    left.version === right.version
  );
}

export function referenceKey(reference: AssetReference): string {
  return `${reference.assetType}:${reference.assetId}@${reference.version}`;
}

export { NormalizedTime };
