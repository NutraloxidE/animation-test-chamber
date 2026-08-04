/**
 * Regenerates the replay trace oracle from canonical code.
 *
 * The oracle in `tests/fixtures/animation-assets/legacy-replay-traces.json` is
 * a *captured* answer, not a derived one: it exists so that a refactor which
 * quietly changes motion is caught by a value nobody can adjust while chasing
 * green. That makes hand-editing it the single most damaging thing anybody can
 * do to this repository's evidence, so the only supported way to move it is
 * this generator, which rebuilds every entry from the same functions the test
 * compares against.
 *
 * Running it is therefore a deliberate statement: "the canonical authored data
 * changed, and the oracle should now describe the new authored behaviour." It
 * must never be run to make an unexplained difference disappear — the causality
 * proof in `reports/trace-baseline-resolution.md` is what licenses a run.
 *
 * `--check` regenerates in memory and fails if the committed fixture differs,
 * which is what a CI stage wants.
 * `--stdout` prints the generated fixture without writing, which is how two
 * different checkouts can be compared field by field.
 */
import { REPLAY_FIXTURES, runReplay } from '@atc/replay-runtime';
import { loadResolvedProject } from './animation-assets.ts';
import { summarizeTrace } from './shadow-compare.ts';
import { readRepoFile, writeRepoFile } from './lib.ts';

const FIXTURE = 'tests/fixtures/animation-assets/legacy-replay-traces.json';

/** The oracle, rebuilt from canonical data. Key order follows REPLAY_FIXTURES. */
export function buildLegacyTraces(characterId?: string): Record<string, unknown> {
  const project = loadResolvedProject(characterId ? { characterId } : {});
  const traces: Record<string, unknown> = {};
  for (const replay of REPLAY_FIXTURES) {
    traces[replay.id] = summarizeTrace(runReplay(project, replay));
  }
  return traces;
}

export function serializeLegacyTraces(characterId?: string): string {
  return `${JSON.stringify(buildLegacyTraces(characterId), null, 2)}\n`;
}

function main(): void {
  const content = serializeLegacyTraces();

  if (process.argv.includes('--stdout')) {
    process.stdout.write(content);
    return;
  }

  const current = readRepoFile(FIXTURE);
  if (current === content) {
    console.log(`[OK] ${FIXTURE} already matches canonical behaviour`);
    return;
  }

  if (process.argv.includes('--check')) {
    console.error(
      `[FAIL] ${FIXTURE} does not match canonical behaviour.\n` +
        'If the canonical authored data genuinely changed, prove causality first ' +
        '(reports/trace-baseline-resolution.md) and then run `pnpm traces:generate`.',
    );
    process.exit(1);
  }

  writeRepoFile(FIXTURE, content);
  console.log(`[WROTE] ${FIXTURE} (${Object.keys(JSON.parse(content) as object).length} replays)`);
}

if (process.argv[1]?.includes('generate-legacy-traces')) main();
