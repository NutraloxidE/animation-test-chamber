/**
 * The browser's Prefab registry.
 *
 * Built once, from the generated index, and shared read-only. The registry
 * holds immutable documents — a Prefab is the same document after a million
 * ticks — so sharing it across every Scene and every route is safe in exactly
 * the way sharing a `RuntimeGameObject` would not be.
 */
import prefabIndex from '@chamber/prefab-assets';
import { registryFromPrefabLibraryIndex, type PrefabAssetRegistry } from '@atc/prefab-runtime';

let cached: PrefabAssetRegistry | null = null;

export function browserPrefabRegistry(): PrefabAssetRegistry {
  cached ??= registryFromPrefabLibraryIndex(prefabIndex);
  return cached;
}
