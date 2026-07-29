/**
 * Static checks (PLAN 17.2): types, lint, schema drift, dead canonical
 * references, and generated files that were edited by hand.
 */
import { validateProject, validateProjectReferences } from '@atc/schema';
import { hasPath } from '@atc/runtime-core';
import { buildGeneratedFiles } from './generate-schemas.ts';
import { buildBundleFiles, loadCanonicalProject } from './export-unity.ts';
import { printStage, readRepoFile, run, stage, type StageIssue, type StageResult } from './lib.ts';

export function typecheckStage(): StageResult {
  return stage(
    'typescript strict',
    {
      reproduce: 'pnpm typecheck',
      suggestion: 'fix the type errors; do not widen types to silence them',
    },
    () => {
      const { code, output } = run('npx', ['tsc', '-p', 'tsconfig.json', '--noEmit']);
      if (code === 0) return { ok: true, issues: [] };
      const issues: StageIssue[] = output
        .split('\n')
        .filter((line) => line.includes('error TS'))
        .map((line) => ({
          files: [line.split('(')[0] ?? ''],
          expected: 'no type errors',
          actual: line.trim(),
          message: line.trim(),
        }));
      return { ok: false, issues, output };
    },
  );
}

export function lintStage(): StageResult {
  return stage(
    'eslint',
    { reproduce: 'pnpm lint', blocksCommit: false, suggestion: 'run `pnpm lint --fix`' },
    () => {
      const { code, output } = run('npx', ['eslint', '.', '--max-warnings=0']);
      if (code === 0) return { ok: true, issues: [] };
      return {
        ok: false,
        issues: [
          {
            files: [],
            expected: 'no lint errors',
            actual: output.split('\n').slice(0, 12).join('\n'),
            message: 'eslint reported problems',
          },
        ],
        output,
      };
    },
  );
}

export function schemaDriftStage(): StageResult {
  return stage(
    'schema generation drift',
    {
      reproduce: 'pnpm schema:generate',
      suggestion: 'run `pnpm schema:generate` and commit the result',
    },
    () => {
      const issues: StageIssue[] = [];
      for (const file of buildGeneratedFiles()) {
        const onDisk = readRepoFile(file.path);
        if (onDisk === null) {
          issues.push({
            files: [file.path],
            expected: 'the generated file to exist',
            actual: 'missing',
            message: `${file.path} has not been generated`,
          });
        } else if (onDisk !== file.content) {
          issues.push({
            files: [file.path],
            expected: 'the committed file to match the schema definitions',
            actual: 'it differs',
            message: `${file.path} is out of date or was edited by hand`,
          });
        }
      }
      return { ok: issues.length === 0, issues };
    },
  );
}

export function generatedArtifactStage(): StageResult {
  return stage(
    'generated files not hand-modified',
    {
      reproduce: 'pnpm unity:export',
      suggestion: 'never edit generated/; change canonical data and regenerate',
    },
    () => {
      const issues: StageIssue[] = [];
      for (const file of buildBundleFiles()) {
        const path = `generated/unity/${file.path}`;
        const onDisk = readRepoFile(path);
        // A missing bundle is fine: it is a build artifact, not a source.
        if (onDisk !== null && onDisk !== file.content) {
          issues.push({
            files: [path],
            expected: 'the file to match what the exporter produces',
            actual: 'it differs, so it was edited by hand or is stale',
            message: `${path} does not match the generated output`,
          });
        }
      }
      return { ok: issues.length === 0, issues };
    },
  );
}

export function canonicalDataStage(): StageResult {
  return stage(
    'canonical data validity',
    {
      reproduce: 'pnpm harness:check',
      suggestion: 'fix projects/demo-character/project.json to satisfy the schema',
    },
    () => {
      const project = loadCanonicalProject();
      const schemaResult = validateProject(project);
      const referenceResult = validateProjectReferences(project);

      const issues: StageIssue[] = [...schemaResult.issues, ...referenceResult.issues].map(
        (issue) => ({
          files: ['projects/demo-character/project.json'],
          expected: 'a valid ProjectDefinition',
          actual: `${issue.path}: ${issue.message}`,
          message: `${issue.path} ${issue.message}`,
        }),
      );

      // Dead canonical references: invariants must point at paths that exist.
      // Resolved with the same getAtPath the runtime uses — a second copy of
      // path resolution here would drift from it, which is how this check
      // reported a false positive the first time it was written.
      for (const invariant of project.invariants) {
        if (!hasPath(project, invariant.path)) {
          issues.push({
            files: ['projects/demo-character/project.json'],
            expected: `invariant path ${invariant.path} to resolve`,
            actual: 'it points at nothing',
            message: `invariant "${invariant.path}" is a dead reference`,
          });
        }
      }

      return { ok: issues.length === 0, issues };
    },
  );
}

export function staticStages(): StageResult[] {
  return [
    typecheckStage(),
    lintStage(),
    canonicalDataStage(),
    schemaDriftStage(),
    generatedArtifactStage(),
  ];
}

function main(): void {
  const results = staticStages();
  for (const result of results) printStage(result);
  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} static checks passed`);
  process.exit(failed.some((result) => result.blocksCommit) ? 1 : 0);
}

if (process.argv[1]?.includes('check-static')) main();
