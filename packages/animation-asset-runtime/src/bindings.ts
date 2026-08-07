/**
 * The Character binding inventory (work package §4).
 *
 * One function answers, for every Character in a project: which model, which
 * rig, which Behavior, which Motion Set, which Tuning, how many instance
 * overrides — and, for each of those, *who else holds the same reference*.
 *
 * There is deliberately exactly one implementation. The failure this prevents
 * is not a wrong number in a panel; it is two panels disagreeing. A "shared by
 * 3" badge, a save dialog's blast-radius warning and a test asserting isolation
 * are the same question asked three times, and if each counts holders its own
 * way then the badge can say "only this character" while the save reaches four.
 * Everything downstream — the Rig Editor's Character Overview, the sharing
 * warnings, the audit report, the tests — reads this.
 *
 * Pure, and free of both React and the filesystem: ownership is a property of a
 * project document plus a registry, so proving it needs neither a DOM nor a
 * disk.
 */
import type {
  AnimationMotionSetAsset,
  AssetReference,
  CharacterDefinition,
  CharacterModelBinding,
  HumanoidRigProfileAsset,
  ProjectDefinition,
  RetargetStatus,
} from '@atc/schema';
import { referenceKey } from '@atc/schema';
import type { AnimationAssetRegistry } from './registry.ts';
import { retargetStatusBetween } from './compatibility.ts';

/**
 * How a reference is held, once the holders are known.
 *
 *   only-this-character — nobody else references it. Editing it in place is
 *                        safe, and the UI may say so.
 *   shared             — at least one other Character holds the same
 *                        reference. Editing it in place changes their runtime
 *                        too, which the human must be told *before* saving.
 *   inherited          — resolved from a parent asset rather than named here.
 *   overridden         — this Character replaces the shared value locally.
 */
export type BindingOwnership =
  | 'only-this-character'
  | 'shared'
  | 'inherited'
  | 'overridden';

export interface BindingFact {
  reference: AssetReference;
  /** Every Character id holding this reference, including this one. Sorted. */
  usedByCharacterIds: string[];
  ownership: BindingOwnership;
}

export interface ModelBindingFact {
  binding: CharacterModelBinding;
  kind: CharacterModelBinding['kind'];
  /** Preset id or repository path — whichever identifies this model. */
  idOrPath: string;
  usedByCharacterIds: string[];
  ownership: BindingOwnership;
}

/**
 * Whether the Character's rig can play the clips its motion set binds.
 *
 * `status` is absent when the assets needed to judge it are not in the registry;
 * an unknown answer is reported as unknown rather than as "compatible", because
 * a green badge nobody checked is worse than no badge.
 */
export interface RigCompatibilityFact {
  /** The rig the Character's clips were authored against, per its motion set. */
  motionSetRigId: string;
  /** The rig the Character declares. These usually agree; when they don't, say so. */
  characterRigId: string;
  status?: RetargetStatus;
  /** Present only when the two rigs cannot play each other's clips directly. */
  detail?: string;
}

export interface CharacterBindingDescription {
  characterId: string;
  displayName: string;
  model: ModelBindingFact;
  rig: BindingFact;
  behavior: BindingFact;
  motionSet: BindingFact;
  tuning?: BindingFact;
  rigCompatibility: RigCompatibilityFact;
  instanceOverrideCount: number;
  /** Canonical paths this Character overrides locally. Sorted, for display. */
  instanceOverridePaths: string[];
}

/** What identifies a model binding for equality and display. */
export function modelBindingKey(binding: CharacterModelBinding): string {
  return binding.kind === 'procedural-humanoid'
    ? `procedural-humanoid:${binding.presetId}`
    : `repository-model:${binding.assetPath}`;
}

/** The part of the key a human reads: a preset id or a repository path. */
export function modelBindingIdOrPath(binding: CharacterModelBinding): string {
  return binding.kind === 'procedural-humanoid' ? binding.presetId : binding.assetPath;
}

function ownershipFor(holders: readonly string[], overridden: boolean): BindingOwnership {
  if (overridden) return 'overridden';
  return holders.length > 1 ? 'shared' : 'only-this-character';
}

/**
 * Characters holding the same reference.
 *
 * Compared by `referenceKey` — type, id and version — so two Characters on
 * *different versions* of one asset are correctly reported as not sharing it.
 * They are not: publishing over one of those versions reaches only its holders.
 */
function charactersHolding(
  characters: readonly CharacterDefinition[],
  reference: AssetReference,
  select: (character: CharacterDefinition) => AssetReference | undefined,
): string[] {
  const target = referenceKey(reference);
  return characters
    .filter((character) => {
      const held = select(character);
      return held !== undefined && referenceKey(held) === target;
    })
    .map((character) => character.id)
    .sort();
}

function rigCompatibility(
  registry: AnimationAssetRegistry,
  character: CharacterDefinition,
): RigCompatibilityFact {
  const characterRigId = character.animation.rig.assetId;
  const motionSet = registry.find(character.animation.motionSet) as
    | AnimationMotionSetAsset
    | undefined;
  const motionSetRigId = motionSet?.rig.assetId ?? characterRigId;

  const clipRig = motionSet ? (registry.find(motionSet.rig) as HumanoidRigProfileAsset | undefined) : undefined;
  const characterRig = registry.find(character.animation.rig) as HumanoidRigProfileAsset | undefined;
  if (!clipRig || !characterRig) return { motionSetRigId, characterRigId };

  const status = retargetStatusBetween(clipRig, characterRig);
  return {
    motionSetRigId,
    characterRigId,
    status,
    ...(status === 'direct-compatible'
      ? {}
      : {
          detail: `${clipRig.metadata.id} (${clipRig.compatibilityKey}) vs ${characterRig.metadata.id} (${characterRig.compatibilityKey})`,
        }),
  };
}

/**
 * The whole inventory, one entry per Character, in project order.
 *
 * Project order rather than sorted: `/characters` and the Rig Editor both list
 * Characters in the order the repository declares them, and an inventory that
 * silently reordered them would make the two lists disagree about which row is
 * which.
 */
export function describeCharacterBindings(
  project: ProjectDefinition,
  registry: AnimationAssetRegistry,
): CharacterBindingDescription[] {
  const characters = project.characters;

  return characters.map((character) => {
    const { animation } = character;

    const modelKey = modelBindingKey(character.model);
    const modelHolders = characters
      .filter((entry) => modelBindingKey(entry.model) === modelKey)
      .map((entry) => entry.id)
      .sort();

    const behaviorHolders = charactersHolding(
      characters,
      animation.behavior,
      (entry) => entry.animation.behavior,
    );
    const rigHolders = charactersHolding(characters, animation.rig, (entry) => entry.animation.rig);
    const motionSetHolders = charactersHolding(
      characters,
      animation.motionSet,
      (entry) => entry.animation.motionSet,
    );

    const overridePaths = animation.instanceOverrides.map((patch) => patch.path).sort();

    const description: CharacterBindingDescription = {
      characterId: character.id,
      displayName: character.displayName,
      model: {
        binding: character.model,
        kind: character.model.kind,
        idOrPath: modelBindingIdOrPath(character.model),
        usedByCharacterIds: modelHolders,
        ownership: ownershipFor(modelHolders, false),
      },
      rig: {
        reference: animation.rig,
        usedByCharacterIds: rigHolders,
        ownership: ownershipFor(rigHolders, false),
      },
      /*
       * A shared Behavior that this Character patches locally is reported as
       * `overridden`, not `shared`: both facts are true, but the one that
       * changes a decision is "your instance overrides already diverge from the
       * shared asset here".
       */
      behavior: {
        reference: animation.behavior,
        usedByCharacterIds: behaviorHolders,
        ownership: ownershipFor(behaviorHolders, overridePaths.length > 0),
      },
      motionSet: {
        reference: animation.motionSet,
        usedByCharacterIds: motionSetHolders,
        ownership: ownershipFor(motionSetHolders, false),
      },
      rigCompatibility: rigCompatibility(registry, character),
      instanceOverrideCount: animation.instanceOverrides.length,
      instanceOverridePaths: overridePaths,
    };

    if (animation.tuning) {
      // Tuning ownership is computed, never assumed to be per-Character (§7.3).
      const tuningHolders = charactersHolding(
        characters,
        animation.tuning,
        (entry) => entry.animation.tuning,
      );
      description.tuning = {
        reference: animation.tuning,
        usedByCharacterIds: tuningHolders,
        ownership: ownershipFor(tuningHolders, false),
      };
    }

    return description;
  });
}

/** One Character's entry, or undefined when the id names nothing. */
export function describeCharacterBinding(
  project: ProjectDefinition,
  registry: AnimationAssetRegistry,
  characterId: string,
): CharacterBindingDescription | undefined {
  return describeCharacterBindings(project, registry).find(
    (entry) => entry.characterId === characterId,
  );
}

/**
 * Characters other than `characterId` that a change to `fact` would reach.
 *
 * This is the blast radius, and it is derived from the same holder lists the
 * badges use rather than recomputed — which is the whole reason this module
 * exists.
 */
export function otherHolders(fact: BindingFact | ModelBindingFact, characterId: string): string[] {
  return fact.usedByCharacterIds.filter((id) => id !== characterId);
}
