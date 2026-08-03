/**
 * The State Sandbox does not touch the live world.
 *
 * The claim is not "we were careful". A sandbox that shared one mutable object
 * with `WorldRuntime` would advance the world by stepping, and the way to know
 * that has not happened is to step the sandbox hard and then check that every
 * observable of the world is bit-for-bit what it was.
 *
 * These tests exercise the engine through `Simulation` directly rather than
 * through the React store, because the isolation guarantee is a property of the
 * runtime layering and not of the UI that happens to drive it.
 */
import { describe, expect, it } from 'vitest';
import { Simulation, defaultEquipped } from '@atc/replay-runtime';
import { findTerrainPreset } from '@atc/terrain-runtime';
import { emptySample, type ActionSample } from '@atc/input-runtime';
import { observeWorld } from '@atc/world-runtime';
import { loadResolvedDemoProject } from '../../fixtures/project.ts';
import { CONTROLLED, createWorldRuntime } from '../../fixtures/world.ts';

const resolved = loadResolvedDemoProject();
const attackState = resolved.graph.states.find(
  (state) => state.layer === 'action' && state.id !== 'action-none',
)!;

function sandbox(bootstrapStateId?: string): Simulation {
  return new Simulation({
    project: resolved,
    terrain: findTerrainPreset(resolved.defaultTerrainPresetId),
    seed: 1,
    initialPosition: { x: 0, y: 0, z: 0 },
    initialYawRad: 0,
    cameraYawRad: 0,
    equipped: defaultEquipped(resolved),
    ...(bootstrapStateId ? { bootstrap: { states: { action: bootstrapStateId } } } : {}),
  });
}

function attackIntent(): ActionSample {
  const sample = emptySample();
  sample.buttons.PrimaryAction = true;
  return sample;
}

describe('sandbox isolation', () => {
  it('stepping the sandbox 120 ticks leaves the live world untouched', () => {
    const world = createWorldRuntime();
    world.run(30);
    const before = structuredClone(observeWorld(world));

    const engine = sandbox(attackState.id);
    for (let i = 0; i < 120; i += 1) engine.step(i === 0 ? attackIntent() : emptySample());

    const after = structuredClone(observeWorld(world));
    // Tick, positions, states and events: every observable, unchanged.
    expect(after).toEqual(before);
    expect(world.tick).toBe(30);
    // And the sandbox genuinely did run — otherwise this would pass vacuously.
    expect(engine.state.tick).toBe(120);
  });

  it('does not share a resolved document instance with a live runtime state', () => {
    const world = createWorldRuntime();
    const live = world.instance(CONTROLLED)!;
    const engine = sandbox(attackState.id);
    engine.step(emptySample());
    // The document may be shared (it is immutable); the *simulation* may not be.
    expect(engine).not.toBe(live.simulation);
    expect(live.simulation.state.tick).toBe(0);
  });
});

describe('sandbox determinism', () => {
  it('reproduces the same records from the same bootstrap and intent', () => {
    const run = (): unknown[] => {
      const engine = sandbox(attackState.id);
      const records: unknown[] = [];
      for (let i = 0; i < 90; i += 1) {
        records.push(engine.step(i === 0 || i === 45 ? attackIntent() : emptySample()));
      }
      return records;
    };
    // States, transitions, events, positions and normalized times all come
    // through the record, so comparing records compares all of them.
    expect(run()).toEqual(run());
  });

  it('a reset run matches the original rather than continuing it', () => {
    const first = sandbox(attackState.id);
    for (let i = 0; i < 40; i += 1) first.step(emptySample());
    const firstTail = first.step(emptySample());

    // "Reset" is a rebuild, which is the only reset that cannot half-work.
    const second = sandbox(attackState.id);
    for (let i = 0; i < 40; i += 1) second.step(emptySample());
    const secondTail = second.step(emptySample());

    expect(secondTail).toEqual(firstTail);
  });
});

describe('sandbox runtime authenticity', () => {
  it('executes the state clock, transitions and events from the real runtime', () => {
    const engine = sandbox(attackState.id);
    const records = [];
    for (let i = 0; i < 180; i += 1) records.push(engine.step(emptySample()));

    // The bootstrapped action state advanced under its own authored duration
    // and then left through the runtime's own completion policy — neither of
    // which a pose substitution does.
    expect(records[0]!.actionState).toBe(attackState.id);
    const left = records.find((record) => record.actionState !== attackState.id);
    expect(left, 'the bootstrapped action state never completed').toBeDefined();

    // Semantic events come from the clip data, through the graph, as they do
    // in the live world.
    const events = records.flatMap((record) => record.events);
    expect(events.length).toBeGreaterThan(0);
  });

  it('honours a different bootstrap start time', () => {
    const early = new Simulation({
      project: resolved,
      terrain: findTerrainPreset(resolved.defaultTerrainPresetId),
      seed: 1,
      initialPosition: { x: 0, y: 0, z: 0 },
      initialYawRad: 0,
      cameraYawRad: 0,
      bootstrap: { states: { action: attackState.id }, normalizedTime: 0 },
    });
    const late = new Simulation({
      project: resolved,
      terrain: findTerrainPreset(resolved.defaultTerrainPresetId),
      seed: 1,
      initialPosition: { x: 0, y: 0, z: 0 },
      initialYawRad: 0,
      cameraYawRad: 0,
      bootstrap: { states: { action: attackState.id }, normalizedTime: 0.75 },
    });
    expect(late.layerState('action')!.normalizedTime).toBeGreaterThan(
      early.layerState('action')!.normalizedTime,
    );
  });
});
