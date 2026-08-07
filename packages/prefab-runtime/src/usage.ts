/**
 * The Prefab usage graph (§8.3).
 *
 * One source of truth, deliberately. Before this, "who uses this?" was answered
 * by whichever caller needed it — a scan in the Inspector, a different scan in
 * the API's delete check, a third in a test — and three scans that agree today
 * are three scans that disagree the first time one of them learns about nested
 * Prefabs.
 *
 * Everything that needs a holder list reads this: the Inspector's badges, the
 * Asset Library's "Used By", the save blast radius, the delete policy, the
 * audit report. That is what makes "displayed targets == request targets"
 * (§14.5) something the code enforces rather than something a reviewer checks.
 */
import type {
  AssetReference,
  GameObjectPrefabAsset,
  GameObjectPrefabReference,
  ProjectDefinition,
  SceneDefinition,
} from '@atc/schema';
import { prefabHasStoredRoot, referenceKey } from '@atc/schema';
import type { PrefabAssetRegistry } from './registry.ts';
import { resolveGameObjectPrefab, resolvedComponents } from './resolution.ts';
import { nestedPrefabReferences } from './validation.ts';

/** One Scene instance of one Prefab, named exactly. */
export interface PrefabSceneInstanceUse {
  sceneId: string;
  gameObjectId: string;
  prefab: GameObjectPrefabReference;
}

export interface PrefabUsageDescription {
  prefab: GameObjectPrefabReference;
  displayName: string;
  abstract: boolean;
  derivation: 'base' | 'variant' | 'fork';
  /** Prefabs this one nests, directly. */
  nestedPrefabs: GameObjectPrefabReference[];
  /** Animation assets this Prefab's own payload names. */
  animationReferences: AssetReference[];
  /** Repository model paths this Prefab's own payload names. */
  modelAssetPaths: string[];
  /** Every Scene GameObject standing on this exact version. */
  sceneInstances: PrefabSceneInstanceUse[];
  /** Prefabs that nest this exact version. */
  nestedBy: GameObjectPrefabReference[];
  /** Prefabs whose variant parent is this exact version. */
  variantChildren: GameObjectPrefabReference[];
}

export interface DescribePrefabUsageOptions {
  prefabRegistry: PrefabAssetRegistry;
  /** Scenes to scan. Defaults to every Scene in `project`. */
  scenes?: readonly SceneDefinition[];
  project?: ProjectDefinition;
}

function selfReference(
  registry: PrefabAssetRegistry,
  asset: GameObjectPrefabAsset,
): GameObjectPrefabReference {
  return registry.referenceTo(asset.metadata.id, asset.metadata.version);
}

/**
 * Usage for every Prefab version in the registry, in registry order.
 *
 * Version-exact throughout: `navigator@1.0.0` and `navigator@1.0.1` are two
 * rows, because a Scene standing on the older one is emphatically not affected
 * by a change to the newer one, and a holder list that blurred them is exactly
 * the ambiguity §14 exists to close.
 */
export function describePrefabUsage(
  options: DescribePrefabUsageOptions,
): PrefabUsageDescription[] {
  const { prefabRegistry } = options;
  const scenes = options.scenes ?? options.project?.scenes ?? [];

  const sceneInstancesByKey = new Map<string, PrefabSceneInstanceUse[]>();
  for (const scene of scenes) {
    for (const gameObject of scene.gameObjects ?? []) {
      const key = `${gameObject.prefab.assetId}@${gameObject.prefab.version}`;
      const list = sceneInstancesByKey.get(key) ?? [];
      list.push({ sceneId: scene.id, gameObjectId: gameObject.id, prefab: gameObject.prefab });
      sceneInstancesByKey.set(key, list);
    }
  }

  const nestedByKey = new Map<string, GameObjectPrefabReference[]>();
  const variantChildrenByKey = new Map<string, GameObjectPrefabReference[]>();
  for (const stored of prefabRegistry.all()) {
    const holder = selfReference(prefabRegistry, stored.document);
    if (stored.document.derivation.mode === 'variant') {
      const parent = stored.document.derivation.parent;
      const key = `${parent.assetId}@${parent.version}`;
      variantChildrenByKey.set(key, [...(variantChildrenByKey.get(key) ?? []), holder]);
    }
    if (prefabHasStoredRoot(stored.document)) {
      for (const nested of nestedPrefabReferences(stored.document.root)) {
        const key = `${nested.assetId}@${nested.version}`;
        nestedByKey.set(key, [...(nestedByKey.get(key) ?? []), holder]);
      }
    }
  }

  return prefabRegistry.all().map((stored) => {
    const reference = selfReference(prefabRegistry, stored.document);
    const key = `${stored.id}@${stored.version}`;
    /*
     * Resolved, not stored. A variant stores no payload at all, so reading its
     * *document* for animation references reports nothing — which would make
     * "who holds this Behavior?" answer "only the abstract base" while five
     * concrete Prefabs inherit it. A holder list that is wrong in that
     * direction is the exact failure §14 exists to prevent: it would draw a
     * blast radius smaller than the truth.
     */
    const resolution = resolveGameObjectPrefab(prefabRegistry, reference);
    const animationReferences = resolution.prefab.dependencies.filter(
      (dependency): dependency is AssetReference =>
        dependency.assetType !== 'game-object-prefab',
    );
    const modelAssetPaths: string[] = [];
    for (const component of resolvedComponents(resolution.prefab.root)) {
      if (
        component.componentType === 'model-renderer' &&
        component.model.kind === 'repository-model'
      ) {
        modelAssetPaths.push(component.model.assetPath);
      }
    }
    return {
      prefab: reference,
      displayName: stored.document.metadata.displayName,
      abstract: stored.document.abstract,
      derivation: stored.document.derivation.mode,
      nestedPrefabs: prefabHasStoredRoot(stored.document)
        ? nestedPrefabReferences(stored.document.root)
        : [],
      animationReferences: dedupeAnimation(animationReferences),
      modelAssetPaths: [...new Set(modelAssetPaths)].sort(),
      sceneInstances: sceneInstancesByKey.get(key) ?? [],
      nestedBy: nestedByKey.get(key) ?? [],
      variantChildren: variantChildrenByKey.get(key) ?? [],
    } satisfies PrefabUsageDescription;
  });
}

function dedupeAnimation(references: readonly AssetReference[]): AssetReference[] {
  const byKey = new Map<string, AssetReference>();
  for (const reference of references) byKey.set(referenceKey(reference), reference);
  return [...byKey.values()].sort((a, b) => referenceKey(a).localeCompare(referenceKey(b)));
}

/**
 * The exact Prefabs holding one animation asset version (§3.7).
 *
 * This is the list a "shared Behavior" badge shows and the list an adoption
 * request enumerates. It is deliberately the *same* list: a UI that computed
 * its own would be free to describe a blast radius the request does not have.
 */
export function prefabHoldersOfAnimationAsset(
  usage: readonly PrefabUsageDescription[],
  reference: AssetReference,
): GameObjectPrefabReference[] {
  const key = referenceKey(reference);
  return usage
    .filter((entry) => entry.animationReferences.some((held) => referenceKey(held) === key))
    .map((entry) => entry.prefab);
}

/**
 * Why a Prefab version cannot be deleted (§13.2), as exact paths.
 *
 * Empty means deletable. A refusal that said "it is in use" without saying
 * where would leave a human to run this scan by hand, which is how a
 * force-delete flag gets added.
 */
export function prefabDeleteBlockers(
  usage: readonly PrefabUsageDescription[],
  reference: GameObjectPrefabReference,
): string[] {
  const entry = usage.find(
    (candidate) =>
      candidate.prefab.assetId === reference.assetId &&
      candidate.prefab.version === reference.version,
  );
  if (!entry) return [];
  return [
    ...entry.sceneInstances.map((use) => `scene "${use.sceneId}" GameObject "${use.gameObjectId}"`),
    ...entry.nestedBy.map((holder) => `nested by Prefab ${holder.assetId}@${holder.version}`),
    ...entry.variantChildren.map(
      (child) => `variant parent of Prefab ${child.assetId}@${child.version}`,
    ),
  ];
}
