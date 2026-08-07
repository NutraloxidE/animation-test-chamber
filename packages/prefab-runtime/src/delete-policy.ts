/**
 * Whether a published Prefab version may be deleted (§14.3).
 *
 * The answer is always a list of *exact blockers*, never a boolean. "This
 * Prefab is in use" tells somebody they cannot delete it and nothing about what
 * to do next; "`two-humanoids-shared-animation` / `controlled-humanoid` stands
 * on it, and `quaternius-knight@1.0.0` nests it" tells them exactly which two
 * things to change first.
 *
 * Three kinds of holder block a deletion, and they are different kinds of
 * problem:
 *
 *   Scene instance   a Scene would stop resolving — the object vanishes
 *   nested Prefab    a Prefab would stop resolving — every instance of *it* goes
 *   variant parent   a lineage loses the document its patches are written against
 *
 * The variant case is the one that is easy to miss. A variant stores only what
 * it changes; deleting its parent does not leave a slightly-degraded variant, it
 * leaves a patch list with nothing to apply to.
 *
 * Pure: it reads the registry and the usage graph and returns a verdict. The
 * transaction that performs a permitted deletion is the caller's.
 */
import type { GameObjectPrefabReference, SceneDefinition } from '@atc/schema';
import { prefabReferencesEqual } from '@atc/schema';
import type { PrefabAssetRegistry } from './registry.ts';
import { describePrefabUsage } from './usage.ts';

export type PrefabDeleteBlocker =
  | {
      kind: 'scene-instance';
      sceneId: string;
      gameObjectId: string;
      /** What to say to a human, naming both halves of the identity. */
      message: string;
    }
  | { kind: 'nested-prefab'; prefab: GameObjectPrefabReference; message: string }
  | { kind: 'variant-parent'; prefab: GameObjectPrefabReference; message: string }
  | { kind: 'protected'; level: string; message: string }
  | { kind: 'unknown-version'; message: string };

export interface PrefabDeletePolicyResult {
  reference: GameObjectPrefabReference;
  allowed: boolean;
  blockers: PrefabDeleteBlocker[];
}

export function checkPrefabDeletePolicy(input: {
  registry: PrefabAssetRegistry;
  reference: GameObjectPrefabReference;
  scenes: readonly SceneDefinition[];
}): PrefabDeletePolicyResult {
  const { registry, reference, scenes } = input;
  const blockers: PrefabDeleteBlocker[] = [];

  if (!registry.has(reference)) {
    /*
     * A version the repository does not hold is refused rather than treated as
     * "already deleted, nothing to do". A caller asking to delete something that
     * is not there has a stale view, and telling them it succeeded would confirm
     * a belief that is wrong.
     */
    return {
      reference,
      allowed: false,
      blockers: [
        {
          kind: 'unknown-version',
          message: `the repository has no ${reference.assetId}@${reference.version}`,
        },
      ],
    };
  }

  const usage = describePrefabUsage({ prefabRegistry: registry, scenes });
  const entry = usage.find(
    (candidate) =>
      candidate.prefab.assetId === reference.assetId &&
      candidate.prefab.version === reference.version,
  );

  for (const instance of entry?.sceneInstances ?? []) {
    blockers.push({
      kind: 'scene-instance',
      sceneId: instance.sceneId,
      gameObjectId: instance.gameObjectId,
      message:
        `Scene "${instance.sceneId}" places it as GameObject "${instance.gameObjectId}"`,
    });
  }

  for (const holder of entry?.nestedBy ?? []) {
    blockers.push({
      kind: 'nested-prefab',
      prefab: holder,
      message: `Prefab "${holder.assetId}@${holder.version}" nests it`,
    });
  }

  for (const child of entry?.variantChildren ?? []) {
    blockers.push({
      kind: 'variant-parent',
      prefab: child,
      message:
        `Prefab "${child.assetId}@${child.version}" is a variant of it, and stores only ` +
        'the patches it changes — deleting the parent leaves nothing to apply them to',
    });
  }

  const protection = registry.get(reference).metadata.protection?.level;
  if (protection === 'locked' || protection === 'invariant') {
    blockers.push({
      kind: 'protected',
      level: protection,
      message: `the Prefab version is marked ${protection}`,
    });
  }

  return { reference, allowed: blockers.length === 0, blockers };
}

/** Every published version this lineage still has, other than the named one. */
export function siblingVersions(
  registry: PrefabAssetRegistry,
  reference: GameObjectPrefabReference,
): string[] {
  return registry
    .versionsOf(reference.assetId)
    .filter((version) => !prefabReferencesEqual(reference, { ...reference, version }));
}
