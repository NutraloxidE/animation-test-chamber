/**
 * Dependency and reverse-dependency graph (PLAN 31).
 *
 * The plan explicitly rules out a node editor for the MVP, and it is right to:
 * the two questions that actually block work are "what does this need" and
 * "what breaks if I change it", and both are lists.
 */
import type {
  AnimationBehaviorAsset,
  AnimationMotionSetAsset,
  AnimationTuningProfileAsset,
  AssetIssue,
  AssetReference,
  ProjectDefinition,
} from '@atc/schema';
import { referenceKey } from '@atc/schema';
import type { AnimationAssetRegistry } from './registry.ts';

/** Direct references held by one asset. Not transitive. */
export function directDependencies(
  registry: AnimationAssetRegistry,
  reference: AssetReference,
): AssetReference[] {
  if (registry.checkReference(reference).length > 0) return [];
  const asset = registry.get(reference);

  switch (reference.assetType) {
    case 'animation-behavior': {
      const behavior = asset as AnimationBehaviorAsset;
      if (behavior.derivation.mode === 'variant') return [behavior.derivation.parent];
      // A fork records where it came from but does not depend on it — that is
      // the point of a fork, so `forkedFrom` is provenance, not a dependency.
      return [];
    }
    case 'animation-motion-set': {
      const motionSet = asset as AnimationMotionSetAsset;
      return [motionSet.rig, ...motionSet.bindings.map((binding) => binding.clip)];
    }
    case 'animation-tuning':
      return [(asset as AnimationTuningProfileAsset).compatibleBehavior];
    case 'animation-clip':
    case 'humanoid-rig':
      return [];
  }
}

/** Everything reachable from `reference`, deduplicated, cycle-safe. */
export function transitiveDependencies(
  registry: AnimationAssetRegistry,
  reference: AssetReference,
): AssetReference[] {
  const out: AssetReference[] = [];
  const seen = new Set<string>([referenceKey(reference)]);
  const queue = [reference];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const dependency of directDependencies(registry, current)) {
      const key = referenceKey(dependency);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(dependency);
      queue.push(dependency);
    }
  }
  return out;
}

export interface UsedByEntry {
  /** The asset or character that holds the reference. */
  holder: AssetReference | { kind: 'character'; projectId: string; characterId: string };
  /** Where in the holder the reference sits, e.g. `/bindings/locomotion.idle`. */
  path: string;
}

/**
 * Who references this asset. Built by scanning, not by an index that could go
 * stale — the registry is small enough that a scan is cheaper than the bugs an
 * incrementally-maintained reverse index would cost.
 */
export function usedBy(
  registry: AnimationAssetRegistry,
  reference: AssetReference,
  projects: readonly ProjectDefinition[] = [],
): UsedByEntry[] {
  const target = referenceKey(reference);
  const entries: UsedByEntry[] = [];

  for (const stored of registry.all()) {
    const holder: AssetReference = {
      assetType: stored.assetType,
      assetId: stored.id,
      version: stored.version,
      contentHash: stored.document.metadata.contentHash,
    };
    if (referenceKey(holder) === target) continue;

    if (stored.assetType === 'animation-behavior') {
      const behavior = stored.document as AnimationBehaviorAsset;
      if (behavior.derivation.mode === 'variant' && referenceKey(behavior.derivation.parent) === target) {
        entries.push({ holder, path: '/derivation/parent' });
      }
      if (behavior.derivation.mode === 'fork' && referenceKey(behavior.derivation.forkedFrom) === target) {
        // Recorded so the library can offer "compare with origin", flagged as
        // provenance so a delete check does not treat it as a live dependency.
        entries.push({ holder, path: '/derivation/forkedFrom (provenance only)' });
      }
    }
    if (stored.assetType === 'animation-motion-set') {
      const motionSet = stored.document as AnimationMotionSetAsset;
      if (referenceKey(motionSet.rig) === target) entries.push({ holder, path: '/rig' });
      for (const binding of motionSet.bindings) {
        if (referenceKey(binding.clip) === target) {
          entries.push({ holder, path: `/bindings/${binding.motionSlot}` });
        }
      }
    }
    if (stored.assetType === 'animation-tuning') {
      const tuning = stored.document as AnimationTuningProfileAsset;
      if (referenceKey(tuning.compatibleBehavior) === target) {
        entries.push({ holder, path: '/compatibleBehavior' });
      }
    }
  }

  for (const project of projects) {
    for (const character of project.characters) {
      for (const [slot, held] of Object.entries({
        behavior: character.animation.behavior,
        motionSet: character.animation.motionSet,
        rig: character.animation.rig,
        tuning: character.animation.tuning,
      })) {
        if (held && referenceKey(held) === target) {
          entries.push({
            holder: { kind: 'character', projectId: project.id, characterId: character.id },
            path: `/characters/${character.id}/animation/${slot}`,
          });
        }
      }
    }
  }

  return entries;
}

export interface DeletePolicyResult {
  allowed: boolean;
  /** Human-readable reasons, one per blocking reference (PLAN 26.1). */
  reasons: string[];
  blockers: UsedByEntry[];
}

/**
 * Whether an asset may be deleted. Refusal always enumerates who is holding on
 * — a bare "cannot delete" would send the reader hunting through five asset
 * types by hand.
 */
export function checkDeletePolicy(
  registry: AnimationAssetRegistry,
  reference: AssetReference,
  projects: readonly ProjectDefinition[] = [],
): DeletePolicyResult {
  const reasons: string[] = [];
  const holders = usedBy(registry, reference, projects).filter(
    (entry) => !entry.path.includes('provenance only'),
  );

  for (const entry of holders) {
    if ('kind' in entry.holder) {
      reasons.push(`character "${entry.holder.characterId}" references it at ${entry.path}`);
    } else {
      reasons.push(
        `${entry.holder.assetType} "${entry.holder.assetId}@${entry.holder.version}" references it at ${entry.path}`,
      );
    }
  }

  if (registry.has(reference)) {
    const protection = registry.get(reference).metadata.protection?.level;
    if (protection === 'locked' || protection === 'invariant') {
      reasons.push(`the asset is marked ${protection}`);
    }
  }

  const remainingVersions = registry
    .versionsOf(reference.assetType, reference.assetId)
    .filter((version) => version !== reference.version);
  if (remainingVersions.length === 0 && holders.length > 0) {
    reasons.push('it is the only published version and something still depends on it');
  }

  return { allowed: reasons.length === 0, reasons, blockers: holders };
}

/** Assets nothing references. Not an error — just the "Unused" library filter. */
export function orphanedAssets(
  registry: AnimationAssetRegistry,
  projects: readonly ProjectDefinition[] = [],
): AssetReference[] {
  return registry
    .all()
    .map((stored) => ({
      assetType: stored.assetType,
      assetId: stored.id,
      version: stored.version,
      contentHash: stored.document.metadata.contentHash,
    }))
    .filter((reference) => usedBy(registry, reference, projects).length === 0);
}

/** Missing or modified references anywhere in the registry, as issues. */
export function auditRegistry(
  registry: AnimationAssetRegistry,
  projects: readonly ProjectDefinition[] = [],
): AssetIssue[] {
  const issues: AssetIssue[] = [];
  for (const stored of registry.all()) {
    const self: AssetReference = {
      assetType: stored.assetType,
      assetId: stored.id,
      version: stored.version,
      contentHash: '',
    };
    issues.push(...registry.validate(self).issues);
    for (const dependency of directDependencies(registry, self)) {
      issues.push(...registry.checkReference(dependency));
    }
  }
  for (const project of projects) {
    for (const character of project.characters) {
      for (const reference of [
        character.animation.behavior,
        character.animation.motionSet,
        character.animation.rig,
        ...(character.animation.tuning ? [character.animation.tuning] : []),
      ]) {
        issues.push(...registry.checkReference(reference));
      }
    }
  }
  return issues;
}
