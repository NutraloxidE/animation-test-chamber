/**
 * State Sandbox — a separate, disposable runtime.
 *
 * Clip Preview answers "what does this clip look like". This answers the other
 * half, the one the old workspace's wording promised and its implementation
 * never attempted: what does the state machine actually *do* from here. Exit
 * times, cancel windows, buffered input, semantic events, recovery policy,
 * movement authority, root motion and the destination state after a transition
 * all execute, because this is the real `Simulation` running the real fixed
 * step — not a second state machine written to look like one.
 *
 * The isolation is structural rather than careful. This owns a `Simulation` it
 * constructed itself, from the target's *immutable* resolved document; it never
 * touches `WorldRuntime`, never holds a live instance, never shares an input
 * buffer, a layer state, an event queue or a root-motion accumulator, and
 * writes into its own tick list rather than the world trace. Stepping it a
 * hundred and twenty ticks cannot move the world by one.
 */
import type { Vec3 } from '@atc/schema';
import { FIXED_DT } from '@atc/runtime-core';
import { Simulation, defaultEquipped, type TickRecord } from '@atc/replay-runtime';
import { findTerrainPreset } from '@atc/terrain-runtime';
import { emptySample, type ActionSample } from '@atc/input-runtime';
import { ACTION_LAYER, LOCOMOTION_LAYER } from '@atc/animation-runtime';
import type { CharacterPose } from '../../three/characters/ProceduralCharacter.tsx';
import type { ResolvedAnimationTarget } from '../target/resolve-animation-target.ts';

export interface SandboxBootstrap {
  locomotionStateId?: string;
  actionStateId?: string;
  normalizedTime?: number;
}

export interface SandboxObservation {
  tick: number;
  locomotionState: string;
  actionState: string;
  locomotionNormalizedTime: number;
  actionNormalizedTime: number;
  position: Vec3;
  yawRad: number;
  /** Straight-line distance from the sandbox origin. Root motion, visibly. */
  rootDisplacement: number;
  lastTransition: string | null;
  events: string[];
}

export interface SandboxTickRecord {
  tick: number;
  record: TickRecord;
  transitions: string[];
}

/** The neutral intent. A sandbox with no input still runs the real rules. */
export function neutralSample(): ActionSample {
  return emptySample();
}

export interface SandboxOptions {
  target: ResolvedAnimationTarget;
  terrainPresetId: string;
  bootstrap: SandboxBootstrap;
}

export class AnimationSandboxEngine {
  readonly target: ResolvedAnimationTarget;
  private options: SandboxOptions;
  private simulation: Simulation;
  private records: SandboxTickRecord[] = [];
  private lastTransition: string | null = null;
  private origin: Vec3;

  constructor(options: SandboxOptions) {
    this.options = options;
    this.target = options.target;
    // The sandbox always starts at the origin of its own space. It is not
    // standing anywhere in the world, and giving it the instance's authored
    // position would invite exactly the reading — "the sandbox moved my
    // character" — that the display modes exist to prevent.
    this.origin = { x: 0, y: 0, z: 0 };
    this.simulation = this.build(options);
  }

  private build(options: SandboxOptions): Simulation {
    const project = options.target.resolvedProject;
    const states: Record<string, string> = {};
    // Ids are validated by `bootstrapState`, but filtering unknown ones here
    // keeps a stale UI selection from throwing on every rebuild.
    const known = new Set(project.graph.states.map((state) => state.id));
    if (options.bootstrap.locomotionStateId && known.has(options.bootstrap.locomotionStateId)) {
      states[LOCOMOTION_LAYER] = options.bootstrap.locomotionStateId;
    }
    if (options.bootstrap.actionStateId && known.has(options.bootstrap.actionStateId)) {
      states[ACTION_LAYER] = options.bootstrap.actionStateId;
    }

    return new Simulation({
      project,
      terrain: findTerrainPreset(options.terrainPresetId),
      // A fixed seed rather than a per-instance one: the sandbox's whole claim
      // is that the same bootstrap and the same per-tick intent reproduce the
      // same records, and a seed derived from anything else would make that
      // depend on which instance happened to be selected.
      seed: 1,
      initialPosition: { ...this.origin },
      initialYawRad: 0,
      cameraYawRad: 0,
      weaponModeId: options.target.effectiveWeaponModeId,
      equipped: { ...defaultEquipped(project), ...options.target.effectiveEquipment },
      bootstrap: {
        states,
        normalizedTime: options.bootstrap.normalizedTime ?? 0,
      },
    });
  }

  /** Rebuilds from scratch. There is no partial reset and no carried state. */
  reset(bootstrap: SandboxBootstrap = this.options.bootstrap): void {
    this.options = { ...this.options, bootstrap };
    this.records = [];
    this.lastTransition = null;
    this.simulation = this.build(this.options);
  }

  /** Exactly one fixed step of the real runtime. */
  step(intent: ActionSample = neutralSample()): SandboxTickRecord {
    const before = {
      locomotion: this.simulation.layerState(LOCOMOTION_LAYER)?.stateId,
      action: this.simulation.layerState(ACTION_LAYER)?.stateId,
    };
    const record = this.simulation.step(intent);
    const transitions: string[] = [];
    const after = {
      locomotion: this.simulation.layerState(LOCOMOTION_LAYER)?.stateId,
      action: this.simulation.layerState(ACTION_LAYER)?.stateId,
    };
    if (after.locomotion !== before.locomotion) {
      transitions.push(`${LOCOMOTION_LAYER}: ${before.locomotion} → ${after.locomotion}`);
    }
    if (after.action !== before.action) {
      transitions.push(`${ACTION_LAYER}: ${before.action} → ${after.action}`);
    }
    if (transitions.length > 0) this.lastTransition = transitions[transitions.length - 1]!;

    const entry: SandboxTickRecord = { tick: record.tick, record, transitions };
    this.records.push(entry);
    // The sandbox's trace is its own list. Nothing here reaches the world trace,
    // which is what keeps a sandbox run out of the hash replay is compared on.
    if (this.records.length > MAX_SANDBOX_RECORDS) this.records.shift();
    return entry;
  }

  /** Whole fixed steps from a render delta, with one intent held across them. */
  advance(deltaSec: number, intent: ActionSample = neutralSample()): void {
    if (!Number.isFinite(deltaSec) || deltaSec <= 0) return;
    this.accumulator += deltaSec;
    let guard = 0;
    while (this.accumulator >= FIXED_DT && guard < MAX_STEPS_PER_ADVANCE) {
      this.accumulator -= FIXED_DT;
      this.step(intent);
      guard += 1;
    }
    // A tab that was backgrounded for a minute must not try to catch up with
    // 3,600 ticks in one frame; the sandbox is an inspection tool, not a
    // simulation that owes the wall clock anything.
    if (guard >= MAX_STEPS_PER_ADVANCE) this.accumulator = 0;
  }

  private accumulator = 0;

  pose(): CharacterPose {
    const state = this.simulation.state;
    const locomotion = this.simulation.layerState(LOCOMOTION_LAYER);
    const action = this.simulation.layerState(ACTION_LAYER);
    const last = this.records[this.records.length - 1]?.record;
    return {
      position: { ...state.position },
      yawRad: state.yawRad,
      locomotionState: locomotion?.stateId ?? 'idle',
      actionState: action?.stateId ?? 'action-none',
      locomotionNormalizedTime: locomotion?.normalizedTime ?? 0,
      actionNormalizedTime: action?.normalizedTime ?? 0,
      pelvisOffset: last?.pelvisOffset ?? 0,
    };
  }

  observation(): SandboxObservation {
    const state = this.simulation.state;
    const locomotion = this.simulation.layerState(LOCOMOTION_LAYER);
    const action = this.simulation.layerState(ACTION_LAYER);
    const last = this.records[this.records.length - 1];
    const dx = state.position.x - this.origin.x;
    const dz = state.position.z - this.origin.z;
    return {
      tick: state.tick,
      locomotionState: locomotion?.stateId ?? '—',
      actionState: action?.stateId ?? '—',
      locomotionNormalizedTime: locomotion?.normalizedTime ?? 0,
      actionNormalizedTime: action?.normalizedTime ?? 0,
      position: { ...state.position },
      yawRad: state.yawRad,
      rootDisplacement: Math.sqrt(dx * dx + dz * dz),
      lastTransition: this.lastTransition,
      events: last ? [...last.record.events] : [],
    };
  }

  /** Semantic events from the most recent tick, as the runtime emitted them. */
  events(): readonly string[] {
    return this.records[this.records.length - 1]?.record.events ?? [];
  }

  get tickRecords(): readonly SandboxTickRecord[] {
    return this.records;
  }

  get tick(): number {
    return this.simulation.state.tick;
  }
}

/** Enough history for the observation panel; not a replay buffer. */
const MAX_SANDBOX_RECORDS = 600;
const MAX_STEPS_PER_ADVANCE = 8;
