import { printStage, run, stage, type StageResult } from './lib.ts';

export function buildStage(): StageResult {
  return stage(
    'web build',
    {
      reproduce: 'pnpm --filter @atc/web build',
      suggestion: 'fix the build error; do not disable the failing import',
    },
    () => {
      const { code, output } = run('npx', ['pnpm', '--filter', '@atc/web', 'build']);
      if (code === 0) return { ok: true, issues: [], output: output.split('\n').slice(-6).join('\n') };
      return {
        ok: false,
        issues: [
          {
            files: ['apps/web'],
            expected: 'a successful production build',
            actual: output.split('\n').slice(-12).join('\n'),
            message: 'vite build failed',
          },
        ],
        output,
      };
    },
  );
}

function main(): void {
  const result = buildStage();
  printStage(result);
  process.exit(result.ok ? 0 : 1);
}

if (process.argv[1]?.includes('build')) main();
