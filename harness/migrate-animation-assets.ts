/**
 * `pnpm assets:animation:migrate` — schema v1 -> v2 (PLAN 34).
 *
 * Reads the frozen v1 project fixture, extracts assets, and rewrites
 * `projects/demo-character/project.json` as a set of references. Running it
 * twice produces byte-identical output, which is the property the harness
 * asserts: a migration whose result drifts would invalidate every content hash
 * it had just written.
 */
import { writeFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  migrateProjectToAssets,
  type LegacyProject,
  type MigrationResult,
} from '@atc/animation-asset-runtime';
import { REPO_ROOT, readRepoFile, writeRepoFile } from './lib.ts';
import { LEGACY_PROJECT_FIXTURE, PROJECT_PATH, pathForStoredAsset } from './animation-assets.ts';

export function loadLegacyProject(): LegacyProject {
  const raw = readRepoFile(LEGACY_PROJECT_FIXTURE);
  if (!raw) {
    throw new Error(
      `${LEGACY_PROJECT_FIXTURE} is missing. It is the frozen schema v1 document the ` +
        `migration reads and the shadow comparison uses as its oracle.`,
    );
  }
  return JSON.parse(raw) as LegacyProject;
}

export function runMigration(): MigrationResult {
  return migrateProjectToAssets(loadLegacyProject());
}

/** Writes assets and the rewritten project. Returns the paths it touched. */
export function writeMigration(result: MigrationResult): string[] {
  const written: string[] = [];
  for (const asset of result.assets) {
    const path = pathForStoredAsset(asset);
    writeRepoFile(path, `${JSON.stringify(asset.document, null, 2)}\n`);
    written.push(path);
  }
  const projectFile = resolve(REPO_ROOT, PROJECT_PATH);
  mkdirSync(dirname(projectFile), { recursive: true });
  writeFileSync(projectFile, `${JSON.stringify(result.project, null, 2)}\n`, 'utf8');
  written.push(PROJECT_PATH);
  return written;
}

function main(): void {
  const result = runMigration();
  const written = writeMigration(result);
  for (const note of result.notes) console.log(`- ${note}`);
  console.log(`wrote ${written.length} file(s)`);
  console.log(`  ${result.assets.length} asset version(s) under assets/animation/`);
  console.log(`  ${Object.keys(result.motionSlots).length} motion slot(s) bound`);
}

if (process.argv[1]?.includes('migrate-animation-assets')) main();
