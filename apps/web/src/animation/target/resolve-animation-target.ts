/**
 * Everything the animation tools need about one target instance.
 *
 * The preview and the graph both used to read `state.project` — one globally
 * resolved document — and list its states. That works exactly as long as every
 * instance in the world resolves to the same behaviour, which is a property of
 * the demo project rather than of the model. The moment instance A references
 * character A and instance B references character B, a global state list offers
 * the user B's states while previewing A, and the mismatch surfaces as an empty
 * pose rather than as an error.
 *
 * So resolution starts from the instance and goes through the same path the
 * live world takes: `WorldRuntime` already resolved each instance's document
 * when it built the world, and this reads that rather than resolving a second
 * time. Two resolutions of the same inputs are two chances to disagree, and the
 * one the user is looking at would be the one that is not running.
 */
import type {
  AssetReference,
  CharacterDefinition,
  ProjectDefinition,
  ResolvedProject,
  RuntimeInstanceDefinition,
  StateDefinition,
  WorldDefinition,
} from '@atc/schema';
import { clipForState, resolveWeaponMode, slotForState } from '@atc/animation-runtime';

/**
 * The read-only seam the resolver pulls from.
 *
 * An interface rather than the store so this is unit-testable without a
 * browser, and so the sandbox can be handed the same shape without importing
 * React.
 */
export interface AnimationTargetSource {
  world: WorldDefinition;
  project: ProjectDefinition;
  /** The instance's live resolved document, or null if it is not running. */
  resolvedProjectFor(instanceId: string): ResolvedProject | null;
  /** The instance's effective loadout — definition default plus its overrides. */
  loadoutFor(
    instanceId: string,
  ): { weaponModeId: string; equipment: Record<string, boolean> } | null;
}

export interface ResolvedAnimationTarget {
  instanceId: string;
  instance: RuntimeInstanceDefinition;
  characterId: string;
  character: CharacterDefinition;
  /**
   * The document as this instance's simulation reads it: the instance's own
   * resolved project with its effective weapon mode folded in. Not shared with
   * another instance, and never the global `state.project`.
   */
  resolvedProject: ResolvedProject;
  effectiveWeaponModeId: string;
  effectiveEquipment: Record<string, boolean>;
  behaviorRef: AssetReference;
  motionSetRef: AssetReference;
  rigRef: AssetReference;
  tuningRef?: AssetReference;
}

export type AnimationTargetFailure =
  | { code: 'unknown-instance'; instanceId: string }
  | { code: 'unknown-character'; instanceId: string; characterId: string }
  | { code: 'not-resolved'; instanceId: string };

export type AnimationTargetResult =
  | { ok: true; target: ResolvedAnimationTarget }
  | { ok: false; failure: AnimationTargetFailure };

export function resolveAnimationTarget(
  source: AnimationTargetSource,
  instanceId: string,
): AnimationTargetResult {
  const instance = source.world.instances.find((entry) => entry.id === instanceId);
  if (!instance) return { ok: false, failure: { code: 'unknown-instance', instanceId } };

  const characterId = instance.source.characterId;
  const character = source.project.characters.find((entry) => entry.id === characterId);
  if (!character) {
    return { ok: false, failure: { code: 'unknown-character', instanceId, characterId } };
  }

  const base = source.resolvedProjectFor(instanceId);
  if (!base) return { ok: false, failure: { code: 'not-resolved', instanceId } };

  const loadout = source.loadoutFor(instanceId);
  const effectiveWeaponModeId = loadout?.weaponModeId ?? 'unarmed';
  const effectiveEquipment = loadout?.equipment ?? {};

  const tuning = character.animation.tuning;
  return {
    ok: true,
    target: {
      instanceId,
      instance,
      characterId,
      character,
      // Exactly what `Simulation` does with its own base document, so the clip
      // a panel names is the clip the tick would play.
      resolvedProject: resolveWeaponMode(base, effectiveWeaponModeId),
      effectiveWeaponModeId,
      effectiveEquipment,
      behaviorRef: character.animation.behavior,
      motionSetRef: character.animation.motionSet,
      rigRef: character.animation.rig,
      ...(tuning ? { tuningRef: tuning } : {}),
    },
  };
}

/** States on one layer of the *target's* behaviour, in authored order. */
export function statesOnLayer(
  target: ResolvedAnimationTarget,
  layer: string,
): StateDefinition[] {
  return target.resolvedProject.graph.states.filter((state) => state.layer === layer);
}

/** Layer ids the target's behaviour actually declares. */
export function layersOf(target: ResolvedAnimationTarget): string[] {
  return target.resolvedProject.graph.layers
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((layer) => layer.id);
}

export interface ResolvedStateClip {
  stateId: string;
  motionSlot: string;
  clipId: string | null;
  durationSec: number;
  /** The contextual selector in force — the weapon mode, in the demo project. */
  contextKey: string;
}

/**
 * What a state resolves to for this target, right now.
 *
 * The context key is the target's *effective* weapon mode rather than a global
 * one, which is the difference between "this instance's sword attack" and
 * "whatever weapon the last panel happened to leave selected".
 */
export function resolveStateClip(
  target: ResolvedAnimationTarget,
  stateId: string,
): ResolvedStateClip | null {
  const state = target.resolvedProject.graph.states.find((entry) => entry.id === stateId);
  if (!state) return null;
  const contextKey = target.effectiveWeaponModeId;
  const clip = clipForState(target.resolvedProject, stateId, contextKey);
  return {
    stateId,
    motionSlot: slotForState(state, { contextKey }),
    clipId: clip?.id ?? null,
    // A state whose slot has no binding has no duration to play. Zero rather
    // than a fabricated default: the transport must be able to say "nothing to
    // preview" instead of looping an imaginary second of nothing.
    durationSec: clip?.durationSec ?? 0,
    contextKey,
  };
}

/**
 * Clips reachable through this target's motion set, deduplicated.
 *
 * Deliberately not "every clip in the repository": the by-clip source exists to
 * inspect what this character can actually play, and a list of a thousand
 * unrelated clips is a worse answer than no list. The full catalogue is one
 * link away in Project / Assets.
 */
export function reachableClips(
  target: ResolvedAnimationTarget,
): { id: string; durationSec: number }[] {
  const bound = new Set<string>();
  for (const clipId of Object.values(target.resolvedProject.motionBindings)) bound.add(clipId);
  for (const context of Object.values(target.resolvedProject.contextualMotionBindings)) {
    for (const clipId of Object.values(context)) bound.add(clipId);
  }
  return target.resolvedProject.clips
    .filter((clip) => bound.has(clip.id))
    .map((clip) => ({ id: clip.id, durationSec: clip.durationSec }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function describeAnimationTargetFailure(failure: AnimationTargetFailure): string {
  switch (failure.code) {
    case 'unknown-instance':
      return `Instance “${failure.instanceId}” is not in this world.`;
    case 'unknown-character':
      return `Instance “${failure.instanceId}” references unknown character “${failure.characterId}”.`;
    case 'not-resolved':
      return `Instance “${failure.instanceId}” has no resolved animation document yet.`;
  }
}

/**
 * The two things an animation workspace can be pointed at.
 *
 * Character Lab previews a *definition* — there is no Instance, and requiring
 * one would mean placing a character into a world just to look at it. World
 * previews an *Instance*, because that is what has a loadout, a transform and a
 * running simulation.
 *
 * One workspace, two subject adapters. Two Clip Previews would be two
 * implementations of "play this clip", and they would drift.
 */
export type AnimationSubject =
  | { kind: 'character-lab'; characterId: string }
  | { kind: 'world-instance'; instanceId: string };

/**
 * A resolved target for a Character Definition with no Instance behind it.
 *
 * The `instanceId` is a synthetic label rather than a real id, and it is never
 * looked up in a world: nothing downstream may treat a Character Lab subject as
 * something placed. The read-side pose override is keyed on it, and no live
 * instance can collide with a name that is not a legal instance id.
 */
export const CHARACTER_LAB_SUBJECT_ID = 'character-lab:preview';

export function resolveCharacterLabTarget(input: {
  project: ProjectDefinition;
  resolvedProject: ResolvedProject;
  characterId: string;
  weaponModeId: string;
  equipment: Record<string, boolean>;
}): AnimationTargetResult {
  const character = input.project.characters.find((entry) => entry.id === input.characterId);
  if (!character) {
    return {
      ok: false,
      failure: {
        code: 'unknown-character',
        instanceId: CHARACTER_LAB_SUBJECT_ID,
        characterId: input.characterId,
      },
    };
  }
  const tuning = character.animation.tuning;
  return {
    ok: true,
    target: {
      instanceId: CHARACTER_LAB_SUBJECT_ID,
      // There is no Runtime Instance. A synthetic declaration keeps the shape
      // uniform without pretending something is placed in a world.
      instance: {
        schemaVersion: character.schemaVersion,
        id: CHARACTER_LAB_SUBJECT_ID,
        displayName: `${character.displayName} (Character Lab Preview)`,
        source: { kind: 'character', characterId: character.id },
        transform: { position: { x: 0, y: 0, z: 0 }, yawRad: 0 },
        intentSource: { kind: 'none' },
        enabled: true,
      } as RuntimeInstanceDefinition,
      characterId: character.id,
      character,
      resolvedProject: resolveWeaponMode(input.resolvedProject, input.weaponModeId),
      effectiveWeaponModeId: input.weaponModeId,
      effectiveEquipment: input.equipment,
      behaviorRef: character.animation.behavior,
      motionSetRef: character.animation.motionSet,
      rigRef: character.animation.rig,
      ...(tuning ? { tuningRef: tuning } : {}),
    },
  };
}
