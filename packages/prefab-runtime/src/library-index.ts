/**
 * The browsable Prefab index (§5.1).
 *
 * The same contract as the animation library index: a generated view, never a
 * source of truth, and stale-detectable. A static host cannot walk
 * `assets/prefabs/**`, so without this the browser would have to be told what
 * exists — and a hand-maintained list of what exists is a list that is wrong.
 */
import type { PrefabAssetRegistry, PrefabSummary } from './registry.ts';

export interface PrefabLibraryIndex {
  schemaVersion: number;
  generatedFrom: string;
  prefabs: PrefabSummary[];
}

export const PREFAB_LIBRARY_INDEX_SCHEMA_VERSION = 1;

export function buildPrefabLibraryIndex(registry: PrefabAssetRegistry): PrefabLibraryIndex {
  return {
    schemaVersion: PREFAB_LIBRARY_INDEX_SCHEMA_VERSION,
    generatedFrom: 'assets/prefabs',
    prefabs: registry.summaries(),
  };
}
