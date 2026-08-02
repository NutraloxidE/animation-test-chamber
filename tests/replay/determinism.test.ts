import { describe, expect, it } from 'vitest';
import { FIXED_DT, FixedStepAccumulator } from '@atc/runtime-core';
import {
  REPLAY_FIXTURES,
  Simulation,
  compareTraces,
  findReplayFixture,
  runReplay,
} from '@atc/replay-runtime';
import { frameAt } from '@atc/replay-runtime';
import { emptyButtons } from '@atc/input-runtime';
import { findTerrainPreset } from '@atc/terrain-runtime';
import { loadResolvedDemoProject } from '../fixtures/project.ts';

const project = loadResolvedDemoProject();

describe('replay determinism', () => {
  it.each(REPLAY_FIXTURES.map((replay) => replay.id))(
    'produces an identical trace on repeated runs: %s',
    (id) => {
      const replay = findReplayFixture(id);
      const first = runReplay(project, replay);
      const second = runReplay(project, replay);
      expect(JSON.stringify(second.ticks)).toBe(JSON.stringify(first.ticks));
      expect(compareTraces(first, second).identical).toBe(true);
    },
  );

  it.each(REPLAY_FIXTURES.map((replay) => replay.id))(
    'is unaffected by render frame rate: %s',
    (id) => {
      const replay = findReplayFixture(id);
      const reference = runReplay(project, replay);

      // Drive the same simulation through accumulators fed 30fps and 120fps
      // frame deltas. The tick count reaching the simulation must be identical.
      for (const fps of [30, 120]) {
        const simulation = new Simulation({
          project,
          terrain: findTerrainPreset(replay.terrainPresetId),
          seed: replay.seed,
          initialPosition: replay.initialPosition,
          initialYawRad: replay.initialYawRad,
          cameraYawRad: replay.cameraYawRad,
        });
        const accumulator = new FixedStepAccumulator();
        const records = [];
        let frames = 0;
        while (records.length < replay.tickCount && frames < replay.tickCount * 10) {
          frames += 1;
          const ticks = accumulator.advance(1 / fps);
          for (let i = 0; i < ticks && records.length < replay.tickCount; i += 1) {
            records.push(simulation.step(frameAt(replay, records.length)));
          }
        }
        expect(records.length).toBe(replay.tickCount);
        expect(JSON.stringify(records)).toBe(JSON.stringify(reference.ticks));
      }
    },
  );

  it('reports the fixed timestep version the trace was produced under', () => {
    const trace = runReplay(project, findReplayFixture('run-to-attack-forward'));
    expect(trace.fixedTimestepVersion).toBe(1);
    expect(trace.revisionId).toBe(project.revisionId);
  });

  it('advances exactly one tick per step', () => {
    const replay = findReplayFixture('run-to-attack-forward');
    const trace = runReplay(project, replay);
    expect(trace.ticks).toHaveLength(replay.tickCount);
    expect(trace.ticks[10]!.tick).toBe(10);
  });

  it('uses no wall-clock time: a delayed second run matches the first', async () => {
    const replay = findReplayFixture('moving-platform-jump');
    const first = runReplay(project, replay);
    await new Promise((resolve) => setTimeout(resolve, 25));
    const second = runReplay(project, replay);
    expect(JSON.stringify(second.ticks)).toBe(JSON.stringify(first.ticks));
  });
});

describe('simulation time base', () => {
  it('maps positive horizontal input to screen-right camera-relative movement', () => {
    const simulation = new Simulation({
      project,
      terrain: findTerrainPreset('flat'),
      seed: 1,
      initialPosition: { x: 0, y: 0, z: 0 },
      initialYawRad: 0,
      cameraYawRad: 0,
    });
    const right = { moveX: 1, moveY: 0, lookX: 0, lookY: 0, buttons: emptyButtons() };

    for (let i = 0; i < 60; i += 1) simulation.step(right);

    expect(simulation.state.position.x).toBeLessThan(0);
  });

  it('advances simulation time by exactly the fixed step', () => {
    const simulation = new Simulation({
      project,
      terrain: findTerrainPreset('flat'),
      seed: 1,
      initialPosition: { x: 0, y: 0, z: 0 },
      initialYawRad: 0,
      cameraYawRad: 0,
    });
    simulation.step(frameAt(findReplayFixture('run-to-attack-forward'), 0));
    expect(simulation.state.timeSec).toBeCloseTo(FIXED_DT, 10);
  });
});
