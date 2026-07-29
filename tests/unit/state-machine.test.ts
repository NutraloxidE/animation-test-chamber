import { describe, expect, it, beforeEach } from 'vitest';
import {
  AnimationGraphRuntime,
  dodgeRecoveryBlendWeight,
  type ParameterSource,
} from '@atc/animation-runtime';
import { FIXED_DT } from '@atc/runtime-core';
import { loadDemoProject } from '../fixtures/project.ts';

const project = loadDemoProject();

/** Controllable parameter source so each test states exactly what is true. */
function makeParams(overrides: {
  numbers?: Record<string, number>;
  booleans?: Record<string, boolean>;
  strings?: Record<string, string>;
  buffered?: Record<string, boolean>;
}): ParameterSource & { consumed: string[] } {
  const consumed: string[] = [];
  return {
    consumed,
    getNumber: (name) => overrides.numbers?.[name] ?? 0,
    getBoolean: (name) => overrides.booleans?.[name] ?? false,
    getString: (name) => overrides.strings?.[name] ?? '',
    isBuffered: (action) => overrides.buffered?.[action] ?? false,
    consumeBuffered: (action) => {
      if (overrides.buffered?.[action]) {
        consumed.push(action);
        overrides.buffered[action] = false;
        return true;
      }
      return false;
    },
  };
}

describe('graph initialisation', () => {
  it('blends dodge movement authority over the visual transition duration', () => {
    const duration = 1.4666667;
    const midpoint = 0.78 + 0.14 / duration;
    const endpoint = 0.78 + 0.28 / duration;

    expect(dodgeRecoveryBlendWeight('dodge', 0.78, duration, 'run')).toBe(0);
    expect(dodgeRecoveryBlendWeight('dodge', midpoint, duration, 'run')).toBeCloseTo(0.5);
    expect(dodgeRecoveryBlendWeight('dodge', endpoint, duration, 'run')).toBe(1);
    expect(dodgeRecoveryBlendWeight('dodge', endpoint, duration, 'idle')).toBe(0);
  });

  it('starts each layer in its declared default state', () => {
    const graph = new AnimationGraphRuntime(project.graph, project.clips);
    expect(graph.getLayer('locomotion').stateId).toBe('idle');
    expect(graph.getLayer('action').stateId).toBe('action-none');
  });
});

describe('transition conditions', () => {
  let graph: AnimationGraphRuntime;

  beforeEach(() => {
    graph = new AnimationGraphRuntime(project.graph, project.clips);
  });

  it('fires when a numeric condition is satisfied', () => {
    graph.tick(makeParams({ numbers: { moveMagnitude: 0.3 }, booleans: { grounded: true } }));
    expect(graph.getLayer('locomotion').stateId).toBe('walk');
  });

  it('does not fire when the condition is not satisfied', () => {
    graph.tick(makeParams({ numbers: { moveMagnitude: 0 }, booleans: { grounded: true } }));
    expect(graph.getLayer('locomotion').stateId).toBe('idle');
  });

  it('evaluates a string equality condition', () => {
    graph.tick(
      makeParams({ booleans: { grounded: true }, strings: { terrainState: 'Sliding' } }),
    );
    expect(graph.getLayer('locomotion').stateId).toBe('slide');
  });
});

describe('priority and forced ordering', () => {
  it('prefers jump over fall when both are eligible on the same tick', () => {
    const graph = new AnimationGraphRuntime(project.graph, project.clips);
    // Both any-to-jump (p200) and any-to-fall (p120) match; jump must win.
    graph.tick(
      makeParams({
        booleans: { grounded: true, airborne: true },
        buffered: { Jump: true },
      }),
    );
    expect(graph.getLayer('locomotion').stateId).toBe('jump');
  });

  it('consumes the buffered input that satisfied the transition', () => {
    const graph = new AnimationGraphRuntime(project.graph, project.clips);
    const params = makeParams({ booleans: { grounded: true }, buffered: { Jump: true } });
    graph.tick(params);
    expect(params.consumed).toContain('Jump');
  });
});

describe('cancel windows', () => {
  function enterAttack(graph: AnimationGraphRuntime): void {
    graph.tick(makeParams({ buffered: { PrimaryAction: true } }));
    expect(graph.getLayer('action').stateId).toBe('attack-01');
  }

  function advance(graph: AnimationGraphRuntime, seconds: number): void {
    const ticks = Math.round(seconds / FIXED_DT);
    for (let i = 0; i < ticks; i += 1) graph.tick(makeParams({}));
  }

  it('refuses a combo cancel before the window opens', () => {
    const graph = new AnimationGraphRuntime(project.graph, project.clips);
    enterAttack(graph);
    // attack-01 is 0.75s; the window opens at 0.35 normalized (~0.26s).
    advance(graph, 0.1);
    graph.tick(makeParams({ buffered: { PrimaryAction: true } }));
    expect(graph.getLayer('action').stateId).toBe('attack-01');
  });

  it('allows a combo cancel inside the window', () => {
    const graph = new AnimationGraphRuntime(project.graph, project.clips);
    enterAttack(graph);
    advance(graph, 0.4);
    graph.tick(makeParams({ buffered: { PrimaryAction: true } }));
    expect(graph.getLayer('action').stateId).toBe('attack-02');
  });

  it('refuses a combo cancel after the window closes', () => {
    const graph = new AnimationGraphRuntime(project.graph, project.clips);
    enterAttack(graph);
    // Past 0.8 normalized (~0.6s) but before the clip ends.
    advance(graph, 0.63);
    graph.tick(makeParams({ buffered: { PrimaryAction: true } }));
    expect(graph.getLayer('action').stateId).toBe('attack-01');
  });

  it('allows a late dodge cancel in its own, later window', () => {
    const graph = new AnimationGraphRuntime(project.graph, project.clips);
    enterAttack(graph);
    advance(graph, 0.45);
    graph.tick(makeParams({ buffered: { Dodge: true } }));
    expect(graph.getLayer('action').stateId).toBe('dodge');
  });
});

describe('state lifecycle', () => {
  it('falls back to the declared state when a one-shot clip finishes', () => {
    const graph = new AnimationGraphRuntime(project.graph, project.clips);
    graph.tick(makeParams({ buffered: { PrimaryAction: true } }));
    expect(graph.getLayer('action').stateId).toBe('attack-01');

    for (let i = 0; i < Math.round(0.8 / FIXED_DT); i += 1) graph.tick(makeParams({}));
    expect(graph.getLayer('action').stateId).toBe('action-none');
  });

  it('refuses re-entry into a state that forbids it', () => {
    const graph = new AnimationGraphRuntime(project.graph, project.clips);
    graph.tick(makeParams({ buffered: { PrimaryAction: true } }));
    const before = graph.getLayer('action').timeSec;
    // A second press on the very next tick must not restart attack-01.
    graph.tick(makeParams({ buffered: { PrimaryAction: true } }));
    expect(graph.getLayer('action').stateId).toBe('attack-01');
    expect(graph.getLayer('action').timeSec).toBeGreaterThan(before);
  });

  it('blends in over the transition duration rather than snapping', () => {
    const graph = new AnimationGraphRuntime(project.graph, project.clips);
    graph.tick(makeParams({ numbers: { moveMagnitude: 0.3 } }));
    const layer = graph.getLayer('locomotion');
    expect(layer.blendDurationSec).toBeCloseTo(0.18, 3);
    expect(layer.blendWeight).toBeLessThan(1);

    for (let i = 0; i < Math.round(0.18 / FIXED_DT) + 1; i += 1) {
      graph.tick(makeParams({ numbers: { moveMagnitude: 0.3 } }));
    }
    expect(graph.getLayer('locomotion').blendWeight).toBe(1);
  });
});

describe('semantic events', () => {
  it('emits a clip event exactly once per pass', () => {
    const graph = new AnimationGraphRuntime(project.graph, project.clips);
    let hits = 0;
    graph.tick(makeParams({ buffered: { PrimaryAction: true } }));
    for (let i = 0; i < Math.round(0.7 / FIXED_DT); i += 1) {
      const result = graph.tick(makeParams({}));
      hits += result.events.filter((event) => event.kind === 'AttackHit').length;
    }
    expect(hits).toBe(1);
  });

  it('emits looping clip events once per cycle', () => {
    const graph = new AnimationGraphRuntime(project.graph, project.clips);
    // run is a 0.7s looping clip with one FootContactLeft per cycle.
    for (let i = 0; i < 20; i += 1) graph.tick(makeParams({ numbers: { moveMagnitude: 1 } }));
    let contacts = 0;
    const twoCycles = Math.round(1.4 / FIXED_DT);
    for (let i = 0; i < twoCycles; i += 1) {
      const result = graph.tick(makeParams({ numbers: { moveMagnitude: 1 } }));
      contacts += result.events.filter((event) => event.kind === 'FootContactLeft').length;
    }
    expect(contacts).toBeGreaterThanOrEqual(1);
    expect(contacts).toBeLessThanOrEqual(3);
  });
});

describe('live graph updates', () => {
  it('keeps playing the current state when canonical data is swapped in', () => {
    const graph = new AnimationGraphRuntime(project.graph, project.clips);
    graph.tick(makeParams({ numbers: { moveMagnitude: 1 } }));
    const stateBefore = graph.getLayer('locomotion').stateId;

    const edited = structuredClone(project);
    const transition = edited.graph.transitions.find((t) => t.id === 'idle-to-walk')!;
    transition.blendDurationSec = 0.02;

    graph.updateGraph(edited.graph, edited.clips);
    expect(graph.getLayer('locomotion').stateId).toBe(stateBefore);
  });
});
