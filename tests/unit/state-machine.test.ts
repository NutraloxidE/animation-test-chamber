import { describe, expect, it, beforeEach } from 'vitest';
import {
  AnimationGraphRuntime,
  dodgeRecoveryBlendWeight,
  resolveWeaponMode,
  type ParameterSource,
  clipIdForState,
  motionResolverFor,
} from '@atc/animation-runtime';
import { FIXED_DT } from '@atc/runtime-core';
import { Simulation, defaultEquipped } from '@atc/replay-runtime';
import { findTerrainPreset } from '@atc/terrain-runtime';
import { emptyButtons } from '@atc/input-runtime';
import { loadResolvedDemoProject } from '../fixtures/project.ts';
import { WEAPON_MODES } from '../../apps/web/src/three/catalog.ts';

const project = loadResolvedDemoProject();

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

/** State definitions by id, so the recovery helpers get the policy they read. */
const stateOf = (id: string) => project.graph.states.find((state) => state.id === id);

describe('graph initialisation', () => {
  it('blends dodge movement authority over the visual transition duration', () => {
    const duration = 1.4666667;
    const start = 0.72;
    const midpoint = start + 0.14 / duration;
    const endpoint = start + 0.28 / duration;

    expect(dodgeRecoveryBlendWeight(stateOf('dodge'), start, duration, stateOf('run'), start)).toBe(0);
    expect(dodgeRecoveryBlendWeight(stateOf('dodge'), midpoint, duration, stateOf('run'), start)).toBeCloseTo(
      0.5,
    );
    expect(dodgeRecoveryBlendWeight(stateOf('dodge'), endpoint, duration, stateOf('run'), start)).toBe(1);
    expect(dodgeRecoveryBlendWeight(stateOf('dodge'), endpoint, duration, stateOf('idle'), start)).toBe(0);
  });

  it('treats an attack recovery clip as recovery from its first frame', () => {
    const duration = 0.9666666;
    const midpoint = 0.14 / duration;

    expect(dodgeRecoveryBlendWeight(stateOf('attack-01-recovery'), 0, duration, stateOf('walk'))).toBe(0);
    expect(dodgeRecoveryBlendWeight(stateOf('attack-01-recovery'), midpoint, duration, stateOf('walk'))).toBeCloseTo(
      0.5,
    );
    expect(dodgeRecoveryBlendWeight(stateOf('attack-01-recovery'), 1, duration, stateOf('walk'))).toBe(1);
    // No stick input means no blend, so the recovery pose plays out in place.
    expect(dodgeRecoveryBlendWeight(stateOf('attack-01-recovery'), 1, duration, stateOf('idle'))).toBe(0);
    expect(dodgeRecoveryBlendWeight(stateOf('attack-01'), 0.9, 0.75, stateOf('walk'))).toBe(0);
  });

  it('scales locomotion clip time by the layer speed scale', () => {
    const graph = new AnimationGraphRuntime(project.graph, motionResolverFor(project));
    const params = makeParams({ numbers: { moveMagnitude: 0 } });

    graph.setLayerSpeedScale('locomotion', 0.5);
    expect(graph.layerStepSec('locomotion')).toBeCloseTo(FIXED_DT * 0.5);
    graph.tick(params);
    expect(graph.getLayer('locomotion').timeSec).toBeCloseTo(FIXED_DT * 0.5);

    graph.setLayerSpeedScale('locomotion', 1);
    graph.tick(params);
    expect(graph.getLayer('locomotion').timeSec).toBeCloseTo(FIXED_DT * 1.5);
    // Untouched layers keep their authored speed.
    expect(graph.layerStepSec('action')).toBeCloseTo(FIXED_DT);
  });

  it('starts each layer in its declared default state', () => {
    const graph = new AnimationGraphRuntime(project.graph, motionResolverFor(project));
    expect(graph.getLayer('locomotion').stateId).toBe('idle');
    expect(graph.getLayer('action').stateId).toBe('action-none');
  });
});

describe('transition conditions', () => {
  let graph: AnimationGraphRuntime;

  beforeEach(() => {
    graph = new AnimationGraphRuntime(project.graph, motionResolverFor(project));
  });

  it('fires when a numeric condition is satisfied', () => {
    graph.tick(makeParams({ numbers: { moveMagnitude: 0.3 }, booleans: { grounded: true } }));
    expect(graph.getLayer('locomotion').stateId).toBe('walk');
    // The inspector highlights whichever transition each layer arrived through.
    expect(graph.getLayer('locomotion').lastTransitionId).toBe('idle-to-walk');
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
    const graph = new AnimationGraphRuntime(project.graph, motionResolverFor(project));
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
    const graph = new AnimationGraphRuntime(project.graph, motionResolverFor(project));
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
    const graph = new AnimationGraphRuntime(project.graph, motionResolverFor(project));
    enterAttack(graph);
    // attack-01 is 0.75s; the window opens at 0.35 normalized (~0.26s).
    advance(graph, 0.1);
    graph.tick(makeParams({ buffered: { PrimaryAction: true } }));
    expect(graph.getLayer('action').stateId).toBe('attack-01');
  });

  it('allows a combo cancel inside the window', () => {
    const graph = new AnimationGraphRuntime(project.graph, motionResolverFor(project));
    enterAttack(graph);
    advance(graph, 0.4);
    graph.tick(makeParams({ buffered: { PrimaryAction: true } }));
    expect(graph.getLayer('action').stateId).toBe('attack-02');
  });

  it('refuses a combo cancel after the window closes', () => {
    const graph = new AnimationGraphRuntime(project.graph, motionResolverFor(project));
    enterAttack(graph);
    // Past 0.8 normalized (~0.6s) but before the clip ends.
    advance(graph, 0.63);
    graph.tick(makeParams({ buffered: { PrimaryAction: true } }));
    expect(graph.getLayer('action').stateId).toBe('attack-01');
  });

  it('allows a late dodge cancel in its own, later window', () => {
    const graph = new AnimationGraphRuntime(project.graph, motionResolverFor(project));
    enterAttack(graph);
    advance(graph, 0.45);
    graph.tick(makeParams({ buffered: { Dodge: true } }));
    expect(graph.getLayer('action').stateId).toBe('dodge');
  });

  /**
   * Every action reaches every other action directly. Without these links the
   * only route between two actions is "wait for the clip to end, fall back to
   * action-none, start the next one" — which is the delay that reads as
   * sluggish input.
   */
  it('goes from one action straight into another', () => {
    const graph = new AnimationGraphRuntime(project.graph, motionResolverFor(project));
    enterAttack(graph);
    advance(graph, 0.4);
    graph.tick(makeParams({ buffered: { PrimaryAction: true } }));
    expect(graph.getLayer('action').stateId).toBe('attack-02');

    // attack-02 is 0.85s; its dodge window opens at 0.45 normalized.
    advance(graph, 0.45);
    graph.tick(makeParams({ buffered: { Dodge: true } }));
    expect(graph.getLayer('action').stateId).toBe('dodge');

    // dodge is 1.4667s; attacking out of it is allowed from 0.72 normalized.
    advance(graph, 1.08);
    graph.tick(makeParams({ buffered: { PrimaryAction: true } }));
    expect(graph.getLayer('action').stateId).toBe('attack-01');
  });

  it('lets a jump break out of a dodge mid-roll', () => {
    const graph = new AnimationGraphRuntime(project.graph, motionResolverFor(project));
    graph.tick(makeParams({ buffered: { Dodge: true } }));
    expect(graph.getLayer('action').stateId).toBe('dodge');

    // dodge is 1.4667s; the jump window opens at 0.3 normalized (~0.44s), well
    // before the roll's own recovery at 0.72.
    advance(graph, 0.5);
    graph.tick(makeParams({ booleans: { jumpRequested: true } }));
    expect(graph.getLayer('action').stateId).toBe('action-none');

    // Root authority returns with the action layer, so the jump itself fires.
    graph.tick(
      makeParams({ booleans: { grounded: true }, buffered: { Jump: true } }),
    );
    expect(graph.getLayer('locomotion').stateId).toBe('jump');
  });

  it('leaves guard for another action without releasing guard first', () => {
    const graph = new AnimationGraphRuntime(project.graph, motionResolverFor(project));
    graph.tick(makeParams({ booleans: { guardHeld: true } }));
    expect(graph.getLayer('action').stateId).toBe('guard');

    graph.tick(makeParams({ booleans: { guardHeld: true }, buffered: { Dodge: true } }));
    expect(graph.getLayer('action').stateId).toBe('dodge');
  });
});

describe('state lifecycle', () => {
  it('falls back to the declared state when a one-shot clip finishes', () => {
    const graph = new AnimationGraphRuntime(project.graph, motionResolverFor(project));
    graph.tick(makeParams({ buffered: { PrimaryAction: true } }));
    expect(graph.getLayer('action').stateId).toBe('attack-01');

    for (let i = 0; i < Math.round(0.8 / FIXED_DT); i += 1) graph.tick(makeParams({}));
    expect(graph.getLayer('action').stateId).toBe('action-none');
  });

  it('refuses re-entry into a state that forbids it', () => {
    const graph = new AnimationGraphRuntime(project.graph, motionResolverFor(project));
    graph.tick(makeParams({ buffered: { PrimaryAction: true } }));
    const before = graph.getLayer('action').timeSec;
    // A second press on the very next tick must not restart attack-01.
    graph.tick(makeParams({ buffered: { PrimaryAction: true } }));
    expect(graph.getLayer('action').stateId).toBe('attack-01');
    expect(graph.getLayer('action').timeSec).toBeGreaterThan(before);
  });

  it('blends in over the transition duration rather than snapping', () => {
    const graph = new AnimationGraphRuntime(project.graph, motionResolverFor(project));
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
    const graph = new AnimationGraphRuntime(project.graph, motionResolverFor(project));
    let hits = 0;
    graph.tick(makeParams({ buffered: { PrimaryAction: true } }));
    for (let i = 0; i < Math.round(0.7 / FIXED_DT); i += 1) {
      const result = graph.tick(makeParams({}));
      hits += result.events.filter((event) => event.kind === 'AttackHit').length;
    }
    expect(hits).toBe(1);
  });

  it('emits looping clip events once per cycle', () => {
    const graph = new AnimationGraphRuntime(project.graph, motionResolverFor(project));
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
    const graph = new AnimationGraphRuntime(project.graph, motionResolverFor(project));
    graph.tick(makeParams({ numbers: { moveMagnitude: 1 } }));
    const stateBefore = graph.getLayer('locomotion').stateId;

    const edited = structuredClone(project);
    const transition = edited.graph.transitions.find((t) => t.id === 'idle-to-walk')!;
    transition.blendDurationSec = 0.02;

    graph.updateGraph(edited.graph, motionResolverFor(edited));
    expect(graph.getLayer('locomotion').stateId).toBe(stateBefore);
  });
});

describe('playback speed', () => {
  it('multiplies the state speed into the arriving transition speed', () => {
    const edited = structuredClone(project);
    edited.graph.states.find((s) => s.id === 'walk')!.speed = 2;

    const graph = new AnimationGraphRuntime(edited.graph, motionResolverFor(edited));
    const params = makeParams({ numbers: { moveMagnitude: 0.3 }, booleans: { grounded: true } });
    graph.tick(params);

    const walk = edited.graph.transitions.find((t) => t.id === 'idle-to-walk')!;
    expect(graph.getLayer('locomotion').stateId).toBe('walk');
    expect(graph.getLayer('locomotion').playbackSpeed).toBeCloseTo(walk.playbackSpeed * 2);
  });

  /**
   * The panel's speed slider edits the document and hot-swaps it in. Baking the
   * speed in at state entry made that a no-op until the state was re-entered,
   * which reads as a dead slider whenever you are standing in the state you are
   * tuning — the common case.
   */
  it('applies a speed edit to the state already playing', () => {
    const graph = new AnimationGraphRuntime(project.graph, motionResolverFor(project));
    const params = makeParams({ numbers: { moveMagnitude: 0.3 }, booleans: { grounded: true } });
    graph.tick(params);
    expect(graph.getLayer('locomotion').stateId).toBe('walk');

    const before = graph.getLayer('locomotion').playbackSpeed;
    const stepBefore = graph.layerStepSec('locomotion');

    const edited = structuredClone(project);
    edited.graph.states.find((s) => s.id === 'walk')!.speed *= 2;
    graph.updateGraph(edited.graph, motionResolverFor(edited));

    expect(graph.getLayer('locomotion').stateId).toBe('walk');
    expect(graph.getLayer('locomotion').playbackSpeed).toBeCloseTo(before * 2);
    expect(graph.layerStepSec('locomotion')).toBeCloseTo(stepBefore * 2);
  });

  it('leaves playback speed alone on an unrelated edit', () => {
    const graph = new AnimationGraphRuntime(project.graph, motionResolverFor(project));
    const params = makeParams({ numbers: { moveMagnitude: 0.3 }, booleans: { grounded: true } });
    graph.tick(params);
    const before = graph.getLayer('locomotion').playbackSpeed;

    const edited = structuredClone(project);
    edited.clips.find((c) => c.id === 'dodge')!.durationSec = 2;
    graph.updateGraph(edited.graph, motionResolverFor(edited));

    expect(graph.getLayer('locomotion').playbackSpeed).toBeCloseTo(before);
  });
});

describe('equipment', () => {
  const guardWith = (equippedShield: boolean): string => {
    const graph = new AnimationGraphRuntime(project.graph, motionResolverFor(project));
    const params = makeParams({
      numbers: { moveMagnitude: 0 },
      booleans: { guardHeld: true, grounded: true, equippedShield },
    });
    graph.tick(params);
    return graph.getLayer('action').stateId;
  };

  it('branches guard to the shield pose only while the shield is equipped', () => {
    expect(guardWith(false)).toBe('guard');
    expect(guardWith(true)).toBe('guard-shield');
  });

  /**
   * The two guard entries are separated by the condition alone, not by
   * priority. If one side ever loses its `equippedShield` condition both become
   * eligible on the same tick and which one wins is down to sort order.
   */
  it('keeps the two guard entries mutually exclusive', () => {
    for (const transition of project.graph.transitions) {
      if (transition.to !== 'guard' && transition.to !== 'guard-shield') continue;
      const condition = transition.conditions.find((c) => c.parameter === 'equippedShield');
      expect(condition, `${transition.id} must test equippedShield`).toBeDefined();
      expect(condition!.value).toBe(transition.to === 'guard-shield');
    }
  });

  it('leaves the shield guard through every route plain guard has', () => {
    const routesFrom = (stateId: string) =>
      project.graph.transitions
        .filter((t) => t.from === stateId)
        .map((t) => t.to)
        .sort();
    expect(routesFrom('guard-shield')).toEqual(routesFrom('guard'));
  });

  /**
   * End to end through the real simulation, which is where the parameter is
   * actually resolved: `equippedShield` is never named in the runtime, so this
   * only passes if the document's slot declaration is what answers the
   * condition.
   */
  it('resolves the declared parameter from equipment state, not from code', () => {
    const guardAfterEquipping = (equipShield: boolean): string => {
      const simulation = new Simulation({
        project,
        terrain: findTerrainPreset(project.defaultTerrainPresetId),
        seed: 1,
        initialPosition: { x: 0, y: 0, z: 0 },
        initialYawRad: 0,
        cameraYawRad: 0,
      });
      simulation.setEquipped('shield', equipShield);
      const guarding = {
        moveX: 0,
        moveY: 0,
        lookX: 0,
        lookY: 0,
        buttons: { ...emptyButtons(), Guard: true },
      };
      let record = simulation.step(guarding);
      for (let tick = 1; tick < 20 && record.actionState === 'action-none'; tick += 1) {
        record = simulation.step(guarding);
      }
      return record.actionState;
    };

    expect(guardAfterEquipping(false)).toBe('guard');
    expect(guardAfterEquipping(true)).toBe('guard-shield');
  });

  it('opens with every slot at its declared default', () => {
    expect(defaultEquipped(project)).toEqual({ shield: false });
  });
});

describe('weapon modes', () => {
  it('binds each attack state to its own weapon clip and hides the others', () => {
    const magic = resolveWeaponMode(project, 'magic');
    const sword = resolveWeaponMode(project, 'sword');

    // The state names one slot for every weapon; the motion set's contextual
    // bindings decide which clip fills it.
    expect(clipIdForState(magic, 'attack-01', 'magic')).toBe('magic-attack-01');
    expect(clipIdForState(sword, 'attack-01', 'sword')).toBe('sword-attack-01');
    expect(magic.clips.map((clip) => clip.id)).toContain('magic-attack-01');
    expect(magic.clips.map((clip) => clip.id)).not.toContain('sword-attack-01');
    // Shared, non-weapon clips survive for every mode.
    expect(magic.clips.map((clip) => clip.id)).toContain('dodge');
  });

  it('leaves the combo structure shared and per-weapon timing separate', () => {
    const magicClip = resolveWeaponMode(project, 'magic').clips.find(
      (clip) => clip.id === 'magic-attack-01',
    )!;
    const swordClip = resolveWeaponMode(project, 'sword').clips.find(
      (clip) => clip.id === 'sword-attack-01',
    )!;
    // A cast does not lunge; a sword swing does.
    expect(magicClip.rootDisplacement.z).toBe(0);
    expect(swordClip.rootDisplacement.z).toBeGreaterThan(0);

    const comboOf = (weapon: string) =>
      resolveWeaponMode(project, weapon).graph.transitions.find(
        (t) => t.id === 'attack-01-to-attack-02',
      )!;
    expect(comboOf('magic').to).toBe(comboOf('sword').to);
  });

  it('applies a transition timing override for one weapon only', () => {
    const edited = structuredClone(project);
    const combo = edited.graph.transitions.find((t) => t.id === 'attack-01-to-attack-02')!;
    const shared = combo.cancelWindow;
    combo.weaponOverrides = { magic: { cancelWindow: { start: 0.5, end: 0.9 } } };

    const windowOf = (weapon: string) =>
      resolveWeaponMode(edited, weapon).graph.transitions.find(
        (t) => t.id === 'attack-01-to-attack-02',
      )!.cancelWindow;
    expect(windowOf('magic')).toEqual({ start: 0.5, end: 0.9 });
    expect(windowOf('sword')).toEqual(shared);
  });

  /**
   * A mode with no contextual binding silently falls back to the slot's default
   * clip, so tuning its curve or displacement would edit another weapon's clip
   * with nothing on screen saying so. Every catalog mode needs its own.
   */
  it('gives every catalog weapon mode its own attack clips', () => {
    const attackStates = project.graph.states.filter((state) =>
      WEAPON_MODES.some(
        (mode) =>
          clipIdForState(project, state.id, mode.id) !== clipIdForState(project, state.id),
      ),
    );
    expect(attackStates.length).toBeGreaterThan(0);

    for (const state of attackStates) {
      const clipIds = WEAPON_MODES.map((mode) => clipIdForState(project, state.id, mode.id));
      expect(clipIds.filter(Boolean)).toHaveLength(WEAPON_MODES.length);
      expect(new Set(clipIds).size).toBe(WEAPON_MODES.length);
      for (const clipId of clipIds) {
        expect(project.clips.map((clip) => clip.id)).toContain(clipId);
      }
    }
  });
});
