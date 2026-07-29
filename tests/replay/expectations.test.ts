import { describe, expect, it } from 'vitest';
import { setAtPath } from '@atc/runtime-core';
import { compareTraces, findReplayFixture, runReplay } from '@atc/replay-runtime';
import { loadDemoProject } from '../fixtures/project.ts';

const project = loadDemoProject();

const traceOf = (id: string) => runReplay(project, findReplayFixture(id));

describe('run-to-attack-forward', () => {
  const trace = traceOf('run-to-attack-forward');

  it('reaches running speed before attacking', () => {
    expect(trace.metrics.stateSequence).toContain('run');
  });

  it('performs the attack and returns to neutral', () => {
    expect(trace.metrics.actionSequence).toEqual(['action-none', 'attack-01', 'action-none']);
  });

  it('fires the attack hit event exactly once', () => {
    const hits = trace.metrics.eventTimeline.filter((entry) => entry.event === 'AttackHit');
    expect(hits).toHaveLength(1);
  });

  it('travels forward on flat ground without leaving it', () => {
    expect(trace.metrics.finalPosition.z).toBeGreaterThan(5);
    expect(trace.metrics.finalPosition.y).toBeCloseTo(0, 3);
  });
});

describe('attack-01-to-attack-02', () => {
  const trace = traceOf('attack-01-to-attack-02');

  it('chains the combo through the cancel window', () => {
    expect(trace.metrics.actionSequence).toEqual(['attack-01', 'attack-02', 'action-none']);
  });

  it('fires two attack hits, one per swing', () => {
    const hits = trace.metrics.eventTimeline.filter((entry) => entry.event === 'AttackHit');
    expect(hits).toHaveLength(2);
    expect(hits[1]!.tick).toBeGreaterThan(hits[0]!.tick);
  });
});

describe('late-dodge-cancel', () => {
  const trace = traceOf('late-dodge-cancel');
  const movingReplay = findReplayFixture('late-dodge-cancel');
  const movingTrace = runReplay(project, {
    ...movingReplay,
    frames: movingReplay.frames.map((frame) =>
      frame.tick >= 36 ? { ...frame, moveY: 1 } : frame,
    ),
  });

  it('cancels the attack into a dodge rather than waiting for recovery', () => {
    expect(trace.metrics.actionSequence).toEqual(['attack-01', 'dodge', 'action-none']);
  });

  it('emits the dodge start and end events', () => {
    const events = trace.metrics.eventTimeline.map((entry) => entry.event);
    expect(events).toContain('DodgeStart');
    expect(events).toContain('DodgeEnd');
  });

  it('plays the full-body dodge through while its root stays grounded', () => {
    const dodgeTicks = trace.ticks.filter((tick) => tick.actionState === 'dodge');
    expect(dodgeTicks).toHaveLength(88);
    expect(dodgeTicks.at(-1)!.actionNormalizedTime).toBeGreaterThan(0.98);
    expect(dodgeTicks.at(-1)!.position.z - dodgeTicks[0]!.position.z).toBeGreaterThan(1.8);
    expect(dodgeTicks.every((tick) => tick.grounded && tick.position.y === 0)).toBe(true);
  });

  it('accelerates quickly, then eases out for the recovery', () => {
    const dodgeTicks = trace.ticks.filter((tick) => tick.actionState === 'dodge');
    const deltas = dodgeTicks.slice(1).map((tick, index) =>
      tick.position.z - dodgeTicks[index]!.position.z,
    );
    const peak = Math.max(...deltas);
    expect(deltas.indexOf(peak)).toBeLessThan(deltas.length * 0.15);
    expect(deltas[10]).toBeGreaterThan(deltas[1]!);
    expect(deltas.at(-1)!).toBeLessThan(peak * 0.15);
  });

  it('keeps locomotion active through dodge recovery when movement is held', () => {
    const recovery = movingTrace.ticks.filter(
      (tick) => tick.actionState === 'dodge' && tick.actionNormalizedTime >= 0.78,
    );
    const afterDodge = movingTrace.ticks.find(
      (tick, index) =>
        index > 0 &&
        movingTrace.ticks[index - 1]!.actionState === 'dodge' &&
        tick.actionState === 'action-none',
    );

    expect(recovery.length).toBeGreaterThan(0);
    expect(recovery.every((tick) => tick.locomotionState === 'run')).toBe(true);
    expect(afterDodge?.locomotionState).toBe('run');
    expect(afterDodge?.velocity.z).toBeGreaterThan(0);
  });
});

describe('jump-buffer-before-landing', () => {
  const trace = traceOf('jump-buffer-before-landing');

  it('jumps twice: once on the ground, once from the buffered press', () => {
    const jumps = trace.metrics.stateSequence.filter((state) => state === 'jump');
    expect(jumps).toHaveLength(2);
  });

  it('emits a takeoff event for each jump', () => {
    const takeoffs = trace.metrics.eventTimeline.filter((e) => e.event === 'JumpTakeoff');
    expect(takeoffs).toHaveLength(2);
  });

  it('does not honour a press that expired long before landing', () => {
    // Move the second press far earlier so it falls outside the 140ms buffer.
    const replay = findReplayFixture('jump-buffer-before-landing');
    const early = {
      ...replay,
      frames: replay.frames.map((frame) => (frame.tick === 66 ? { ...frame, tick: 40 } : frame.tick === 70 ? { ...frame, tick: 44 } : frame)),
    };
    const jumps = runReplay(project, early).metrics.stateSequence.filter((s) => s === 'jump');
    expect(jumps).toHaveLength(1);
  });
});

describe('downhill-root-motion', () => {
  const trace = traceOf('downhill-root-motion');

  it('descends the slope and settles at its foot', () => {
    expect(trace.metrics.finalPosition.y).toBeCloseTo(-2, 2);
  });

  it('stays attached to the ground instead of bouncing down it', () => {
    // Downhill adhesion exists precisely to stop grounded/airborne chatter.
    expect(trace.metrics.groundedFlickerCount).toBeLessThanOrEqual(2);
  });

  it('reports a bounded root-motion error', () => {
    expect(trace.metrics.rootMotionError).toBeLessThan(trace.metrics.finalPosition.z);
  });
});

describe('stair-foot-ik', () => {
  const trace = traceOf('stair-foot-ik');

  it('climbs every step', () => {
    // 14 steps of 0.18m.
    expect(trace.metrics.finalPosition.y).toBeCloseTo(2.52, 2);
  });

  it('reports the stepping-up terrain state while climbing', () => {
    const states = new Set(trace.ticks.map((tick) => tick.terrainState));
    expect(states.has('SteppingUp')).toBe(true);
  });

  it('never penetrates the geometry', () => {
    expect(trace.metrics.maxPenetration).toBeLessThan(0.05);
  });
});

describe('moving-platform-jump', () => {
  const trace = traceOf('moving-platform-jump');

  it('rides the platform sideways while standing still', () => {
    expect(Math.abs(trace.metrics.finalPosition.x)).toBeGreaterThan(0.5);
  });

  it('lands back on the platform after each jump', () => {
    expect(trace.metrics.finalPosition.y).toBeCloseTo(0, 2);
    expect(trace.metrics.stateSequence.filter((state) => state === 'jump')).toHaveLength(2);
  });

  it('reports the moving-platform terrain state', () => {
    const states = new Set(trace.ticks.map((tick) => tick.terrainState));
    expect(states.has('OnMovingPlatform')).toBe(true);
  });
});

describe('ice-surface-stop', () => {
  const trace = traceOf('ice-surface-stop');

  it('keeps gliding after the stick is released', () => {
    const atRelease = trace.ticks[90]!;
    const shortlyAfter = trace.ticks[110]!;
    expect(shortlyAfter.position.z).toBeGreaterThan(atRelease.position.z);
  });

  it('glides much further after release than a high-friction surface does', () => {
    // Compare the distance travelled *after* the stick is released, which
    // isolates deceleration. Total distance would also fold in ice's slow
    // acceleration and tell us nothing about how it stops.
    const glideAfterRelease = (traceToMeasure: typeof trace): number => traceToMeasure.metrics.finalPosition.z - traceToMeasure.ticks[90]!.position.z;

    const gripReplay = {
      ...findReplayFixture('ice-surface-stop'),
      terrainPresetId: 'high-friction',
    };
    const gripTrace = runReplay(project, gripReplay);

    expect(glideAfterRelease(trace)).toBeGreaterThan(glideAfterRelease(gripTrace) * 3);
  });
});

describe('regression detection', () => {
  it('detects a state-sequence change caused by an edit', () => {
    const replay = findReplayFixture('attack-01-to-attack-02');
    const before = runReplay(project, replay);

    // Close the combo window so the second press can no longer chain.
    const edited = setAtPath(project, '/graph/transitions/attack-01-to-attack-02/cancelWindow/end', 0.36);
    const after = runReplay(edited, replay);

    const comparison = compareTraces(before, after);
    expect(comparison.identical).toBe(false);
    expect(comparison.differences.some((d) => d.kind === 'state-sequence')).toBe(true);
  });

  it('does not report a difference when nothing relevant changed', () => {
    const replay = findReplayFixture('run-to-attack-forward');
    const before = runReplay(project, replay);
    // Camera distance cannot affect the simulation.
    const edited = setAtPath(project, '/camera/distance', 9);
    expect(compareTraces(before, runReplay(edited, replay)).identical).toBe(true);
  });

  it('flags a position divergence beyond tolerance', () => {
    const replay = findReplayFixture('run-to-attack-forward');
    const before = runReplay(project, replay);
    const edited = setAtPath(project, '/movement/runSpeed', 7);
    const comparison = compareTraces(before, runReplay(edited, replay));
    expect(comparison.differences.some((d) => d.kind === 'position')).toBe(true);
  });
});
