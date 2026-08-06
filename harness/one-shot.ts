/**
 * `pnpm harness:one-shot` — the gate an agent must pass before claiming the
 * work is finished (PLAN 17.1).
 *
 * Runs every stage in dependency order and writes reports/one-shot-report.json
 * and reports/one-shot-report.md. A failure reports the stage, the affected
 * files, expected versus actual, how to reproduce it, whether it blocks a
 * commit, and what to do next.
 */
import { staticStages } from './check-static.ts';
import { animationAssetStages } from './check-animation-assets.ts';
import { prefabStages } from './check-prefabs.ts';
import { gameObjectStages } from './check-game-objects.ts';
import { gameObjectRendererStages } from './check-game-object-renderer.ts';
import { transactionRecoveryStage } from './check-transaction-recovery.ts';
import { worldStages } from './check-world.ts';
import { capabilityStages } from './check-capabilities.ts';
import { repoGuardStages } from './repo-guard.ts';
import { buildStage } from './build.ts';
import { printStage, run, stage, writeRepoFile, type StageResult } from './lib.ts';

function vitestStage(name: string, directory: string, suggestion: string): StageResult {
  return stage(
    name,
    { reproduce: `npx vitest run ${directory}`, suggestion },
    () => {
      const { code, output } = run('npx', ['vitest', 'run', directory]);
      if (code === 0) {
        const summary = output
          .split('\n')
          .filter((line) => line.includes('Tests') || line.includes('Test Files'))
          .join(' | ');
        return { ok: true, issues: [], output: summary };
      }
      const failures = output
        .split('\n')
        .filter((line) => line.includes('FAIL') || line.trim().startsWith('→'))
        .slice(0, 20);
      return {
        ok: false,
        issues: failures.map((line) => ({
          files: [directory],
          expected: 'the test to pass',
          actual: line.trim(),
          message: line.trim(),
        })),
        output,
      };
    },
  );
}

function playwrightStage(): StageResult {
  return stage(
    'visual (playwright)',
    {
      reproduce: 'pnpm harness:visual',
      blocksCommit: true,
      suggestion: 'run `npx playwright test --ui` to inspect the failing view',
    },
    () => {
      /*
       * Through the isolating wrapper, never `playwright test` directly. The
       * visual suite performs real writes through the real API, and run against
       * the source checkout it modified the canonical demo project — leaving
       * replay and animation-assets red for every later run. A one-shot stage
       * that corrupts the inputs of the stages before it is worse than no stage.
       */
      const { code, output } = run('npx', ['tsx', 'harness/visual.ts']);
      if (code === 0) {
        return { ok: true, issues: [], output: output.split('\n').slice(-4).join('\n') };
      }
      return {
        ok: false,
        issues: [
          {
            files: ['tests/visual'],
            expected: 'every view to render and respond',
            actual: output.split('\n').slice(-25).join('\n'),
            message: 'playwright reported failures',
          },
        ],
        output,
      };
    },
  );
}

function renderMarkdown(results: StageResult[], startedAt: string, totalMs: number): string {
  const passed = results.filter((result) => result.ok).length;
  const blocking = results.filter((result) => !result.ok && result.blocksCommit);

  const lines: string[] = [
    '# One-shot harness report',
    '',
    `- Run at: ${startedAt}`,
    `- Duration: ${(totalMs / 1000).toFixed(1)}s`,
    `- Stages passed: ${passed}/${results.length}`,
    `- Commit blocked: ${blocking.length > 0 ? 'yes' : 'no'}`,
    '',
    '## Stages',
    '',
    '| Stage | Result | Duration | Blocks commit |',
    '| --- | --- | --- | --- |',
  ];

  for (const result of results) {
    lines.push(
      `| ${result.name} | ${result.ok ? 'pass' : 'FAIL'} | ${(result.durationMs / 1000).toFixed(1)}s | ${
        result.blocksCommit ? 'yes' : 'no'
      } |`,
    );
  }

  const failures = results.filter((result) => !result.ok);
  if (failures.length > 0) {
    lines.push('', '## Failures', '');
    for (const failure of failures) {
      lines.push(`### ${failure.name}`, '');
      lines.push(`- Reproduce: \`${failure.reproduce}\``);
      lines.push(`- Blocks commit: ${failure.blocksCommit ? 'yes' : 'no'}`);
      if (failure.suggestion) lines.push(`- Next action: ${failure.suggestion}`);
      lines.push('', 'Issues:', '');
      for (const issue of failure.issues.slice(0, 15)) {
        lines.push(`- ${issue.message}`);
        if (issue.files.length > 0) lines.push(`  - files: ${issue.files.join(', ')}`);
        if (issue.expected) lines.push(`  - expected: ${issue.expected}`);
        if (issue.actual) lines.push(`  - actual: \`${issue.actual.replace(/`/g, "'")}\``);
      }
      lines.push('');
    }
  } else {
    lines.push('', 'All stages passed.', '');
  }

  return `${lines.join('\n')}\n`;
}

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const results: StageResult[] = [];

  console.log('Animation Test Chamber — one-shot harness\n');

  // Static first: a type error makes every later stage meaningless.
  for (const result of staticStages()) {
    printStage(result);
    results.push(result);
  }

  // Asset integrity before the tests: a stale index or an unresolvable
  // reference makes every later failure a symptom rather than a cause.
  for (const result of animationAssetStages()) {
    printStage(result);
    results.push(result);
  }

  // Prefabs after the animation assets they reference and before the runtime
  // that instantiates them: a Prefab whose Animator names a missing Motion Set
  // would otherwise surface as a GameObject that will not tick, which is the
  // symptom rather than the cause.
  for (const result of prefabStages()) {
    printStage(result);
    results.push(result);
  }
  for (const result of gameObjectStages()) {
    printStage(result);
    results.push(result);
  }
  // The renderer projection last of the GameObject stages: it asserts what the
  // production Viewport draws, and it can only mean anything once the objects
  // it draws are known to resolve and to run.
  for (const result of gameObjectRendererStages()) {
    printStage(result);
    results.push(result);
  }

  // Also before the tests: an unresolved transaction from a prior crash
  // would make the write API read-only, which every later write-path test
  // would then fail for a reason that has nothing to do with what they test.
  results.push(transactionRecoveryStage());
  printStage(results.at(-1)!);

  // The world contract and capability completeness come before the suites for
  // the same reason the asset stages do: a broken contract turns every later
  // failure into a symptom of it.
  for (const result of worldStages()) {
    printStage(result);
    results.push(result);
  }
  for (const result of capabilityStages()) {
    printStage(result);
    results.push(result);
  }

  results.push(vitestStage('unit', 'tests/unit', 'fix the implementation, not the assertion'));
  printStage(results.at(-1)!);

  results.push(
    vitestStage('integration', 'tests/integration', 'check the edit -> stage -> commit path'),
  );
  printStage(results.at(-1)!);

  results.push(
    vitestStage(
      'replay',
      'tests/replay',
      'a replay difference is never auto-accepted: decide whether it is a fix or a regression',
    ),
  );
  printStage(results.at(-1)!);

  for (const result of repoGuardStages()) {
    printStage(result);
    results.push(result);
  }

  const build = buildStage();
  printStage(build);
  results.push(build);

  // Visual last: it needs a build and a browser, and is the slowest stage.
  const visual = playwrightStage();
  printStage(visual);
  results.push(visual);

  const totalMs = Date.now() - started;
  const passed = results.filter((result) => result.ok).length;
  const blocking = results.filter((result) => !result.ok && result.blocksCommit);

  writeRepoFile(
    'reports/one-shot-report.json',
    `${JSON.stringify({ startedAt, totalMs, passed, total: results.length, results }, null, 2)}\n`,
  );
  writeRepoFile('reports/one-shot-report.md', renderMarkdown(results, startedAt, totalMs));

  console.log(`\n${'='.repeat(60)}`);
  console.log(`${passed}/${results.length} stages passed in ${(totalMs / 1000).toFixed(1)}s`);
  console.log(`reports/one-shot-report.md written`);
  if (blocking.length > 0) {
    console.log(`\nCOMMIT BLOCKED by: ${blocking.map((result) => result.name).join(', ')}`);
  }
  console.log('='.repeat(60));

  process.exit(blocking.length > 0 ? 1 : 0);
}

void main();
