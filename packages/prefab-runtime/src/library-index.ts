/**
 * The browsable Prefab index (§5.1).
 *
 * The same contract as the animation library index: a generated view, never a
 * source of truth, and stale-detectable. A static host cannot walk
 * `assets/prefabs/**`, so without this the browser would have to be told what
 * exists — and a hand-maintained list of what exists is a list that is wrong.
 *
 * The index carries the *documents*, not only their summaries. A summary is
 * enough to draw a list; it is not enough to resolve a Prefab, and the browser
 * has to resolve one to render a Scene at all. Shipping summaries alone would
 * mean the Viewport could only run where an API server does — which is the one
 * thing the static build exists to disprove.
 */
import type { PrefabAssetRegistry, PrefabSummary, StoredPrefab } from './registry.ts';
import { PrefabAssetRegistry as Registry } from './registry.ts';

export interface PrefabLibraryIndex {
  schemaVersion: number;
  generatedFrom: string;
  /** Every stored Prefab version, in registry order. What a resolver needs. */
  assets: StoredPrefab[];
  prefabs: PrefabSummary[];
}

export const PREFAB_LIBRARY_INDEX_SCHEMA_VERSION = 2;

export function buildPrefabLibraryIndex(registry: PrefabAssetRegistry): PrefabLibraryIndex {
  return {
    schemaVersion: PREFAB_LIBRARY_INDEX_SCHEMA_VERSION,
    generatedFrom: 'assets/prefabs',
    assets: registry.all(),
    prefabs: registry.summaries(),
  };
}

/**
 * A registry from the generated index.
 *
 * The browser's only route to a `PrefabAssetRegistry`, and deliberately the
 * same class the harness and the API build — one resolver, three hosts.
 */
export function registryFromPrefabLibraryIndex(index: PrefabLibraryIndex, gameplayRegistry?: import('@atc/gameplay-sdk').GameplayScriptRegistry): PrefabAssetRegistry {
  return new Registry(index.assets, gameplayRegistry);
}
