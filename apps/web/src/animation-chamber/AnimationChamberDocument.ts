/**
 * The document the animation workspace edits, with no Character in it.
 *
 * The preserved fine-tuning panels were written against `ResolvedProject`, and
 * the obvious way to keep them working would have been to rebuild a
 * `CharacterDefinition` from the subject and hand them the old shape. That is
 * the one thing this file exists to avoid: a reconstructed Character is
 * canonical-looking state with no canonical owner, and every question about it
 * ("which Character is this? what happens when it is saved?") has no answer.
 *
 * So the document keeps the *property names* the panels already read — that is
 * a compatibility decision the work package explicitly permits (§11.2) — while
 * the values behind them come from an exact Prefab Animator subject and the
 * repository's project-level tuning profiles. There is no `character` field, no
 * `characters` array and no `activeCharacterId`, and nothing here can be
 * mistaken for one.
 *
 * The tuning profiles are project-level in the canonical schema, not
 * Character-level, which is what makes this possible without inventing state.
 */
import type {
  AnimationClipDefinition,
  AnimationGraphDefinition,
  AnimationSubjectDefinition,
  AssetReference,
  CameraProfile,
  EquipmentSlotDefinition,
  HapticProfile,
  InputMapDefinition,
  MovementProfile,
  PreferenceProfile,
  ResolvedValue,
  RootMotionProfile,
  SkeletonDefinition,
  TerrainInteractionProfile,
} from '@atc/schema';
import type { ResolvedAnimationSubject } from '@atc/animation-asset-runtime';

/**
 * The repository-owned half of the document.
 *
 * Deliberately a narrow structural type rather than `ProjectDefinition`: a
 * `ProjectDefinition` parameter would carry `characters` and
 * `activeCharacterId` into this module, and then nothing but discipline would
 * stop a later edit from reading them. What cannot be passed in cannot be read.
 */
export interface AnimationChamberRepositoryDefaults {
  movement: MovementProfile;
  rootMotion: RootMotionProfile;
  terrain: TerrainInteractionProfile;
  camera: CameraProfile;
  inputMap: InputMapDefinition;
  haptics: HapticProfile;
  equipment: EquipmentSlotDefinition[];
  preferences: PreferenceProfile;
  defaultTerrainPresetId: string;
  /**
   * The repository revision this document was built against.
   *
   * Not decoration: a recording stamps it so a replay can say what it ran
   * against, and the session compares it to detect that the repository moved
   * underneath an open workspace.
   */
  revisionId: string;
}

/**
 * What every animation panel reads.
 *
 * The first block is the subject's resolved animation bundle, the second is
 * repository tuning, and the third is the subject's own presentation — the
 * body the viewport draws, which belongs to the exact Prefab Component rather
 * than to a Character.
 */
export interface AnimationChamberDocument extends AnimationChamberRepositoryDefaults {
  subject: AnimationSubjectDefinition;

  graph: AnimationGraphDefinition;
  clips: AnimationClipDefinition[];
  motionBindings: Record<string, string>;
  contextualMotionBindings: Record<string, Record<string, string>>;
  motionContextKeys: string[];
  clipAssetSources: Record<string, AssetReference>;
  resolution: ResolvedValue[];
  skeleton: SkeletonDefinition;
  rigCompatibilityKey: string;

  presentation: AnimationSubjectDefinition['presentation'];
}

/**
 * Builds the document for one exact subject.
 *
 * Shares the bundle's values by reference for the same reason
 * `materializeResolvedProject` does — the bundle is the genuinely shareable
 * part, and deep-copying it here would cost the resolver's cache for nothing.
 * The wrapper is fresh per subject, so two subjects never share one document.
 */
export function materializeAnimationChamberDocument(input: {
  resolved: ResolvedAnimationSubject;
  repository: AnimationChamberRepositoryDefaults;
}): AnimationChamberDocument {
  const { resolved, repository } = input;
  const { bundle } = resolved;
  return {
    ...repository,
    subject: resolved.subject,

    graph: bundle.graph,
    clips: bundle.clips,
    motionBindings: bundle.motionBindings,
    contextualMotionBindings: bundle.contextualMotionBindings,
    motionContextKeys: bundle.motionContextKeys,
    clipAssetSources: bundle.clipAssetSources,
    resolution: bundle.resolution,
    skeleton: bundle.skeleton,
    rigCompatibilityKey: bundle.rigCompatibilityKey,

    presentation: resolved.subject.presentation,
  };
}

/**
 * Why a panel cannot operate for this subject.
 *
 * A structured reason rather than a hidden tab (§2): a missing model is a fact
 * about the subject the human needs to see, and a workspace that silently drops
 * Terrain when a Prefab has no capsule teaches its user that panels come and go
 * for no reason.
 */
export interface AnimationCapabilityAvailability {
  available: boolean;
  /** Present exactly when `available` is false. */
  reason?: string;
  /** The subject field whose absence produced the reason. */
  missing?: 'model' | 'capsule' | 'equipmentSockets';
}

/** Whether the viewport can draw a body for this subject. */
export function presentationAvailability(
  document: AnimationChamberDocument,
): AnimationCapabilityAvailability {
  if (!document.presentation.model) {
    return {
      available: false,
      missing: 'model',
      reason:
        'This Animator’s Prefab node has no ModelRenderer, so there is no body to draw. ' +
        'Graph, Timeline and Timing editing remain available.',
    };
  }
  return { available: true };
}

/**
 * Whether the viewport, rather than the shell's clock, advances the simulation.
 *
 * Exactly one of them must. The viewport drives from `useFrame`, which only
 * runs when there is a canvas, which only exists when there is a body to draw —
 * so the same fact decides both, and deriving it in one named place is what
 * stops the two from disagreeing and running every tick twice.
 */
export function viewportOwnsSimulation(document: AnimationChamberDocument): boolean {
  return presentationAvailability(document).available;
}

/** Whether grounding and foot-IK diagnostics can run for this subject. */
export function groundingAvailability(
  document: AnimationChamberDocument,
): AnimationCapabilityAvailability {
  if (!document.presentation.capsule) {
    return {
      available: false,
      missing: 'capsule',
      reason:
        'This Animator’s Prefab node has no CapsuleCollider, so grounding, slope and ' +
        'foot-IK diagnostics have no body to measure. Animation playback is unaffected.',
    };
  }
  return { available: true };
}

/** Whether grip previewing has an equipment socket set to attach to. */
export function gripAvailability(
  document: AnimationChamberDocument,
): AnimationCapabilityAvailability {
  if (!document.presentation.equipmentSockets) {
    return {
      available: false,
      missing: 'equipmentSockets',
      reason:
        'This Animator’s Prefab node has no EquipmentSockets Component, so there is no ' +
        'socket to attach a grip to.',
    };
  }
  return { available: true };
}
