/**
 * Deterministic World-to-Scene migration for canonical project files.
 *
 * The application never rewrites a repository on load (work package §7.3): it
 * migrates in memory, says so, and waits for an explicit Apply. This script is
 * the other half of that rule — the *explicit*, reviewable way to put a
 * migrated document on disk, so that "migrate the repository" is a command
 * somebody ran rather than a side effect of somebody looking.
 *
 * Idempotent by construction: it re-reads what it wrote, and a second run over
 * an already-migrated project produces no diff. `--check` asserts exactly that
 * without writing, which is what a CI stage wants.
 */
import { loadProjectDocument, validateProject, validateProjectReferences } from '@atc/schema';
import { readRepoFile, writeRepoFile } from './lib.ts';

const PROJECT_FILES = ['projects/demo-character/project.json'];

export interface MigrationOutcome {
  path: string;
  migrated: boolean;
  sceneIds: string[];
  content: string;
  issues: { path: string; message: string }[];
}

export function migrateProjectFile(path: string): MigrationOutcome {
  const source = readRepoFile(path);
  if (source === null) throw new Error(`project file not found: ${path}`);
  const raw = JSON.parse(source) as unknown;
  const loaded = loadProjectDocument(raw);
  const issues = [
    ...validateProject(loaded.project).issues,
    ...validateProjectReferences(loaded.project).issues,
  ].map((issue) => ({ path: issue.path, message: issue.message }));

  return {
    path,
    migrated: loaded.migrated,
    sceneIds: loaded.project.scenes.map((scene) => scene.id),
    content: `${JSON.stringify(loaded.project, null, 2)}\n`,
    issues,
  };
}

function main(): void {
  const check = process.argv.includes('--check');
  let failed = false;

  for (const path of PROJECT_FILES) {
    const outcome = migrateProjectFile(path);
    if (outcome.issues.length > 0) {
      failed = true;
      console.error(`[FAIL] ${path} does not validate after migration:`);
      for (const issue of outcome.issues) console.error(`  ${issue.path}: ${issue.message}`);
      continue;
    }

    const current = readRepoFile(path) ?? '';
    if (current === outcome.content) {
      console.log(`[OK] ${path} already current (${outcome.sceneIds.length} scene(s))`);
      continue;
    }
    if (check) {
      failed = true;
      console.error(`[FAIL] ${path} is not the migrated form; run \`pnpm scenes:migrate\``);
      continue;
    }
    writeRepoFile(path, outcome.content);
    console.log(
      `[WROTE] ${path}${outcome.migrated ? ' (migrated from World)' : ''} — scenes: ${
        outcome.sceneIds.join(', ') || 'none'
      }`,
    );
  }

  if (failed) process.exit(1);
}

if (process.argv[1]?.includes('migrate-scenes')) main();
