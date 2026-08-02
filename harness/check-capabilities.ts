/**
 * `pnpm harness:capabilities` — the stage that makes a capability manifest a
 * contract rather than a description.
 *
 * It fails when a registered capability is missing any of its four required
 * surfaces (machine, human, observation, verification), or when a declaration
 * points at an implementation id, fixture file or npm script that does not
 * exist. A capability that passes this stage cannot be half-finished in a way
 * that a listing would hide.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  checkCapabilityCompleteness,
  createDefaultRegistry,
} from '@atc/capability-runtime';
import { REPO_ROOT, printStage, stage, type StageIssue, type StageResult } from './lib.ts';

export function capabilityCompletenessStage(): StageResult {
  return stage(
    'capability completeness',
    {
      reproduce: 'pnpm harness:capabilities',
      blocksCommit: true,
      suggestion:
        'a capability needs a command, an authoring surface, an observation, a fixture and a harness stage — add the missing one rather than removing the declaration',
    },
    () => {
      const registry = createDefaultRegistry();
      const packageJson = JSON.parse(
        readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8'),
      ) as { scripts: Record<string, string> };

      const problems = checkCapabilityCompleteness(registry, {
        fileExists: (path) => existsSync(resolve(REPO_ROOT, path)),
        scripts: new Set(Object.keys(packageJson.scripts)),
      });

      const issues: StageIssue[] = problems.map((problem) => ({
        files: ['packages/capability-runtime/src'],
        expected: 'a complete capability declaration',
        actual: `${problem.capabilityId}: ${problem.message}`,
        message: `${problem.capabilityId} ${problem.message}`,
      }));

      const summary = registry
        .list()
        .map(
          (capability) =>
            `${capability.id}: ${capability.commands.length} commands, ${capability.authoringSurfaces.length} surfaces, ${capability.observations.length} observations`,
        )
        .join('\n');

      return { ok: issues.length === 0, issues, output: summary };
    },
  );
}

export function capabilityStages(): StageResult[] {
  return [capabilityCompletenessStage()];
}

if (process.argv[1]?.includes('check-capabilities')) {
  const results = capabilityStages();
  for (const result of results) printStage(result);
  process.exit(results.every((result) => result.ok) ? 0 : 1);
}
