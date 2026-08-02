/**
 * `pnpm assets:animation:index` — rebuilds generated/animation-assets/library-index.json.
 *
 * The index is what makes the Asset Library work on a static host, where there
 * is no API to ask. It is a build artifact: the repo guard forbids importing it
 * from anywhere that treats it as canonical, and the harness fails when it has
 * drifted from `assets/animation/**`.
 */
import { buildLibraryIndex } from '@atc/animation-asset-runtime';
import { writeRepoFile } from './lib.ts';
import { LIBRARY_INDEX_PATH, loadAssetRegistry } from './animation-assets.ts';

export function buildIndexFile(): string {
  return `${JSON.stringify(buildLibraryIndex(loadAssetRegistry()), null, 2)}\n`;
}

function main(): void {
  const content = buildIndexFile();
  writeRepoFile(LIBRARY_INDEX_PATH, content);
  const index = JSON.parse(content) as { assets: unknown[]; indexHash: string };
  console.log(`wrote ${LIBRARY_INDEX_PATH}`);
  console.log(`  ${index.assets.length} asset version(s), index hash ${index.indexHash.slice(0, 12)}`);
}

if (process.argv[1]?.includes('generate-animation-asset-index')) main();
