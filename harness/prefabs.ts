/**
 * Node-side Prefab loading, shared by the harness stages and the tests.
 *
 * The Prefab registry is filesystem-blind for the same reason the animation
 * registry is, so exactly one file is allowed to know that Prefabs live at
 * `assets/prefabs/<id>/<version>.json`. This is it.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { GameObjectPrefabAsset, GameObjectPrefabReference } from '@atc/schema';
import { prefabAssetFilePath } from '@atc/schema';
import { PrefabAssetRegistry, type StoredPrefab } from '@atc/prefab-runtime';
import { REPO_ROOT } from './lib.ts';
import { gameplayScriptRegistry } from '@atc/gameplay';

export const PREFAB_ROOT = 'assets/prefabs';
export const PREFAB_LIBRARY_INDEX_PATH = 'generated/prefab-assets/library-index.json';

/** Every published Prefab version on disk, in a stable order. */
export function loadStoredPrefabs(root: string = REPO_ROOT): StoredPrefab[] {
  const base = resolve(root, PREFAB_ROOT);
  if (!existsSync(base)) return [];
  const prefabs: StoredPrefab[] = [];
  for (const assetId of readdirSync(base).sort()) {
    const versionDirectory = resolve(base, assetId);
    for (const file of readdirSync(versionDirectory).sort()) {
      if (!file.endsWith('.json')) continue;
      prefabs.push({
        id: assetId,
        version: file.replace(/\.json$/, ''),
        document: JSON.parse(
          readFileSync(resolve(versionDirectory, file), 'utf8'),
        ) as GameObjectPrefabAsset,
      });
    }
  }
  return prefabs;
}

export function loadPrefabRegistry(root: string = REPO_ROOT): PrefabAssetRegistry {
  return new PrefabAssetRegistry(loadStoredPrefabs(root), gameplayScriptRegistry);
}

/** Repository path a stored Prefab belongs at. */
export function pathForStoredPrefab(prefab: StoredPrefab): string {
  return prefabAssetFilePath(prefab.id, prefab.version);
}

export function prefabReferenceFor(
  registry: PrefabAssetRegistry,
  assetId: string,
  version?: string,
): GameObjectPrefabReference {
  const resolved = version ?? registry.latestVersion(assetId);
  if (resolved === undefined) throw new Error(`no Prefab "${assetId}" on disk`);
  return registry.referenceTo(assetId, resolved);
}
