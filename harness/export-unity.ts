/**
 * Writes the Unity export bundle into generated/unity/.
 *
 * Everything under generated/ is a build artifact: regenerable, never canonical,
 * and never edited by hand. The repo guard enforces that.
 */
import { REPLAY_FIXTURES } from '@atc/replay-runtime';
import { buildUnityBundle } from '@atc/unity-export';
import { writeRepoFile } from './lib.ts';
import { loadResolvedProject } from './animation-assets.ts';

export { loadCanonicalProject } from './animation-assets.ts';

/**
 * The generated timestamp is pinned to the project revision rather than the
 * wall clock, so regenerating without changing canonical data produces an
 * identical bundle and the drift check stays meaningful.
 */
export function buildBundleFiles(): { path: string; content: string }[] {
  // The exporter wants a graph and a clip list, so it gets the active
  // character's resolved document rather than the reference-only canonical one.
  const project = loadResolvedProject();
  return buildUnityBundle(project, REPLAY_FIXTURES, `revision:${project.revisionId}`);
}

function main(): void {
  const files = buildBundleFiles();
  for (const file of files) writeRepoFile(`generated/unity/${file.path}`, file.content);
  console.log(`wrote ${files.length} file(s) to generated/unity/`);
}

if (process.argv[1]?.includes('export-unity')) main();
