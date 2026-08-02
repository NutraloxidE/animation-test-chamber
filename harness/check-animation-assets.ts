/**
 * Animation asset harness stages (PLAN 40).
 *
 * Each stage answers one question that, left unasked, would let the repository
 * ship an asset graph that only appears to work: references that resolve,
 * hashes that match, an index that is not stale, a migration that is
 * reproducible, and a runtime that behaves exactly as it did before the split.
 */
import { AnimationAssetRegistry, auditRegistry, buildLibraryIndex } from '@atc/animation-asset-runtime';
import { REPLAY_FIXTURES, runReplay } from '@atc/replay-runtime';
import { printStage, readRepoFile, stage, type StageIssue, type StageResult } from './lib.ts';
import {
  LIBRARY_INDEX_PATH,
  loadAssetRegistry,
  loadCanonicalProject,
  loadResolvedProject,
} from './animation-assets.ts';
import { buildIndexFile } from './generate-animation-asset-index.ts';
import { runMigration } from './migrate-animation-assets.ts';
import { compareAgainstLegacy, compareSharedBehaviorSequences } from './shadow-compare.ts';

/** Every reference resolves, every hash matches, every asset validates. */
export function assetIntegrityStage(): StageResult {
  return stage(
    'animation assets resolve and validate',
    {
      reproduce: 'npx tsx harness/check-animation-assets.ts',
      suggestion:
        'a hash mismatch means a published version was edited in place — publish a new version instead',
    },
    () => {
      const registry = loadAssetRegistry();
      const project = loadCanonicalProject();
      const issues = auditRegistry(registry, [project]).filter(
        (issue) => issue.severity === 'error',
      );
      return {
        ok: issues.length === 0,
        issues: issues.map((issue) => ({
          files: ['assets/animation'],
          expected: 'every asset reference to resolve to matching content',
          actual: issue.message,
          message: `${issue.code}: ${issue.message}`,
        })),
        output: `${registry.size} asset version(s) checked`,
      };
    },
  );
}

/** Every character resolves to a runnable document. */
export function characterResolutionStage(): StageResult {
  return stage(
    'every character resolves to a runnable document',
    {
      reproduce: 'npx tsx harness/check-animation-assets.ts',
      suggestion: 'bind the missing motion slot, or mark it optional in the behaviour',
    },
    () => {
      const project = loadCanonicalProject();
      const issues: StageIssue[] = [];
      const notes: string[] = [];
      for (const character of project.characters) {
        try {
          const resolved = loadResolvedProject({ characterId: character.id });
          notes.push(
            `${character.id}: ${resolved.graph.states.length} states, ${resolved.clips.length} clips`,
          );
        } catch (error) {
          issues.push({
            files: ['projects/demo-character/project.json'],
            expected: `character "${character.id}" to resolve`,
            actual: error instanceof Error ? error.message : String(error),
            message: `character "${character.id}" does not resolve`,
          });
        }
      }
      return { ok: issues.length === 0, issues, output: notes.join(' | ') };
    },
  );
}

/**
 * The generated index must match the assets on disk. A stale index is the one
 * failure a static host cannot detect for itself: it would render a library
 * that quietly disagrees with the repository.
 */
export function libraryIndexStage(): StageResult {
  return stage(
    'generated asset index is current',
    {
      reproduce: 'pnpm assets:animation:index',
      suggestion: 'run `pnpm assets:animation:index` and commit the result',
    },
    () => {
      const onDisk = readRepoFile(LIBRARY_INDEX_PATH);
      const expected = buildIndexFile();
      if (onDisk === expected) {
        return {
          ok: true,
          issues: [],
          output: `${buildLibraryIndex(loadAssetRegistry()).assets.length} asset version(s) indexed`,
        };
      }
      return {
        ok: false,
        issues: [
          {
            files: [LIBRARY_INDEX_PATH],
            expected: 'the index to match assets/animation/**',
            actual: onDisk === null ? 'the index is missing' : 'the index is stale',
            message: 'the generated asset index has drifted from the assets on disk',
          },
        ],
      };
    },
  );
}

/** The same input must always produce the same assets, or every hash moves. */
export function migrationDeterminismStage(): StageResult {
  return stage(
    'migration is deterministic',
    {
      reproduce: 'npx tsx harness/check-animation-assets.ts',
      suggestion:
        'remove the wall-clock time or unordered iteration that made the output vary between runs',
    },
    () => {
      const first = runMigration();
      const second = runMigration();
      const same =
        JSON.stringify(first.assets) === JSON.stringify(second.assets) &&
        JSON.stringify(first.project) === JSON.stringify(second.project);
      return {
        ok: same,
        issues: same
          ? []
          : [
              {
                files: ['packages/animation-asset-runtime/src/migration.ts'],
                expected: 'two runs to produce identical assets',
                actual: 'the two runs differ',
                message: 'the migration is not reproducible',
              },
            ],
        output: `${first.assets.length} asset version(s) produced identically twice`,
      };
    },
  );
}

/**
 * The migrated runtime must reproduce the pre-migration traces exactly. This is
 * the stage that makes "the refactor is behaviour-preserving" a fact rather
 * than a claim.
 */
export function shadowRuntimeStage(): StageResult {
  return stage(
    'asset-resolved runtime matches the pre-migration runtime',
    {
      reproduce: 'npx tsx harness/shadow-compare.ts',
      suggestion:
        'a trace difference is never auto-accepted: find which policy field no longer reproduces the old name-based rule',
    },
    () => {
      const differences = compareAgainstLegacy();
      return {
        ok: differences.length === 0,
        issues: differences.slice(0, 10).map((difference) => ({
          files: ['packages/animation-runtime', 'packages/replay-runtime'],
          expected: JSON.stringify(difference.expected).slice(0, 160),
          actual: JSON.stringify(difference.actual).slice(0, 160),
          message: `${difference.replayId}: ${difference.field} differs from the legacy trace`,
        })),
        output: `${REPLAY_FIXTURES.length} replays identical to the pre-migration runtime`,
      };
    },
  );
}

/**
 * Two characters, one behaviour: identical sequencing, different clips. If the
 * sequences diverged the behaviour would not really be shared; if the clips
 * matched, the second character would not really be a second character.
 */
export function sharedBehaviorStage(): StageResult {
  return stage(
    'two characters share one behaviour with different motion sets',
    {
      reproduce: 'npx tsx harness/check-animation-assets.ts',
      suggestion:
        'a sequence difference means the second character is not actually running the shared graph',
    },
    () => {
      const project = loadCanonicalProject();
      if (project.characters.length < 2) {
        return {
          ok: false,
          issues: [
            {
              files: ['projects/demo-character/project.json'],
              expected: 'at least two characters',
              actual: `${project.characters.length}`,
              message: 'reuse cannot be demonstrated with a single character',
            },
          ],
        };
      }
      const [first, second] = project.characters;
      const differences = compareSharedBehaviorSequences(first!.id, second!.id);
      return {
        ok: differences.length === 0,
        issues: differences.slice(0, 10).map((difference) => ({
          files: ['assets/animation'],
          expected: JSON.stringify(difference.expected).slice(0, 160),
          actual: JSON.stringify(difference.actual).slice(0, 160),
          message: `${difference.replayId}: ${difference.field} differs between the two characters`,
        })),
        output: `${first!.id} and ${second!.id} share "${first!.animation.behavior.assetId}"`,
      };
    },
  );
}

/** The second character must actually be playable, not merely declared. */
export function secondCharacterReplayStage(): StageResult {
  return stage(
    'the second character runs every replay fixture',
    {
      reproduce: 'npx tsx harness/check-animation-assets.ts',
      suggestion: 'check the alternate motion set binds every required slot',
    },
    () => {
      const project = loadCanonicalProject();
      const second = project.characters[1];
      if (!second) return { ok: false, issues: [], output: 'no second character' };
      const resolved = loadResolvedProject({ characterId: second.id });
      const issues: StageIssue[] = [];
      for (const replay of REPLAY_FIXTURES) {
        const trace = runReplay(resolved, replay);
        if (trace.ticks.length !== replay.tickCount) {
          issues.push({
            files: ['assets/animation'],
            expected: `${replay.tickCount} ticks`,
            actual: `${trace.ticks.length}`,
            message: `${replay.id} did not run to completion for "${second.id}"`,
          });
        }
      }
      return {
        ok: issues.length === 0,
        issues,
        output: `${REPLAY_FIXTURES.length} replays run for "${second.id}"`,
      };
    },
  );
}

export function animationAssetStages(): StageResult[] {
  return [
    assetIntegrityStage(),
    characterResolutionStage(),
    libraryIndexStage(),
    migrationDeterminismStage(),
    shadowRuntimeStage(),
    sharedBehaviorStage(),
    secondCharacterReplayStage(),
  ];
}

function main(): void {
  const results = animationAssetStages();
  for (const result of results) printStage(result);
  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} animation asset checks passed`);
  process.exit(failed.length > 0 ? 1 : 0);
}

if (process.argv[1]?.includes('check-animation-assets')) main();

export { AnimationAssetRegistry };
