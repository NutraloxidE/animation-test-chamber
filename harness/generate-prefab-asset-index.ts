/**
 * Emits `generated/prefab-assets/library-index.json`.
 *
 * A generated view of `assets/prefabs/**`, never a source of truth. It exists
 * because a static host cannot walk a directory, and the alternative — telling
 * the browser by hand what Prefabs exist — is a list that goes stale silently.
 * `harness:prefabs` regenerates it in memory and fails when the committed copy
 * differs, which is how that staleness becomes visible.
 */
import { buildPrefabLibraryIndex } from '@atc/prefab-runtime';
import { PREFAB_LIBRARY_INDEX_PATH, loadPrefabRegistry } from './prefabs.ts';
import { writeRepoFile } from './lib.ts';

export function buildPrefabIndexFile(): string {
  return `${JSON.stringify(buildPrefabLibraryIndex(loadPrefabRegistry()), null, 2)}\n`;
}

function main(): void {
  const content = buildPrefabIndexFile();
  writeRepoFile(PREFAB_LIBRARY_INDEX_PATH, content);
  console.log(`wrote ${PREFAB_LIBRARY_INDEX_PATH}`);
}

if (process.argv[1]?.includes('generate-prefab-asset-index')) main();
