/**
 * `pnpm assets:animation:imported` — authors the canonical animation assets for
 * the two imported-model Characters (work package §5.2, §5.3).
 *
 * This is the *one declared migration adapter* §10 allows. Before it, the Knight
 * and the Universal Base were `CharacterPreset` records in a web-only catalog,
 * and their animation came from `stateId -> GLTF clip name` maps living beside
 * the renderer. That is a second animation graph: the canonical Behavior decided
 * which state was active, and a map the repository had never heard of decided
 * what you actually saw. The two could drift indefinitely while typecheck, the
 * route tests and the asset harness all stayed green.
 *
 * What this script does is move those facts into assets — a rig profile per
 * imported skeleton, one clip asset per (slot, weapon context) naming an
 * explicit take inside an explicit file, and a motion set binding them to the
 * Behavior's slots. After that, normal playback resolves
 * `state -> motionSlot -> motion set -> clip asset -> file + take` like every
 * other Character, and the maps are gone rather than merely unused.
 *
 * Three properties are non-negotiable, for the same reason they are in
 * `packages/animation-asset-runtime/src/migration.ts`:
 *
 *  - **Deterministic.** Fixed timestamps, sorted iteration, no wall clock. The
 *    content hashes are references; if they moved per run, every reference would
 *    break on every run.
 *  - **Grounded in the files.** Skeletons and take names are read out of the
 *    GLTF/GLB documents themselves, not typed in from memory. A rig profile that
 *    claimed a bone the model does not have would be a lie the compatibility
 *    checker would then faithfully propagate.
 *  - **Timing is authored, not imported.** Clip *timing* (duration, root
 *    displacement, semantic events, foot contacts) is inherited from the demo
 *    Character's corresponding clip rather than measured off the take. The
 *    engine ticks on canonical durations, so importing the takes' real durations
 *    would silently retune every transition and move the replay fixtures. The
 *    imported takes supply *appearance*; the repository still owns feel.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type {
  AnimationClipAsset,
  AnimationClipDefinition,
  AnimationMotionSetAsset,
  AssetReference,
  ExternalAnimationSource,
  HumanoidRigProfileAsset,
  MotionSetBinding,
  SkeletonBone,
  SkeletonDefinition,
} from '@atc/schema';
import { assetFilePath } from '@atc/schema';
import { sealAsset } from '@atc/animation-asset-runtime';
import { REPO_ROOT, writeRepoFile } from './lib.ts';
import { loadStoredAssets } from './animation-assets.ts';

const TIMESTAMP = '2026-08-05T00:00:00.000Z';
const AUTHOR = 'imported-character-asset-authoring';
const BEHAVIOR_ID = 'humanoid-third-person-base';
const TEMPLATE_MOTION_SET_ID = 'demo-humanoid-motion-set';

/** Where the web app serves model and animation files from. */
const PUBLIC_ROOT = 'apps/web/public';

export const KNIGHT_MODEL_PATH = '/assets/characters/quaternius-knight/KnightCharacter.glb';
export const UNIVERSAL_MODEL_PATH =
  '/assets/characters/quaternius-universal-base/Superhero_Female_FullBody.gltf';
const UNIVERSAL_LIBRARY_1 = '/assets/animations/quaternius-universal/AnimationLibrary_UE_Standard.glb';
const UNIVERSAL_LIBRARY_2 = '/assets/animations/quaternius-universal-2/UAL2_Standard_RM.glb';

/**
 * The UE-exported library authors translation keys in centimetres against a
 * metre-scaled rig. The value is the one the retired preset carried, so playback
 * is unchanged by the move to canonical data.
 */
const UE_POSITION_SCALE = 100;

/* ------------------------------------------------------------------ *
 * GLTF reading. Enough of the format to answer two questions:
 * which joints does this skin have, and which takes does this file hold.
 * ------------------------------------------------------------------ */

interface GltfNode {
  name?: string;
  children?: number[];
  translation?: [number, number, number];
  scale?: [number, number, number];
}

interface GltfDocument {
  nodes?: GltfNode[];
  skins?: { joints: number[] }[];
  animations?: { name?: string }[];
}

/** Reads a `.gltf` (JSON) or `.glb` (binary container) as its JSON chunk. */
export function readGltfDocument(publicPath: string): GltfDocument {
  const data = readFileSync(resolve(REPO_ROOT, PUBLIC_ROOT, publicPath.replace(/^\//, '')));
  if (data.subarray(0, 4).toString('utf8') !== 'glTF') {
    return JSON.parse(data.toString('utf8')) as GltfDocument;
  }
  // GLB: a 12-byte header, then length-prefixed chunks. The first JSON chunk
  // (type 0x4E4F534A) is the document; the rest is binary payload.
  let offset = 12;
  while (offset < data.length) {
    const length = data.readUInt32LE(offset);
    const type = data.readUInt32LE(offset + 4);
    if (type === 0x4e4f534a) {
      return JSON.parse(data.subarray(offset + 8, offset + 8 + length).toString('utf8')) as GltfDocument;
    }
    offset += 8 + length;
  }
  throw new Error(`${publicPath} is a GLB with no JSON chunk`);
}

export function animationNames(document: GltfDocument): string[] {
  return (document.animations ?? []).map((animation, index) => animation.name ?? `animation-${index}`);
}

/**
 * The skinned skeleton as canonical bones, in joint order.
 *
 * Rest positions are accumulated down the node hierarchy, so they are model
 * space — the same convention the demo rig's hand-authored rest positions use.
 * Nodes are visited from the roots, so a parent's accumulated position is always
 * known before its children need it.
 */
export function readSkeleton(
  document: GltfDocument,
  id: string,
  humanoidByBone: Readonly<Record<string, string>>,
): SkeletonDefinition {
  const nodes = document.nodes ?? [];
  const skin = document.skins?.[0];
  if (!skin) throw new Error(`${id}: the document has no skin to read a skeleton from`);

  const jointSet = new Set(skin.joints);
  const parentOf = new Map<number, number>();
  for (const [index, node] of nodes.entries()) {
    for (const child of node.children ?? []) parentOf.set(child, index);
  }

  /*
   * Accumulated position *and* scale. The scale matters: Blender-exported
   * armatures routinely sit under a node scaled by 100, so reading translations
   * alone describes a two-centimetre skeleton. `height` normalizes retargeted
   * clips, so getting this wrong would not be cosmetic.
   */
  interface RestTransform {
    position: { x: number; y: number; z: number };
    scale: [number, number, number];
  }
  const modelSpace = new Map<number, RestTransform>();
  const transformOf = (index: number): RestTransform => {
    const cached = modelSpace.get(index);
    if (cached) return cached;
    const node = nodes[index];
    const local = node?.translation ?? [0, 0, 0];
    const localScale = node?.scale ?? [1, 1, 1];
    const parent = parentOf.get(index);
    const base: RestTransform =
      parent === undefined
        ? { position: { x: 0, y: 0, z: 0 }, scale: [1, 1, 1] }
        : transformOf(parent);
    const transform: RestTransform = {
      position: {
        x: round(base.position.x + local[0] * base.scale[0]),
        y: round(base.position.y + local[1] * base.scale[1]),
        z: round(base.position.z + local[2] * base.scale[2]),
      },
      scale: [
        base.scale[0] * localScale[0],
        base.scale[1] * localScale[1],
        base.scale[2] * localScale[2],
      ],
    };
    modelSpace.set(index, transform);
    return transform;
  };
  const positionOf = (index: number): { x: number; y: number; z: number } =>
    transformOf(index).position;

  const bones: SkeletonBone[] = skin.joints.map((jointIndex) => {
    const name = nodes[jointIndex]?.name ?? `joint-${jointIndex}`;
    const parentIndex = parentOf.get(jointIndex);
    const parentName =
      parentIndex !== undefined && jointSet.has(parentIndex)
        ? (nodes[parentIndex]?.name ?? `joint-${parentIndex}`)
        : null;
    const bone: SkeletonBone = {
      name,
      parent: parentName,
      restPosition: positionOf(jointIndex),
    };
    const humanoid = humanoidByBone[name];
    if (humanoid) bone.humanoid = humanoid;
    return bone;
  });

  const height = round(
    Math.max(...bones.map((bone) => bone.restPosition.y)) -
      Math.min(...bones.map((bone) => bone.restPosition.y)),
  );

  return {
    schemaVersion: 2,
    id,
    // A rig's height normalizes retargeted clips, so it must be a real number
    // even when a model's joints happen to sit in a shallow band.
    height: height >= 0.1 ? height : 1.8,
    bones,
    hipsBone: nameFor(humanoidByBone, 'Hips'),
    leftFootBone: nameFor(humanoidByBone, 'LeftFoot'),
    rightFootBone: nameFor(humanoidByBone, 'RightFoot'),
  };
}

function nameFor(humanoidByBone: Readonly<Record<string, string>>, humanoid: string): string {
  const found = Object.entries(humanoidByBone).find(([, slot]) => slot === humanoid);
  if (!found) throw new Error(`no bone is mapped to ${humanoid}`);
  return found[0];
}

/** Six decimal places: enough for millimetre rest positions, stable across runs. */
function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/* ------------------------------------------------------------------ *
 * The two imported rigs.
 * ------------------------------------------------------------------ */

/**
 * Knight bone names, from `KnightCharacter.glb`. The Knight rig is *not*
 * Quaternius-universal: it is a 31-bone armature with `Palm.R` where the
 * universal rig has `hand_r`, so its `compatibilityKey` differs and the
 * universal animation libraries are correctly reported as needing a retarget
 * rather than silently half-playing (§3.8, and the reason the Knight's missing
 * `rigId` had to be resolved before it could become canonical).
 */
const KNIGHT_HUMANOID_BONES = {
  Hips: 'Hips',
  Abdomen: 'Spine',
  Torso: 'Chest',
  Head: 'Head',
  'Foot.L': 'LeftFoot',
  'Foot.R': 'RightFoot',
  'Palm.L': 'LeftHand',
  'Palm.R': 'RightHand',
} as const;

const UNIVERSAL_HUMANOID_BONES = {
  pelvis: 'Hips',
  spine_01: 'Spine',
  spine_03: 'Chest',
  Head: 'Head',
  foot_l: 'LeftFoot',
  foot_r: 'RightFoot',
  hand_l: 'LeftHand',
  hand_r: 'RightHand',
} as const;

function humanoidBoneMap(
  humanoidByBone: Readonly<Record<string, string>>,
): HumanoidRigProfileAsset['humanoidBones'] {
  const slot = (name: string): string => nameFor(humanoidByBone, name);
  return {
    hips: slot('Hips'),
    spine: slot('Spine'),
    chest: slot('Chest'),
    head: slot('Head'),
    leftFoot: slot('LeftFoot'),
    rightFoot: slot('RightFoot'),
    leftHand: slot('LeftHand'),
    rightHand: slot('RightHand'),
  };
}

function rigAsset(
  id: string,
  displayName: string,
  description: string,
  compatibilityKey: string,
  modelPath: string,
  humanoidByBone: Readonly<Record<string, string>>,
): HumanoidRigProfileAsset {
  return sealAsset<HumanoidRigProfileAsset>({
    metadata: {
      schemaVersion: 2,
      assetType: 'humanoid-rig',
      id,
      version: '1.0.0',
      displayName,
      description,
      tags: ['humanoid', 'imported', 'cc0'],
      createdAt: TIMESTAMP,
      createdBy: AUTHOR,
      contentHash: '',
    },
    skeleton: readSkeleton(readGltfDocument(modelPath), id, humanoidByBone),
    compatibilityKey,
    coordinateSystem: { upAxis: 'Y', forwardAxis: '+Z', handedness: 'right', unitMeters: 1 },
    humanoidBones: humanoidBoneMap(humanoidByBone),
    // Both rigs carry a full humanoid bone mapping, so a clip authored for the
    // other one can be retargeted rather than refused outright.
    retargetStatus: 'retarget-compatible',
  });
}

/* ------------------------------------------------------------------ *
 * Slot -> take mapping, per imported Character.
 * ------------------------------------------------------------------ */

/** The Behavior's slots, in the order the motion set binds them. */
const SLOTS = [
  'locomotion.idle',
  'locomotion.walk',
  'locomotion.run',
  'airborne.jump',
  'airborne.fall',
  'airborne.land',
  'state.slide',
  'state.action-none',
  'action.primary.01',
  'state.attack-01-recovery',
  'action.primary.02',
  'state.attack-02-recovery',
  'mobility.dodge',
  'state.guard',
  'state.guard-shield',
  'state.hit',
] as const;

type Slot = (typeof SLOTS)[number];

/** A short, stable clip-id suffix per slot. Ids are data; they may not drift. */
const SLOT_SUFFIX: Record<Slot, string> = {
  'locomotion.idle': 'idle',
  'locomotion.walk': 'walk',
  'locomotion.run': 'run',
  'airborne.jump': 'jump',
  'airborne.fall': 'fall',
  'airborne.land': 'land',
  'state.slide': 'slide',
  'state.action-none': 'action-none',
  'action.primary.01': 'attack-01',
  'state.attack-01-recovery': 'attack-01-recovery',
  'action.primary.02': 'attack-02',
  'state.attack-02-recovery': 'attack-02-recovery',
  'mobility.dodge': 'dodge',
  'state.guard': 'guard',
  'state.guard-shield': 'guard-shield',
  'state.hit': 'hit',
};

/**
 * The Knight's takes, all embedded in its own model file.
 *
 * `HumanArmature|Jump` covers jump, fall and land: the file has one jump take
 * and no separate airborne loop. That is stated here rather than papered over
 * with a slot fallback, because "these three slots deliberately share one take"
 * and "this slot has no clip" are different facts.
 */
/** A take embedded in the Knight's own model file. No position rescaling. */
function fromKnightModel(animationName: string): TakeBinding {
  return { assetPath: KNIGHT_MODEL_PATH, animationName };
}

const KNIGHT_TAKES: Record<Slot, TakeBinding> = {
  'locomotion.idle': fromKnightModel('HumanArmature|Idle'),
  'locomotion.walk': fromKnightModel('HumanArmature|Walking'),
  'locomotion.run': fromKnightModel('HumanArmature|Run'),
  'airborne.jump': fromKnightModel('HumanArmature|Jump'),
  'airborne.fall': fromKnightModel('HumanArmature|Jump'),
  'airborne.land': fromKnightModel('HumanArmature|Jump'),
  'state.slide': fromKnightModel('HumanArmature|Roll'),
  'state.action-none': fromKnightModel('HumanArmature|Idle'),
  'action.primary.01': fromKnightModel('HumanArmature|Run_swordAttack'),
  'state.attack-01-recovery': fromKnightModel('HumanArmature|Idle_swordRight'),
  'action.primary.02': fromKnightModel('HumanArmature|swordAttackJump'),
  'state.attack-02-recovery': fromKnightModel('HumanArmature|Idle_swordRight'),
  'mobility.dodge': fromKnightModel('HumanArmature|Roll'),
  'state.guard': fromKnightModel('HumanArmature|Idle_swordLeft'),
  'state.guard-shield': fromKnightModel('HumanArmature|Idle_swordLeft'),
  'state.hit': fromKnightModel('HumanArmature|Death'),
};

interface TakeBinding {
  assetPath: string;
  animationName: string;
  positionScale?: number;
}

const fromLibrary1 = (animationName: string): TakeBinding => ({
  assetPath: UNIVERSAL_LIBRARY_1,
  animationName,
  positionScale: UE_POSITION_SCALE,
});

const fromLibrary2 = (animationName: string): TakeBinding => ({
  assetPath: UNIVERSAL_LIBRARY_2,
  animationName,
});

/** The Universal Base's unarmed takes. Its own model file carries none. */
const UNIVERSAL_TAKES: Record<Slot, TakeBinding> = {
  'locomotion.idle': fromLibrary1('Rig|Idle_Loop'),
  'locomotion.walk': fromLibrary1('Rig|Walk_Loop'),
  'locomotion.run': fromLibrary1('Rig|Sprint_Loop'),
  'airborne.jump': fromLibrary1('Rig|Jump_Start'),
  'airborne.fall': fromLibrary1('Rig|Jump_Loop'),
  'airborne.land': fromLibrary1('Rig|Jump_Land'),
  'state.slide': fromLibrary1('Rig|Crouch_Fwd_Loop'),
  'state.action-none': fromLibrary1('Rig|Idle_Loop'),
  'action.primary.01': fromLibrary1('Rig|Punch_Jab'),
  'state.attack-01-recovery': fromLibrary1('Rig|Idle_Loop'),
  'action.primary.02': fromLibrary1('Rig|Punch_Cross'),
  'state.attack-02-recovery': fromLibrary1('Rig|Idle_Loop'),
  'mobility.dodge': fromLibrary1('Rig|Roll'),
  'state.guard': fromLibrary1('Rig|Sword_Idle'),
  'state.guard-shield': fromLibrary1('Rig|Sword_Idle'),
  'state.hit': fromLibrary1('Rig|Hit_Chest'),
};

/**
 * Per-weapon takes for the Universal Base, replacing `WeaponMode.clipMap`.
 *
 * These are the retired maps, moved verbatim except for one correction that the
 * move itself exposed: the sword mode's `idle`/`guard` entries named
 * `Rig|Sword_Idle`, a take that exists in the *first* library, while the mode
 * loaded the *second*. Nothing found it, so `animations.find(...)` returned
 * undefined and the previous clip simply stayed on screen — a mismatch a
 * renderer-side map can hold indefinitely and a canonical binding cannot, since
 * the harness now checks every take name against the file it names.
 */
const UNIVERSAL_CONTEXT_TAKES: Record<string, Partial<Record<Slot, TakeBinding>>> = {
  sword: {
    'locomotion.idle': fromLibrary2('Idle_No_Loop'),
    'state.action-none': fromLibrary2('Idle_No_Loop'),
    'state.guard': fromLibrary2('Sword_Block'),
    'state.guard-shield': fromLibrary2('Idle_Shield_Loop'),
    'action.primary.01': fromLibrary2('Sword_Regular_A'),
    'state.attack-01-recovery': fromLibrary2('Sword_Regular_A_Rec'),
    'action.primary.02': fromLibrary2('Sword_Regular_B'),
    'state.attack-02-recovery': fromLibrary2('Sword_Regular_B_Rec'),
  },
  magic: {
    'locomotion.idle': fromLibrary1('Rig|Spell_Simple_Idle_Loop'),
    'state.action-none': fromLibrary1('Rig|Spell_Simple_Idle_Loop'),
    'state.guard': fromLibrary1('Rig|Spell_Simple_Idle_Loop'),
    'action.primary.01': fromLibrary1('Rig|Spell_Simple_Shoot'),
    'state.attack-01-recovery': fromLibrary1('Rig|Spell_Simple_Exit'),
    'action.primary.02': fromLibrary1('Rig|Spell_Simple_Enter'),
    'state.attack-02-recovery': fromLibrary1('Rig|Spell_Simple_Exit'),
  },
  pistol: {
    'locomotion.idle': fromLibrary1('Rig|Pistol_Idle_Loop'),
    'state.action-none': fromLibrary1('Rig|Pistol_Idle_Loop'),
    'state.guard': fromLibrary1('Rig|Pistol_Aim_Neutral'),
    'action.primary.01': fromLibrary1('Rig|Pistol_Shoot'),
    'state.attack-01-recovery': fromLibrary1('Rig|Pistol_Idle_Loop'),
    'action.primary.02': fromLibrary1('Rig|Pistol_Reload'),
    'state.attack-02-recovery': fromLibrary1('Rig|Pistol_Idle_Loop'),
  },
  shield: {
    'locomotion.idle': fromLibrary2('Idle_Shield_Loop'),
    'state.action-none': fromLibrary2('Idle_Shield_Loop'),
    'state.guard': fromLibrary2('Idle_Shield_Loop'),
    'state.guard-shield': fromLibrary2('Idle_Shield_Loop'),
    'action.primary.01': fromLibrary2('Shield_OneShot'),
    'state.attack-01-recovery': fromLibrary2('Idle_Shield_Loop'),
    'action.primary.02': fromLibrary2('Shield_Dash'),
    'state.attack-02-recovery': fromLibrary2('Idle_Shield_Loop'),
  },
  throw: {
    'locomotion.idle': fromLibrary2('Idle_No_Loop'),
    'state.action-none': fromLibrary2('Idle_No_Loop'),
    'state.guard': fromLibrary2('Idle_No_Loop'),
    'action.primary.01': fromLibrary2('OverhandThrow'),
    'state.attack-01-recovery': fromLibrary2('Idle_No_Loop'),
    'action.primary.02': fromLibrary2('OverhandThrow'),
    'state.attack-02-recovery': fromLibrary2('Idle_No_Loop'),
  },
};

/* ------------------------------------------------------------------ *
 * Authoring.
 * ------------------------------------------------------------------ */

interface AuthoredAssets {
  rigs: HumanoidRigProfileAsset[];
  clips: AnimationClipAsset[];
  motionSets: AnimationMotionSetAsset[];
}

function reference(asset: {
  metadata: { assetType: AssetReference['assetType']; id: string; version: string; contentHash: string };
}): AssetReference {
  return {
    assetType: asset.metadata.assetType,
    assetId: asset.metadata.id,
    version: asset.metadata.version,
    contentHash: asset.metadata.contentHash,
  };
}

/**
 * The timing template for one slot and context: the demo Character's clip for
 * the same binding. Falling back to the unkeyed binding is deliberate — a
 * weapon-specific slot the demo set does not distinguish still needs timing, and
 * the base clip's timing is what the Behavior's transitions were tuned against.
 */
function timingTemplate(
  templates: Map<string, AnimationClipDefinition>,
  slot: Slot,
  contextualKey?: string,
): AnimationClipDefinition {
  const keyed = contextualKey ? templates.get(`${slot} ${contextualKey}`) : undefined;
  const template = keyed ?? templates.get(`${slot} `);
  if (!template) throw new Error(`no timing template for ${slot}${contextualKey ? `/${contextualKey}` : ''}`);
  return template;
}

function clipAsset(
  id: string,
  displayName: string,
  rigId: string,
  template: AnimationClipDefinition,
  source: ExternalAnimationSource,
  note: string,
): AnimationClipAsset {
  const { provenance: _provenance, protection: _protection, ...timing } = template;
  const clip: AnimationClipDefinition = {
    ...timing,
    id,
    // `assetPath` names the file; `externalSource` names the take inside it.
    // Both, because a path alone is what made a renderer-side map necessary.
    assetPath: source.assetPath,
    externalSource: source,
  };
  delete clip.proceduralGenerator;
  return sealAsset<AnimationClipAsset>({
    metadata: {
      schemaVersion: 2,
      assetType: 'animation-clip',
      id,
      version: '1.0.0',
      displayName,
      description: note,
      tags: ['imported', 'cc0', ...(clip.loop ? ['loop'] : [])],
      createdAt: TIMESTAMP,
      createdBy: AUTHOR,
      contentHash: '',
    },
    clip,
    compatibleRigIds: [rigId],
  });
}

function authorImportedCharacter(options: {
  idPrefix: string;
  displayName: string;
  rig: HumanoidRigProfileAsset;
  motionSetId: string;
  templates: Map<string, AnimationClipDefinition>;
  /** The unkeyed take per slot. */
  takes: Record<Slot, TakeBinding>;
  /** Contextual takes per weapon-mode key. */
  contextTakes?: Record<string, Partial<Record<Slot, TakeBinding>>>;
}): { clips: AnimationClipAsset[]; motionSet: AnimationMotionSetAsset } {
  const clips: AnimationClipAsset[] = [];
  const bindings: MotionSetBinding[] = [];

  const emit = (slot: Slot, take: TakeBinding, contextualKey?: string): void => {
    const id = contextualKey
      ? `${options.idPrefix}-${contextualKey}-${SLOT_SUFFIX[slot]}`
      : `${options.idPrefix}-${SLOT_SUFFIX[slot]}`;
    const source: ExternalAnimationSource = {
      assetPath: take.assetPath,
      animationName: take.animationName,
      ...(take.positionScale === undefined ? {} : { positionScale: take.positionScale }),
    };
    const asset = clipAsset(
      id,
      `${options.displayName} ${SLOT_SUFFIX[slot].replace(/-/g, ' ')}${contextualKey ? ` (${contextualKey})` : ''}`,
      options.rig.metadata.id,
      timingTemplate(options.templates, slot, contextualKey),
      source,
      `${options.displayName}: "${take.animationName}" from ${take.assetPath}. Timing inherited from the demo Character's ${slot} clip.`,
    );
    clips.push(asset);
    bindings.push({
      motionSlot: slot,
      clip: reference(asset),
      ...(contextualKey ? { contextualKey } : {}),
    });
  };

  for (const slot of SLOTS) emit(slot, options.takes[slot]);
  for (const contextualKey of Object.keys(options.contextTakes ?? {}).sort()) {
    const perSlot = options.contextTakes![contextualKey]!;
    for (const slot of SLOTS) {
      const take = perSlot[slot];
      if (take) emit(slot, take, contextualKey);
    }
  }

  const motionSet = sealAsset<AnimationMotionSetAsset>({
    metadata: {
      schemaVersion: 2,
      assetType: 'animation-motion-set',
      id: options.motionSetId,
      version: '1.0.0',
      displayName: `${options.displayName} motion set`,
      description: `Canonical bindings from the shared Behavior's motion slots to takes inside ${options.displayName}'s imported animation files.`,
      tags: ['imported', 'cc0'],
      createdAt: TIMESTAMP,
      createdBy: AUTHOR,
      contentHash: '',
    },
    compatibleBehaviorIds: [BEHAVIOR_ID],
    rig: reference(options.rig),
    bindings,
    fallbackBindings: [],
  });

  return { clips, motionSet };
}

/** Slot (+ optional context) -> the demo Character's clip for that binding. */
function timingTemplates(): Map<string, AnimationClipDefinition> {
  const stored = loadStoredAssets();
  const set = stored.find(
    (asset) => asset.assetType === 'animation-motion-set' && asset.id === TEMPLATE_MOTION_SET_ID,
  )?.document as AnimationMotionSetAsset | undefined;
  if (!set) throw new Error(`${TEMPLATE_MOTION_SET_ID} is not on disk`);

  const templates = new Map<string, AnimationClipDefinition>();
  for (const binding of set.bindings) {
    const clip = stored.find(
      (asset) =>
        asset.assetType === 'animation-clip' &&
        asset.id === binding.clip.assetId &&
        asset.version === binding.clip.version,
    )?.document as AnimationClipAsset | undefined;
    if (!clip) throw new Error(`clip ${binding.clip.assetId} is not on disk`);
    templates.set(`${binding.motionSlot} ${binding.contextualKey ?? ''}`, clip.clip);
  }
  return templates;
}

export function authorImportedCharacterAssets(): AuthoredAssets {
  const templates = timingTemplates();

  const knightRig = rigAsset(
    'quaternius-knight-rig',
    'Quaternius Knight rig',
    'The 31-bone armature inside KnightCharacter.glb. Read from the model, not restated.',
    'quaternius-knight',
    KNIGHT_MODEL_PATH,
    KNIGHT_HUMANOID_BONES,
  );
  const universalRig = rigAsset(
    'quaternius-universal-rig',
    'Quaternius Universal rig',
    'The 65-bone UE-style armature the Quaternius universal animation libraries were authored against.',
    'quaternius-universal',
    UNIVERSAL_MODEL_PATH,
    UNIVERSAL_HUMANOID_BONES,
  );

  const knight = authorImportedCharacter({
    idPrefix: 'knight',
    displayName: 'Quaternius Knight',
    rig: knightRig,
    motionSetId: 'quaternius-knight-motion-set',
    templates,
    takes: KNIGHT_TAKES,
  });

  const universal = authorImportedCharacter({
    idPrefix: 'universal',
    displayName: 'Universal Base',
    rig: universalRig,
    motionSetId: 'quaternius-universal-motion-set',
    templates,
    takes: UNIVERSAL_TAKES,
    contextTakes: UNIVERSAL_CONTEXT_TAKES,
  });

  return {
    rigs: [knightRig, universalRig],
    clips: [...knight.clips, ...universal.clips],
    motionSets: [knight.motionSet, universal.motionSet],
  };
}

/** Every authored file, path and content, in a stable order. */
export function authoredAssetFiles(): { path: string; content: string }[] {
  const authored = authorImportedCharacterAssets();
  const documents = [...authored.rigs, ...authored.clips, ...authored.motionSets];
  return documents
    .map((document) => ({
      path: assetFilePath(
        document.metadata.assetType,
        document.metadata.id,
        document.metadata.version,
      ),
      content: `${JSON.stringify(document, null, 2)}\n`,
    }))
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

/**
 * Verifies every authored take name exists in the file it names.
 *
 * This is the check the retired renderer-side maps could never fail: a name that
 * matched nothing produced no error, just the previous clip staying on screen.
 */
export function unknownTakeReferences(): string[] {
  const authored = authorImportedCharacterAssets();
  const namesByPath = new Map<string, Set<string>>();
  const unknown: string[] = [];
  for (const asset of authored.clips) {
    const source = asset.clip.externalSource;
    if (!source) continue;
    let names = namesByPath.get(source.assetPath);
    if (!names) {
      names = new Set(animationNames(readGltfDocument(source.assetPath)));
      namesByPath.set(source.assetPath, names);
    }
    if (!names.has(source.animationName)) {
      unknown.push(`${asset.metadata.id}: "${source.animationName}" is not in ${source.assetPath}`);
    }
  }
  return unknown;
}

function main(): void {
  const unknown = unknownTakeReferences();
  if (unknown.length > 0) {
    for (const line of unknown) console.error(`  ${line}`);
    throw new Error(`${unknown.length} authored take(s) name an animation their file does not contain`);
  }
  const files = authoredAssetFiles();
  for (const file of files) writeRepoFile(file.path, file.content);
  console.log(`wrote ${files.length} imported-character asset file(s)`);
}

if (process.argv[1]?.includes('generate-imported-character-assets')) main();
