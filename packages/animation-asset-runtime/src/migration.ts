/**
 * Schema v1 -> v2 migration (PLAN 34).
 *
 * The demo character's graph and clips were embedded in `project.json`. This
 * lifts them out into assets and leaves references behind. Two properties are
 * non-negotiable:
 *
 *  - **Deterministic.** The same input must produce byte-identical output, or
 *    the content hashes move on every run and every reference breaks. Hence no
 *    `Date.now()` and no unordered iteration anywhere below.
 *
 *  - **Behaviour-preserving.** Every name-based branch the old runtime carried
 *    is translated into an explicit policy field whose value reproduces exactly
 *    what the name used to imply. The shadow comparison in the harness is what
 *    proves it; this file is what makes it true.
 */
import type {
  AnimationBehaviorAsset,
  AnimationClipAsset,
  AnimationClipDefinition,
  AnimationGraphDefinition,
  AnimationMotionSetAsset,
  AnimationTuningProfileAsset,
  AssetReference,
  CharacterDefinition,
  HumanoidRigProfileAsset,
  MotionSlotDefinition,
  MovementAuthorityPolicy,
  ProjectDefinition,
  SkeletonDefinition,
  StateCompletionPolicy,
  StateDefinition,
} from '@atc/schema';
import { computeContentHash, sealAsset } from './hashing.ts';
import type { StoredAsset } from './registry.ts';

/**
 * Fixed so the migration is reproducible. A wall-clock timestamp here would
 * change the content hash on every run, which would in turn invalidate every
 * reference the migration had just written.
 */
export const MIGRATION_TIMESTAMP = '2026-01-01T00:00:00.000Z';
export const MIGRATION_AUTHOR = 'animation-asset-migration';

export const DEMO_BEHAVIOR_ID = 'humanoid-third-person-base';
export const DEMO_MOTION_SET_ID = 'demo-humanoid-motion-set';
export const DEMO_RIG_ID = 'demo-humanoid-rig';
export const DEMO_TUNING_ID = 'demo-default-tuning';
export const ALTERNATE_CHARACTER_ID = 'alternate-humanoid-character';
export const ALTERNATE_MOTION_SET_ID = 'alternate-humanoid-motion-set';
export const ALTERNATE_TUNING_ID = 'alternate-humanoid-tuning';
export const ALTERNATE_CLIP_PREFIX = 'alt-';

/** The legacy shape this migration reads. Only the fields it needs. */
export interface LegacyProject {
  schemaVersion: number;
  id: string;
  character: {
    schemaVersion?: number;
    id: string;
    displayName: string;
    modelAssetPath: string | null;
    skeleton: SkeletonDefinition;
    capsuleRadius: number;
    capsuleHeight: number;
  };
  clips: AnimationClipDefinition[];
  graph: {
    schemaVersion: number;
    id: string;
    layers: AnimationGraphDefinition['layers'];
    states: LegacyState[];
    transitions: AnimationGraphDefinition['transitions'];
    forcedTransitionOrder: string[];
  };
  [key: string]: unknown;
}

export interface LegacyState {
  schemaVersion: number;
  id: string;
  clipId: string;
  weaponClips?: Record<string, string>;
  layer: string;
  loop: boolean;
  speed: number;
  timeoutSec: number;
  fallbackState?: string;
  allowReEntry: boolean;
  interruptible: boolean;
  bodyMask?: 'full' | 'upper' | 'lower';
  protection?: StateDefinition['protection'];
  provenance?: StateDefinition['provenance'];
}

/** PLAN 34.2. Anything unrecognised keeps its own name under `state.`. */
const SLOT_BY_STATE_ID: Record<string, string> = {
  idle: 'locomotion.idle',
  walk: 'locomotion.walk',
  run: 'locomotion.run',
  jump: 'airborne.jump',
  fall: 'airborne.fall',
  land: 'airborne.land',
  dodge: 'mobility.dodge',
  'attack-01': 'action.primary.01',
  'attack-02': 'action.primary.02',
};

export function motionSlotForState(stateId: string): string {
  return SLOT_BY_STATE_ID[stateId] ?? `state.${stateId}`;
}

/**
 * The old graph runtime fell through one tick late for a state whose id began
 * with `attack-`, so the final frame of a swing is rendered rather than
 * swallowed by the fallback. That is real, wanted behaviour; only the way it
 * was selected was wrong.
 */
export function completionPolicyForState(state: LegacyState): StateCompletionPolicy {
  if (state.id.startsWith('attack-')) return { mode: 'hold-final-frame', holdTicks: 0 };
  return { mode: state.loop ? 'loop' : 'immediate-fallback', holdTicks: 0 };
}

/**
 * Three separate name checks, translated literally:
 *   `startsWith('attack-')`        -> locksMovementUntilRecovery
 *   `=== 'dodge' || '-recovery'`   -> returnsAuthorityOnRecovery
 *   `=== 'walk' || === 'run'`      -> providesLocomotionAuthority
 */
export function movementPolicyForState(state: LegacyState): MovementAuthorityPolicy {
  return {
    locksMovementUntilRecovery: state.id.startsWith('attack-'),
    returnsAuthorityOnRecovery: state.id === 'dodge' || state.id.endsWith('-recovery'),
    providesLocomotionAuthority: state.id === 'walk' || state.id === 'run',
    locomotionSpeedReference:
      state.id === 'walk' ? 'walk' : state.id === 'run' ? 'run' : 'none',
  };
}

/** The old default: a dedicated recovery clip returns authority immediately. */
export const LEGACY_DODGE_RECOVERY_START = 0.78;
export const LEGACY_RECOVERY_BLEND_SEC = 0.28;

export function migrateState(state: LegacyState): StateDefinition {
  const migrated: StateDefinition = {
    schemaVersion: 2,
    id: state.id,
    motionSlot: motionSlotForState(state.id),
    layer: state.layer,
    loop: state.loop,
    speed: state.speed,
    timeoutSec: state.timeoutSec,
    completionPolicy: completionPolicyForState(state),
    movementAuthorityPolicy: movementPolicyForState(state),
    allowReEntry: state.allowReEntry,
    interruptible: state.interruptible,
  };
  if (state.fallbackState) migrated.fallbackState = state.fallbackState;
  if (state.bodyMask) migrated.bodyMask = state.bodyMask;
  if (state.protection) migrated.protection = state.protection;
  if (state.provenance) migrated.provenance = state.provenance;
  if (state.layer === 'action') {
    migrated.recoveryPolicy = {
      authorityReturnAtNormalized: state.id.endsWith('-recovery')
        ? 0
        : LEGACY_DODGE_RECOVERY_START,
      blendDurationSec: LEGACY_RECOVERY_BLEND_SEC,
    };
  }
  return migrated;
}

function slotDefinition(state: LegacyState, hasFallbackClip: boolean): MotionSlotDefinition {
  const slot: MotionSlotDefinition = {
    id: motionSlotForState(state.id),
    displayName: state.id.replace(/-/g, ' '),
    // Every state in the migrated graph must play something, so every slot it
    // names is required. Optional slots appear when a *variant* adds a state.
    required: true,
    tags: [state.layer],
  };
  if (state.loop) slot.expectedLoop = true;
  if (hasFallbackClip) slot.tags.push('contextual');
  return slot;
}

function metadata(
  assetType: AnimationAssetType,
  id: string,
  displayName: string,
  description: string,
  tags: string[],
): AnimationBehaviorAsset['metadata'] {
  return {
    schemaVersion: 2,
    assetType,
    id,
    version: '1.0.0',
    displayName,
    description,
    tags,
    createdAt: MIGRATION_TIMESTAMP,
    createdBy: MIGRATION_AUTHOR,
    contentHash: '',
    assetProvenance: { migratedFromSchemaVersion: 1 },
  };
}

type AnimationAssetType = AnimationBehaviorAsset['metadata']['assetType'];

/** A reference to a sealed asset, hashed from the document itself. */
function reference(asset: {
  metadata: { assetType: AnimationAssetType; id: string; version: string; contentHash: string };
}): AssetReference {
  return {
    assetType: asset.metadata.assetType,
    assetId: asset.metadata.id,
    version: asset.metadata.version,
    contentHash: computeContentHash(asset),
  };
}

export interface MigrationResult {
  assets: StoredAsset[];
  project: ProjectDefinition;
  /** Slot -> clip id for the demo character's default context. */
  motionSlots: Record<string, string>;
  notes: string[];
}

function rigAsset(skeleton: SkeletonDefinition): HumanoidRigProfileAsset {
  const humanoid = (slot: string): string | undefined =>
    skeleton.bones.find((bone) => bone.humanoid === slot)?.name;
  const bones: HumanoidRigProfileAsset['humanoidBones'] = {
    hips: skeleton.hipsBone,
    leftFoot: skeleton.leftFootBone,
    rightFoot: skeleton.rightFootBone,
  };
  for (const slot of ['spine', 'chest', 'head', 'leftHand', 'rightHand'] as const) {
    const bone = humanoid(slot);
    if (bone) bones[slot] = bone;
  }
  return sealAsset<HumanoidRigProfileAsset>({
    metadata: metadata(
      'humanoid-rig',
      DEMO_RIG_ID,
      'Demo humanoid rig',
      'Canonical humanoid skeleton the demo clips were authored against.',
      ['humanoid', 'demo'],
    ),
    skeleton: { ...skeleton, schemaVersion: 2 },
    compatibilityKey: `${skeleton.id}@${skeleton.bones.length}`,
    coordinateSystem: { upAxis: 'Y', forwardAxis: '+Z', handedness: 'right', unitMeters: 1 },
    humanoidBones: bones,
    retargetStatus: 'direct-compatible',
  });
}

function clipAsset(
  clip: AnimationClipDefinition,
  rigId: string,
  idOverride?: string,
): AnimationClipAsset {
  const id = idOverride ?? clip.id;
  return sealAsset<AnimationClipAsset>({
    metadata: metadata(
      'animation-clip',
      id,
      id.replace(/-/g, ' '),
      `Migrated from the embedded clip "${clip.id}".`,
      ['migrated', clip.loop ? 'loop' : 'oneshot'],
    ),
    clip: { ...clip, id, schemaVersion: 2 },
    compatibleRigIds: [rigId],
  });
}

/**
 * The whole migration. Returns assets and the rewritten project without
 * touching disk, so the harness can validate the complete proposed repository
 * before anything is published (PLAN 39).
 */
export function migrateProjectToAssets(legacy: LegacyProject): MigrationResult {
  const notes: string[] = [];
  const rig = rigAsset(legacy.character.skeleton);
  const rigRef = reference(rig);

  const assets: StoredAsset[] = [
    { assetType: 'humanoid-rig', id: rig.metadata.id, version: rig.metadata.version, document: rig },
  ];

  const clipAssets = legacy.clips.map((clip) => clipAsset(clip, DEMO_RIG_ID));
  for (const asset of clipAssets) {
    assets.push({
      assetType: 'animation-clip',
      id: asset.metadata.id,
      version: asset.metadata.version,
      document: asset,
    });
  }

  // Behaviour: the graph with clip ids replaced by motion slots, and every
  // name-based runtime rule turned into a field.
  const states = legacy.graph.states.map(migrateState);
  const motionSlots = legacy.graph.states.map((state) =>
    slotDefinition(state, Boolean(state.weaponClips)),
  );

  const graph: AnimationGraphDefinition = {
    schemaVersion: 2,
    id: DEMO_BEHAVIOR_ID,
    layers: legacy.graph.layers,
    states,
    transitions: legacy.graph.transitions,
    forcedTransitionOrder: legacy.graph.forcedTransitionOrder,
  };

  const emittedEventKinds = new Set(
    legacy.clips.flatMap((clip) => clip.events.map((event) => event.kind)),
  );

  const behavior = sealAsset<AnimationBehaviorAsset>({
    metadata: metadata(
      'animation-behavior',
      DEMO_BEHAVIOR_ID,
      'Humanoid third-person base',
      'Locomotion, airborne, combo and reaction state machine. Knows motion slots, not clips.',
      ['humanoid', 'third-person', 'base'],
    ),
    derivation: { mode: 'base' },
    parameters: collectParameters(legacy.graph.transitions),
    motionSlots,
    semanticEvents: [...emittedEventKinds].sort().map((kind) => ({
      kind,
      // Landing is the one event the project declares an invariant on, so it is
      // the one a motion set is not allowed to arrive without.
      required: kind === 'Landing',
      motionSlots: [],
    })),
    graph,
    replayFixtureIds: [
      'idle-to-walk',
      'run-to-attack-forward',
      'attack-01-to-attack-02',
      'late-dodge-cancel',
      'jump-buffer-before-landing',
    ],
  });
  const behaviorRef = reference(behavior);
  assets.push({
    assetType: 'animation-behavior',
    id: behavior.metadata.id,
    version: behavior.metadata.version,
    document: behavior,
  });

  // Motion set: slot -> clip, with the old `weaponClips` map becoming
  // contextual bindings. Same slot, different clip per weapon — the combo
  // structure stays in the behaviour where it belongs.
  const demoSet = motionSetAsset(
    DEMO_MOTION_SET_ID,
    'Demo humanoid motion set',
    'Clips extracted from the embedded demo character.',
    legacy,
    clipAssets,
    rigRef,
    (clipId) => clipId,
  );
  assets.push({
    assetType: 'animation-motion-set',
    id: demoSet.metadata.id,
    version: demoSet.metadata.version,
    document: demoSet,
  });

  const demoTuning = sealAsset<AnimationTuningProfileAsset>({
    metadata: metadata(
      'animation-tuning',
      DEMO_TUNING_ID,
      'Demo default tuning',
      'Empty by design: the demo character runs the shared behaviour unmodified.',
      ['demo'],
    ),
    compatibleBehavior: behaviorRef,
    patches: [],
  });
  assets.push({
    assetType: 'animation-tuning',
    id: demoTuning.metadata.id,
    version: demoTuning.metadata.version,
    document: demoTuning,
  });

  // Second character. Its clips are byte-identical to the demo's apart from
  // their ids, which is exactly what makes the reuse claim checkable: if the
  // state and transition sequences come out the same and only the clip ids
  // differ, the behaviour genuinely is shared rather than re-implemented.
  const alternateClips = legacy.clips.map((clip) =>
    clipAsset(clip, DEMO_RIG_ID, `${ALTERNATE_CLIP_PREFIX}${clip.id}`),
  );
  for (const asset of alternateClips) {
    assets.push({
      assetType: 'animation-clip',
      id: asset.metadata.id,
      version: asset.metadata.version,
      document: asset,
    });
  }
  const alternateSet = motionSetAsset(
    ALTERNATE_MOTION_SET_ID,
    'Alternate humanoid motion set',
    'A second character’s clips bound to the same behaviour’s slots.',
    legacy,
    alternateClips,
    rigRef,
    (clipId) => `${ALTERNATE_CLIP_PREFIX}${clipId}`,
  );
  assets.push({
    assetType: 'animation-motion-set',
    id: alternateSet.metadata.id,
    version: alternateSet.metadata.version,
    document: alternateSet,
  });

  const alternateTuning = sealAsset<AnimationTuningProfileAsset>({
    metadata: metadata(
      'animation-tuning',
      ALTERNATE_TUNING_ID,
      'Alternate humanoid tuning',
      'Character-specific feel. Adjusts steering authority only, so the shared state machine is provably unchanged.',
      ['alternate'],
    ),
    compatibleBehavior: behaviorRef,
    patches: [
      {
        path: '/transitions/run-to-attack-01/rotationAuthority',
        op: 'set',
        value: 0.45,
        reason: 'this character turns into its swing harder than the demo character',
      },
    ],
  });
  assets.push({
    assetType: 'animation-tuning',
    id: alternateTuning.metadata.id,
    version: alternateTuning.metadata.version,
    document: alternateTuning,
  });

  const demoCharacter: CharacterDefinition = {
    schemaVersion: 2,
    id: legacy.character.id,
    displayName: legacy.character.displayName,
    modelAssetPath: legacy.character.modelAssetPath,
    capsuleRadius: legacy.character.capsuleRadius,
    capsuleHeight: legacy.character.capsuleHeight,
    animation: {
      behavior: behaviorRef,
      motionSet: reference(demoSet),
      rig: rigRef,
      tuning: reference(demoTuning),
      instanceOverrides: [],
    },
  };

  const alternateCharacter: CharacterDefinition = {
    schemaVersion: 2,
    id: ALTERNATE_CHARACTER_ID,
    displayName: 'Alternate humanoid',
    modelAssetPath: null,
    capsuleRadius: legacy.character.capsuleRadius,
    capsuleHeight: legacy.character.capsuleHeight,
    animation: {
      behavior: behaviorRef,
      motionSet: reference(alternateSet),
      rig: rigRef,
      tuning: reference(alternateTuning),
      instanceOverrides: [],
    },
  };

  const {
    character: _character,
    clips: _clips,
    graph: _graph,
    ...rest
  } = legacy;

  const project = {
    ...rest,
    schemaVersion: 2,
    characters: [demoCharacter, alternateCharacter],
    activeCharacterId: demoCharacter.id,
  } as unknown as ProjectDefinition;

  notes.push(
    `extracted ${clipAssets.length} clip assets, 1 behaviour, 2 motion sets, 1 rig, 2 tuning profiles`,
  );
  notes.push(
    `${legacy.graph.states.filter((state) => state.weaponClips).length} states carried weapon clips, now contextual bindings`,
  );

  const slotMap: Record<string, string> = {};
  for (const binding of demoSet.bindings) {
    if (binding.contextualKey === undefined) slotMap[binding.motionSlot] = binding.clip.assetId;
  }

  return { assets, project, motionSlots: slotMap, notes };
}

function motionSetAsset(
  id: string,
  displayName: string,
  description: string,
  legacy: LegacyProject,
  clipAssets: AnimationClipAsset[],
  rigRef: AssetReference,
  mapClipId: (clipId: string) => string,
): AnimationMotionSetAsset {
  const byId = new Map(clipAssets.map((asset) => [asset.metadata.id, asset]));
  const clipRef = (clipId: string): AssetReference => {
    const asset = byId.get(mapClipId(clipId));
    if (!asset) throw new Error(`migration: no clip asset for "${clipId}"`);
    return reference(asset);
  };

  const bindings: AnimationMotionSetAsset['bindings'] = [];
  for (const state of legacy.graph.states) {
    const slot = motionSlotForState(state.id);
    bindings.push({ motionSlot: slot, clip: clipRef(state.clipId) });
    // Sorted so the asset is byte-stable regardless of object key order.
    for (const contextualKey of Object.keys(state.weaponClips ?? {}).sort()) {
      bindings.push({
        motionSlot: slot,
        clip: clipRef(state.weaponClips![contextualKey]!),
        contextualKey,
      });
    }
  }

  return sealAsset<AnimationMotionSetAsset>({
    metadata: metadata('animation-motion-set', id, displayName, description, ['humanoid']),
    compatibleBehaviorIds: [DEMO_BEHAVIOR_ID],
    rig: rigRef,
    bindings,
    fallbackBindings: [],
  });
}

/** Parameters the graph actually reads, so the behaviour declares its inputs. */
function collectParameters(
  transitions: AnimationGraphDefinition['transitions'],
): AnimationBehaviorAsset['parameters'] {
  const seen = new Map<string, AnimationBehaviorAsset['parameters'][number]>();
  for (const transition of transitions) {
    for (const condition of transition.conditions) {
      if (seen.has(condition.parameter)) continue;
      const kind =
        condition.operator === 'buffered'
          ? 'trigger'
          : typeof condition.value === 'boolean'
            ? 'boolean'
            : typeof condition.value === 'number'
              ? 'number'
              : 'string';
      seen.set(condition.parameter, { name: condition.parameter, kind });
    }
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}
