import { describe, expect, it } from 'vitest';
import { setAtPath } from '@atc/runtime-core';
import { findTerrainPreset } from '@atc/terrain-runtime';
import {
  compareTraces,
  findReplayFixture,
  frameAt,
  runReplay,
  Simulation,
} from '@atc/replay-runtime';
import { loadResolvedDemoProject } from '../fixtures/project.ts';

const project = loadResolvedDemoProject();

const traceOf = (id: string) => runReplay(project, findReplayFixture(id));
const swordARootTrack = {
  times: [
    0, 0.076923, 0.153846, 0.230769, 0.307692, 0.384615, 0.461538,
    0.538462, 0.615385, 0.692308, 0.769231, 0.846154, 0.923077, 1,
  ],
  positions: [
    0, 0, 0.111641, 0.233733, 0.359309, 0.481401, 0.593042,
    0.670878, 0.735514, 0.785937, 0.82112, 0.837373, 0.829922, 0.824524,
  ].map((z) => ({ x: 0, y: 0, z })),
};

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

  it('renders the final frame of the second attack before returning to neutral', () => {
    const secondAttack = trace.ticks.filter((tick) => tick.actionState === 'attack-02');
    expect(secondAttack.at(-1)!.actionNormalizedTime).toBe(1);
  });

  const runSingleAttack = (
    usesAttackRootMotion: boolean,
    moveY = 0,
    simulationProject = project,
    usesRecovery = false,
  ) => {
    const replay = findReplayFixture('attack-01-to-attack-02');
    const singleAttack = {
      ...replay,
      id: 'single-attack-root-motion',
      frames: replay.frames.slice(0, 2).map((frame) => ({ ...frame, moveY })),
      tickCount: usesRecovery ? 120 : 80,
    };
    const simulation = new Simulation({
      project: simulationProject,
      terrain: findTerrainPreset(replay.terrainPresetId),
      seed: replay.seed,
      initialPosition: replay.initialPosition,
      initialYawRad: replay.initialYawRad,
      cameraYawRad: replay.cameraYawRad,
      upperBodyActionRootMotionEnabled: usesAttackRootMotion,
      actionRootMotionTracks: usesAttackRootMotion
        ? { 'attack-01': swordARootTrack }
        : {},
      weaponModeId: usesRecovery ? 'sword' : 'unarmed',
    });
    const ticks = Array.from({ length: singleAttack.tickCount }, (_, tick) =>
      simulation.step(frameAt(singleAttack, tick)),
    );
    return {
      simulation,
      ticks,
      attackTicks: ticks.filter((tick) => tick.actionState === 'attack-01'),
    };
  };

  it('keeps the unarmed attack in place even with forward input', () => {
    const { attackTicks } = runSingleAttack(false, 1);
    expect(attackTicks.at(-1)!.position.z).toBeCloseTo(0, 5);
  });

  it('holds attack facing until the next-input window opens', () => {
    const replay = findReplayFixture('attack-01-to-attack-02');
    const turnDuringAttack = {
      ...replay,
      tickCount: 60,
      frames: replay.frames.slice(0, 2).map((frame) => ({
        ...frame,
        moveX: 1,
      })),
    };
    const simulation = new Simulation({
      project,
      terrain: findTerrainPreset(replay.terrainPresetId),
      seed: replay.seed,
      initialPosition: replay.initialPosition,
      initialYawRad: replay.initialYawRad,
      cameraYawRad: replay.cameraYawRad,
    });
    const attackTicks = Array.from({ length: turnDuringAttack.tickCount }, (_, tick) =>
      simulation.step(frameAt(turnDuringAttack, tick)),
    ).filter((tick) => tick.actionState === 'attack-01');
    const inputStart = project.clips.find((clip) => clip.id === 'unarmed-attack-01')!.inputAcceptanceStartNormalized!;

    expect(
      attackTicks
        .filter((tick) => tick.actionNormalizedTime < inputStart)
        .every((tick) => tick.yawRad === replay.initialYawRad),
    ).toBe(true);
    expect(attackTicks.find((tick) => tick.actionNormalizedTime >= inputStart)?.yawRad).not.toBe(replay.initialYawRad);
  });

  it('uses only authored movement for the sword attack', () => {
    const withoutInput = runSingleAttack(true);
    const { attackTicks } = runSingleAttack(true, 1);
    const attackEndZ = attackTicks.at(-1)!.position.z;
    const windupZ = attackTicks.find((tick) => tick.actionNormalizedTime >= 0.075)!.position.z;
    const midpointZ = attackTicks.find((tick) => tick.actionNormalizedTime >= 0.5)!.position.z;
    expect(attackTicks.at(-1)!.actionNormalizedTime).toBe(1);
    expect(windupZ).toBeLessThan(0.01);
    expect(midpointZ).toBeGreaterThan(0.2);
    expect(attackEndZ).toBeGreaterThan(0.28);
    expect(attackEndZ).toBeLessThan(0.3);
    expect(attackEndZ).toBeCloseTo(withoutInput.attackTicks.at(-1)!.position.z, 5);
    expect(attackTicks.every((tick) => tick.grounded)).toBe(true);
  });

  it('scales the measured trajectory with the forward displacement adjustment', () => {
    const baseline = runSingleAttack(true);
    const adjustedProject = setAtPath(
      project,
      '/clips/unarmed-attack-01/rootDisplacement/z',
      0.2,
    );
    const adjusted = runSingleAttack(true, 0, adjustedProject);
    const baselineEnd = baseline.attackTicks.at(-1)!.position.z;
    const adjustedEnd = adjusted.attackTicks.at(-1)!.position.z;
    const baselineMid = baseline.attackTicks.find(
      (tick) => tick.actionNormalizedTime >= 0.5,
    )!.position.z;
    const adjustedMid = adjusted.attackTicks.find(
      (tick) => tick.actionNormalizedTime >= 0.5,
    )!.position.z;

    expect(adjustedEnd - baselineEnd).toBeCloseTo(0.2 * project.rootMotion.horizontalAuthority, 3);
    expect(adjustedMid / adjustedEnd).toBeCloseTo(baselineMid / baselineEnd, 4);
  });

  it('plays the first sword recovery through after a single attack', () => {
    const { ticks } = runSingleAttack(true, 0, project, true);
    const recovery = ticks.filter((tick) => tick.actionState === 'attack-01-recovery');
    expect(recovery.at(-1)!.actionNormalizedTime).toBe(1);
    expect(ticks.at(-1)!.actionState).toBe('action-none');
  });

  it('chains from the first recovery once its next-input window is open', () => {
    const source = findReplayFixture('attack-01-to-attack-02');
    const replay = {
      ...source,
      id: 'attack-01-recovery-to-attack-02',
      tickCount: 180,
      frames: [
        ...source.frames.slice(0, 2),
        { ...source.frames[0]!, tick: 100 },
        { ...source.frames[1]!, tick: 104 },
      ],
    };
    const simulation = new Simulation({
      project,
      terrain: findTerrainPreset(replay.terrainPresetId),
      seed: replay.seed,
      initialPosition: replay.initialPosition,
      initialYawRad: replay.initialYawRad,
      cameraYawRad: replay.cameraYawRad,
      upperBodyActionRootMotionEnabled: true,
      weaponModeId: 'sword',
    });
    const ticks = Array.from({ length: replay.tickCount }, (_, tick) =>
      simulation.step(frameAt(replay, tick)),
    );

    expect(ticks.some((tick) => tick.actionState === 'attack-01-recovery')).toBe(true);
    expect(ticks.some((tick) => tick.actionState === 'attack-02')).toBe(true);
  });

  it('dodges from the first recovery once its next-input window is open', () => {
    const source = findReplayFixture('late-dodge-cancel');
    const replay = {
      ...source,
      id: 'attack-01-recovery-to-dodge',
      tickCount: 180,
      frames: [
        ...source.frames.slice(0, 2),
        { ...source.frames[2]!, tick: 100 },
        { ...source.frames[3]!, tick: 104 },
      ],
    };
    const simulation = new Simulation({
      project,
      terrain: findTerrainPreset(replay.terrainPresetId),
      seed: replay.seed,
      initialPosition: replay.initialPosition,
      initialYawRad: replay.initialYawRad,
      cameraYawRad: replay.cameraYawRad,
      upperBodyActionRootMotionEnabled: true,
      weaponModeId: 'sword',
    });
    const ticks = Array.from({ length: replay.tickCount }, (_, tick) =>
      simulation.step(frameAt(replay, tick)),
    );

    expect(ticks.some((tick) => tick.actionState === 'attack-01-recovery')).toBe(true);
    expect(ticks.some((tick) => tick.actionState === 'dodge')).toBe(true);
  });

  it('plays the second sword recovery after the combo finishes', () => {
    const replay = {
      ...findReplayFixture('attack-01-to-attack-02'),
      tickCount: 220,
    };
    const simulation = new Simulation({
      project,
      terrain: findTerrainPreset(replay.terrainPresetId),
      seed: replay.seed,
      initialPosition: replay.initialPosition,
      initialYawRad: replay.initialYawRad,
      cameraYawRad: replay.cameraYawRad,
      upperBodyActionRootMotionEnabled: true,
      weaponModeId: 'sword',
    });
    const ticks = Array.from({ length: replay.tickCount }, (_, tick) =>
      simulation.step(frameAt(replay, tick)),
    );
    const recovery = ticks.filter((tick) => tick.actionState === 'attack-02-recovery');
    expect(recovery.at(-1)!.actionNormalizedTime).toBe(1);
    expect(ticks.some((tick) => tick.actionState === 'attack-01-recovery')).toBe(false);
    expect(ticks.at(-1)!.actionState).toBe('action-none');
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
      (tick) => tick.actionState === 'dodge' && tick.actionNormalizedTime >= 0.72,
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
  it('rejects a combo press made before the action input window opens', () => {
    const replay = findReplayFixture('attack-01-to-attack-02');
    const edited = setAtPath(
      project,
      '/clips/unarmed-attack-01/inputAcceptanceStartNormalized',
      0.75,
    );
    const trace = runReplay(edited, replay);
    expect(trace.metrics.actionSequence).toEqual(['attack-01', 'action-none']);
  });

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

describe('dodge-jump-queued', () => {
  const trace = traceOf('dodge-jump-queued');
  const dodgeTicks = trace.ticks.filter((t) => t.actionState === 'dodge');
  const jumpTick = trace.ticks.find((t) => t.locomotionState === 'jump');

  it('refuses the jump while the dodge owns the root at 100%', () => {
    const locked = dodgeTicks.filter((t) => t.actionNormalizedTime < 0.72);
    expect(locked.length).toBeGreaterThan(10);
    expect(locked.some((t) => t.locomotionState === 'jump')).toBe(false);
  });

  it('drops a jump pressed before the dodge opens its input window', () => {
    // Same script, but the press lands at ~6% into the dodge instead of at its
    // end — well before the clip's 30% input acceptance point.
    const replay = structuredClone(findReplayFixture('dodge-jump-queued'));
    for (const frame of replay.frames) {
      if (frame.tick === 40) frame.tick = 25;
      if (frame.tick === 44) frame.tick = 29;
    }
    const early = runReplay(project, replay);
    expect(early.ticks.some((t) => t.locomotionState === 'jump')).toBe(false);
  });

  it('keeps the dodge pose until the jump it releases can actually fire', () => {
    // The dodge must not be cancelled on a jump press that the root lock refuses,
    // which showed up as the dodge clip aborting with no jump to show for it.
    const cancelled = trace.ticks.find(
      (t, index) => index > 0 && trace.ticks[index - 1]!.actionState === 'dodge' && t.actionState !== 'dodge',
    );
    expect(cancelled).toBeDefined();
    expect(cancelled!.locomotionState).toBe('jump');
  });

  it('replays the queued press once the recovery window opens', () => {
    expect(jumpTick).toBeDefined();
    expect(jumpTick!.tick).toBeGreaterThan(dodgeTicks[0]!.tick);
    expect(jumpTick!.tick).toBeLessThan(dodgeTicks[dodgeTicks.length - 1]!.tick + 20);
  });
});
