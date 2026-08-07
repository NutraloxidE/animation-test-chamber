/**
 * What `/prefabs` shows, and which filter admits what (§4).
 *
 * The rows are derived from the Registry and the usage graph — never from a
 * scan of the Scenes written here. The Asset Library learned that lesson
 * already: three independent scans agree right up until one of them learns
 * about nested Prefabs.
 *
 * The filters are the interesting part, and they are Component questions, not
 * name questions. "Characters" means *Animator + CharacterMotor*, so a Prefab
 * called `goblin-decoration` with those two Components is a character and a
 * Prefab called `hero` without them is not. A filter keyed on a tag or an id
 * prefix would be a second, cosmetic taxonomy sitting beside the real one.
 */
import type { GameObjectPrefabReference } from '@atc/schema';
import { isCharacterComposition } from '@atc/schema';
import {
  describePrefabUsage,
  resolveGameObjectPrefab,
  resolvedComponents,
  type PrefabAssetRegistry,
  type PrefabUsageDescription,
} from '@atc/prefab-runtime';
import type { SceneDefinition } from '@atc/schema';

export const PREFAB_FILTERS = [
  'all',
  'characters',
  'animated',
  'models',
  'cameras',
  'lights',
  'abstract',
] as const;

export type PrefabFilterId = (typeof PREFAB_FILTERS)[number];

export const PREFAB_FILTER_LABELS: Record<PrefabFilterId, string> = {
  all: 'All',
  characters: 'Characters',
  animated: 'Animated',
  models: 'Models',
  cameras: 'Cameras',
  lights: 'Lights',
  abstract: 'Abstract',
};

export interface PrefabListRow {
  prefabId: string;
  version: string;
  displayName: string;
  reference: GameObjectPrefabReference;
  derivation: 'base' | 'variant' | 'fork';
  abstract: boolean;
  /** Component types on the *resolved* composition, so a variant reports its parent's. */
  componentTypes: string[];
  sceneUsageCount: number;
  nestedUsageCount: number;
  isCharacter: boolean;
  isAnimated: boolean;
  /** Resolution failed; the row still exists so the failure is visible. */
  unresolved: boolean;
}

/**
 * Every Prefab version, with the facts the list draws.
 *
 * Resolved rather than stored: a variant's stored payload is a patch list, and
 * a badge row built from that would show a character Prefab with no Components
 * at all.
 */
export function prefabListRows(input: {
  registry: PrefabAssetRegistry;
  scenes: readonly SceneDefinition[];
}): PrefabListRow[] {
  const usage = describePrefabUsage({
    prefabRegistry: input.registry,
    scenes: input.scenes,
  });
  const usageByKey = new Map<string, PrefabUsageDescription>(
    usage.map((entry) => [`${entry.prefab.assetId}@${entry.prefab.version}`, entry]),
  );

  return input.registry.all().map((stored) => {
    const reference = input.registry.referenceTo(stored.id, stored.version);
    const resolution = resolveGameObjectPrefab(input.registry, reference);
    const unresolved = resolution.issues.some((issue) => issue.severity === 'error');
    const components = unresolved ? [] : resolvedComponents(resolution.prefab.root);
    const entry = usageByKey.get(`${stored.id}@${stored.version}`);

    return {
      prefabId: stored.id,
      version: stored.version,
      displayName: stored.document.metadata.displayName,
      reference,
      derivation: stored.document.derivation.mode,
      abstract: stored.document.abstract,
      componentTypes: [...new Set(components.map((component) => component.componentType))].sort(),
      sceneUsageCount: entry?.sceneInstances.length ?? 0,
      nestedUsageCount: entry?.nestedBy.length ?? 0,
      isCharacter: isCharacterComposition(components),
      isAnimated: components.some((component) => component.componentType === 'animator'),
      unresolved,
    };
  });
}

export function filterPrefabRows(
  rows: readonly PrefabListRow[],
  filter: PrefabFilterId,
): PrefabListRow[] {
  switch (filter) {
    case 'all':
      return [...rows];
    case 'characters':
      return rows.filter((row) => row.isCharacter);
    case 'animated':
      return rows.filter((row) => row.isAnimated);
    case 'models':
      return rows.filter((row) => row.componentTypes.includes('model-renderer'));
    case 'cameras':
      return rows.filter((row) => row.componentTypes.includes('camera'));
    case 'lights':
      return rows.filter((row) => row.componentTypes.includes('light'));
    case 'abstract':
      return rows.filter((row) => row.abstract);
  }
}
