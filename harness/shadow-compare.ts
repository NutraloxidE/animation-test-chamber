/**
 * Shadow runtime verification (PLAN 35).
 *
 * The migration is only correct if the character still moves the way it did.
 * Reasoning about that is not good enough — every name-based branch that was
 * translated into a policy field is a place where "obviously equivalent" could
 * be quietly wrong.
 *
 * So the pre-migration runtime is the oracle. Its traces were captured from the
 * commit before the asset split and frozen at
 * `tests/fixtures/animation-assets/legacy-replay-traces.json`; this compares the
 * asset-resolved runtime against them, tick for tick, via a hash over the whole
 * trace. The sequences and metrics alongside it exist to make a failure
 * readable, not to weaken the check — the hash is what decides.
 */
import { createHash } from 'node:crypto';
import type { ReplayTrace } from '@atc/replay-runtime';
import { REPLAY_FIXTURES, runReplay } from '@atc/replay-runtime';
import { readRepoFile } from './lib.ts';
import { loadResolvedProject } from './animation-assets.ts';

export const LEGACY_TRACE_FIXTURE =
  'tests/fixtures/animation-assets/legacy-replay-traces.json';

export interface LegacyTrace {
  tickCount: number;
  traceHash: string;
  locomotionSequence: string[];
  actionSequence: string[];
  events: string[];
  finalPosition: { x: number; y: number; z: number };
  metrics: Record<string, unknown>;
}

export function runsOf<T>(values: T[]): T[] {
  return values.filter(
    (value, index) => index === 0 || JSON.stringify(value) !== JSON.stringify(values[index - 1]!),
  );
}

export function summarizeTrace(trace: ReplayTrace): LegacyTrace {
  return {
    tickCount: trace.ticks.length,
    traceHash: createHash('sha256').update(JSON.stringify(trace.ticks)).digest('hex'),
    locomotionSequence: runsOf(trace.ticks.map((tick) => tick.locomotionState)),
    actionSequence: runsOf(trace.ticks.map((tick) => tick.actionState)),
    events: trace.ticks.flatMap((tick) => tick.events),
    finalPosition: trace.ticks.at(-1)!.position,
    metrics: trace.metrics as unknown as Record<string, unknown>,
  };
}

export function loadLegacyTraces(): Record<string, LegacyTrace> {
  const raw = readRepoFile(LEGACY_TRACE_FIXTURE);
  if (!raw) {
    throw new Error(
      `${LEGACY_TRACE_FIXTURE} is missing. It holds the pre-migration traces the ` +
        `asset-resolved runtime is checked against; without it the migration is unverified.`,
    );
  }
  return JSON.parse(raw) as Record<string, LegacyTrace>;
}

export interface ShadowDifference {
  replayId: string;
  field: string;
  expected: unknown;
  actual: unknown;
}

/** Every difference between the legacy oracle and the asset-resolved runtime. */
export function compareAgainstLegacy(characterId?: string): ShadowDifference[] {
  const legacy = loadLegacyTraces();
  const project = loadResolvedProject(characterId ? { characterId } : {});
  const differences: ShadowDifference[] = [];

  for (const replay of REPLAY_FIXTURES) {
    const expected = legacy[replay.id];
    if (!expected) {
      differences.push({
        replayId: replay.id,
        field: 'fixture',
        expected: 'a captured legacy trace',
        actual: 'none',
      });
      continue;
    }
    const actual = summarizeTrace(runReplay(project, replay));
    for (const field of [
      'tickCount',
      'traceHash',
      'locomotionSequence',
      'actionSequence',
      'events',
      'finalPosition',
      'metrics',
    ] as const) {
      if (JSON.stringify(expected[field]) !== JSON.stringify(actual[field])) {
        differences.push({
          replayId: replay.id,
          field,
          expected: expected[field],
          actual: actual[field],
        });
      }
    }
  }

  return differences;
}

/**
 * The second character's check (PLAN 41.3). It runs a different motion set, so
 * its clip ids differ by construction; what must be identical is the state and
 * transition sequencing, because that is the behaviour it is reusing.
 */
export function compareSharedBehaviorSequences(
  characterA: string,
  characterB: string,
): ShadowDifference[] {
  const differences: ShadowDifference[] = [];
  const a = loadResolvedProject({ characterId: characterA });
  const b = loadResolvedProject({ characterId: characterB });

  for (const replay of REPLAY_FIXTURES) {
    const left = summarizeTrace(runReplay(a, replay));
    const right = summarizeTrace(runReplay(b, replay));
    for (const field of ['locomotionSequence', 'actionSequence'] as const) {
      if (JSON.stringify(left[field]) !== JSON.stringify(right[field])) {
        differences.push({
          replayId: replay.id,
          field,
          expected: left[field],
          actual: right[field],
        });
      }
    }
  }

  // The clips must genuinely differ, or "two characters share a behaviour"
  // would be satisfied by them being the same character twice.
  const sharedClips = Object.entries(a.motionBindings).filter(
    ([slot, clipId]) => b.motionBindings[slot] === clipId,
  );
  if (sharedClips.length > 0) {
    differences.push({
      replayId: '(motion sets)',
      field: 'motionBindings',
      expected: 'no slot bound to the same clip in both characters',
      actual: sharedClips.map(([slot]) => slot),
    });
  }

  return differences;
}

function main(): void {
  const differences = compareAgainstLegacy();
  for (const difference of differences.slice(0, 10)) {
    console.log(`- ${difference.replayId} ${difference.field}`);
    console.log(`    expected: ${JSON.stringify(difference.expected).slice(0, 200)}`);
    console.log(`    actual:   ${JSON.stringify(difference.actual).slice(0, 200)}`);
  }
  console.log(
    differences.length === 0
      ? `shadow comparison: ${REPLAY_FIXTURES.length} replays identical to the legacy runtime`
      : `shadow comparison: ${differences.length} difference(s)`,
  );
  process.exit(differences.length === 0 ? 0 : 1);
}

if (process.argv[1]?.includes('shadow-compare')) main();
