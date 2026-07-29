/**
 * Writes the Unity export bundle into generated/unity/.
 *
 * Everything under generated/ is a build artifact: regenerable, never canonical,
 * and never edited by hand. The repo guard enforces that.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ProjectDefinition } from '@atc/schema';
import { REPLAY_FIXTURES } from '@atc/replay-runtime';
import { buildUnityBundle } from '@atc/unity-export';
import { REPO_ROOT, writeRepoFile } from './lib.ts';

export function loadCanonicalProject(): ProjectDefinition {
  return JSON.parse(
    readFileSync(resolve(REPO_ROOT, 'projects/demo-character/project.json'), 'utf8'),
  ) as ProjectDefinition;
}

/**
 * The generated timestamp is pinned to the project revision rather than the
 * wall clock, so regenerating without changing canonical data produces an
 * identical bundle and the drift check stays meaningful.
 */
export function buildBundleFiles(): { path: string; content: string }[] {
  const project = loadCanonicalProject();
  return buildUnityBundle(project, REPLAY_FIXTURES, `revision:${project.revisionId}`);
}

function main(): void {
  const files = buildBundleFiles();
  for (const file of files) writeRepoFile(`generated/unity/${file.path}`, file.content);
  console.log(`wrote ${files.length} file(s) to generated/unity/`);
}

if (process.argv[1]?.includes('export-unity')) main();
