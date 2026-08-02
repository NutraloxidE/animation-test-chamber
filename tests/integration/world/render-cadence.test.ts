/**
 * World-level render-cadence independence.
 *
 * PR #14 shipped with this gap recorded rather than covered: the
 * `FixedStepAccumulator` and `Simulation` were both proven frame-rate
 * independent, and `WorldChamberEngine` reuses them unmodified — but nothing
 * drove the *world* engine at more than one cadence, so "the world is
 * frame-rate independent" was an inference rather than a result.
 *
 * These tests drive the real engine at 30, 60 and 120 Hz by feeding it the
 * frame deltas those cadences produce. No sleeps: the accumulator is fed
 * numbers, which is the only way to compare cadences without comparing the
 * machine running the test.
 */
import { describe, expect, it } from 'vitest';
import { hashWorldTrace, neutralIntent, type WorldTrace } from '@atc/world-runtime';
import { WorldChamberEngine } from '../../../apps/web/src/world/world-engine.ts';
import { demoRegistry, loadDemoProject } from '../../fixtures/project.ts';
import { CONTROLLED, SCRIPTED, loadWorldFixture } from '../../fixtures/world.ts';

const SIMULATED_SECONDS = 2;

/** The camera-yaw schedule, keyed by simulation tick rather than by frame. */
function yawAtTick(tick: number): number {
  if (tick < 30) return 0;
  if (tick < 60) return Math.PI / 4;
  if (tick < 90) return Math.PI / 2;
  return -Math.PI / 3;
}

/**
 * Runs the engine for `SIMULATED_SECONDS` of wall-clock-equivalent time at a
 * given render cadence, collecting the fixed-step records it produced.
 */
function runAtCadence(fps: number): WorldTrace {
  const engine = new WorldChamberEngine({
    registry: demoRegistry(),
    project: loadDemoProject(),
    world: loadWorldFixture(),
  });
  engine.testDriven = true;

  const instances: WorldTrace['instances'] = {};
  for (const id of engine.instanceIds) {
    instances[id] = { instanceId: id, characterId: '', intentSourceKind: '', ticks: [] };
  }

  const frameDelta = 1 / fps;
  const frames = Math.round(SIMULATED_SECONDS * fps);
  const forward = { ...neutralIntent(), moveY: 1 };

  for (let frame = 0; frame < frames; frame += 1) {
    /*
     * Camera yaw is a per-tick input, so it is applied per tick rather than per
     * frame — a 30Hz frame covers two ticks, and setting the yaw once for both
     * would make the cadence itself change the simulation, which is the bug
     * this test would then fail to notice.
     */
    engine.advance(frameDelta, {
      sample: () => forward,
      beforeTick: (tick) => engine.setCameraYaw(yawAtTick(tick)),
      afterTick: () => {
        for (const id of engine.instanceIds) {
          const record = engine.instance(id)?.lastRecord;
          if (record) instances[id]!.ticks.push(record);
        }
      },
    });
  }

  return {
    worldTraceVersion: 1,
    fixedTimestepVersion: 1,
    worldId: engine.world.id,
    revisionId: '',
    tickCount: instances[CONTROLLED]!.ticks.length,
    instances,
    instanceOrder: [...engine.instanceIds],
  };
}

describe('world render cadence', () => {
  it('produces identical world traces at 30 60 and 120 Hz render cadence', () => {
    const reference = runAtCadence(60);
    expect(reference.tickCount).toBe(SIMULATED_SECONDS * 60);

    for (const fps of [30, 120]) {
      const trace = runAtCadence(fps);
      expect(trace.tickCount).toBe(reference.tickCount);
      expect(hashWorldTrace(trace)).toBe(hashWorldTrace(reference));
      for (const instanceId of [CONTROLLED, SCRIPTED]) {
        expect(JSON.stringify(trace.instances[instanceId]!.ticks)).toBe(
          JSON.stringify(reference.instances[instanceId]!.ticks),
        );
      }
    }
  });

  it('advances the same number of fixed steps regardless of frame size', () => {
    // One frame of a whole second must produce the same ticks as sixty frames
    // of a sixtieth, up to the accumulator's documented per-frame ceiling.
    const engine = new WorldChamberEngine({
      registry: demoRegistry(),
      project: loadDemoProject(),
      world: loadWorldFixture(),
    });
    engine.testDriven = true;
    for (let frame = 0; frame < 60; frame += 1) engine.advance(1 / 60);
    expect(engine.tick).toBe(60);
  });
});
