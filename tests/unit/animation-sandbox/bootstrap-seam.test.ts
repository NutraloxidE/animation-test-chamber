/**
 * The bootstrap seam, and the shape of the hole it is not.
 *
 * The State Sandbox has to begin in a chosen state. The obvious way to give it
 * that is a `forceState`/`setLayerState` on the running simulation — and that
 * would be reachable from `WorldRuntime`, from world commands, from the HTTP
 * capability surface and from replay playback, every one of which would then be
 * able to rewrite a tick record that replay determinism is measured against.
 *
 * So the seam is construction-only, and these tests assert that it *stays*
 * construction-only rather than that it merely is today.
 */
import { describe, expect, it } from 'vitest';
import { AnimationGraphRuntime, motionResolverFor } from '@atc/animation-runtime';
import { Simulation } from '@atc/replay-runtime';
import { findTerrainPreset } from '@atc/terrain-runtime';
import { emptySample } from '@atc/input-runtime';
import { loadResolvedDemoProject } from '../../fixtures/project.ts';

const project = loadResolvedDemoProject();

function graph(): AnimationGraphRuntime {
  return new AnimationGraphRuntime(project.graph, motionResolverFor(project), {});
}

function simulation(bootstrap?: Parameters<typeof buildInit>[0]): Simulation {
  return new Simulation(buildInit(bootstrap));
}

function buildInit(bootstrap?: { states: Record<string, string>; normalizedTime?: number }) {
  return {
    project,
    terrain: findTerrainPreset(project.defaultTerrainPresetId),
    seed: 1,
    initialPosition: { x: 0, y: 0, z: 0 },
    initialYawRad: 0,
    cameraYawRad: 0,
    ...(bootstrap ? { bootstrap } : {}),
  };
}

const anyActionState = project.graph.states.find((state) => state.layer === 'action')!;
const anyLocomotionState = project.graph.states.find(
  (state) => state.layer === 'locomotion' && state.id !== project.graph.layers.find((l) => l.id === 'locomotion')!.defaultState,
)!;

describe('graph bootstrap seam', () => {
  it('places a layer in a chosen state before the first tick', () => {
    const runtime = graph();
    runtime.bootstrapState('action', anyActionState.id, 0);
    expect(runtime.getLayer('action').stateId).toBe(anyActionState.id);
  });

  it('refuses once the graph has ticked', () => {
    const runtime = graph();
    runtime.tick(neutralParams());
    // This is the whole guarantee. A seam that stayed open would be a
    // force-state on a running simulation wearing a different name.
    expect(() => runtime.bootstrapState('action', anyActionState.id)).toThrow(
      /construction-only/,
    );
  });

  it('rejects a state that is not in this behaviour', () => {
    expect(() => graph().bootstrapState('action', 'not-a-real-state')).toThrow(/unknown state/);
  });

  it('rejects a state that belongs to another layer', () => {
    expect(() => graph().bootstrapState('action', anyLocomotionState.id)).toThrow(
      /belongs to layer/,
    );
  });

  it('clamps a non-finite or out-of-range start time', () => {
    const runtime = graph();
    runtime.bootstrapState('action', anyActionState.id, Number.NaN);
    expect(runtime.getLayer('action').normalizedTime).toBe(0);

    const other = graph();
    other.bootstrapState('action', anyActionState.id, 5);
    expect(other.getLayer('action').normalizedTime).toBe(1);
  });
});

describe('simulation bootstrap', () => {
  it('accepts a bootstrap only through construction', () => {
    const bootstrapped = simulation({ states: { action: anyActionState.id } });
    expect(bootstrapped.layerState('action')?.stateId).toBe(anyActionState.id);

    // There is no method to call. If one is ever added, this fails.
    const surface = bootstrapped as unknown as Record<string, unknown>;
    for (const forbidden of ['forceState', 'setLayerState', 'bootstrap', 'bootstrapState']) {
      expect(typeof surface[forbidden]).toBe('undefined');
    }
  });

  it('leaves an unbootstrapped simulation on its default states', () => {
    const plain = simulation();
    const defaults = Object.fromEntries(
      project.graph.layers.map((layer) => [layer.id, layer.defaultState]),
    );
    expect(plain.layerState('action')?.stateId).toBe(defaults.action);
    expect(plain.layerState('locomotion')?.stateId).toBe(defaults.locomotion);
  });

  it('runs the ordinary fixed step after bootstrapping', () => {
    const bootstrapped = simulation({ states: { action: anyActionState.id } });
    const record = bootstrapped.step(emptySample());
    // Nothing about the tick is special. The state advanced by real clip time
    // under the real rules, which is the difference between this and a pose
    // substitution.
    expect(record.tick).toBe(0);
    expect(record.actionNormalizedTime).toBeGreaterThan(0);
  });
});

function neutralParams() {
  return {
    getNumber: () => 0,
    getBoolean: () => false,
    getString: () => '',
    isBuffered: () => false,
    consumeBuffered: () => false,
  };
}
