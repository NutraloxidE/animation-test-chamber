import type { ProjectDefinition, TerrainPreset, SemanticEventKind } from '@atc/schema';
import { FixedStepAccumulator } from '@atc/runtime-core';
import { BrowserInputSampler, emptyVirtualPad, type VirtualPadState } from '@atc/input-runtime';
import { findTerrainPreset } from '@atc/terrain-runtime';
import {
  ReplayRecorder,
  Simulation,
  frameAt,
  runReplay,
  type ReplayTrace,
  type TickRecord,
} from '@atc/replay-runtime';
import type { ReplayDefinition } from '@atc/schema';
import { HapticPlayer, detectCapability, readActiveGamepad } from '@atc/haptics-runtime';

export type PlaybackMode = 'live' | 'replay';

export interface EngineSnapshot {
  tick: number;
  position: { x: number; y: number; z: number };
  yawRad: number;
  grounded: boolean;
  terrainState: string;
  locomotionState: string;
  actionState: string;
  locomotionNormalizedTime: number;
  actionNormalizedTime: number;
  blendWeight: number;
  speed: number;
  mode: PlaybackMode;
  recording: boolean;
  replayProgress: number;
}

/**
 * Owns the live simulation and the render loop's relationship to it.
 *
 * Deliberately outside React: the simulation advances on a fixed timestep from
 * requestAnimationFrame deltas, and the 3D view reads it directly each frame.
 * React only sees a throttled snapshot, so dragging a slider never competes
 * with the simulation for frame budget.
 */
export class ChamberEngine {
  private simulation: Simulation;
  private readonly accumulator = new FixedStepAccumulator();
  private readonly sampler: BrowserInputSampler;
  private haptics: HapticPlayer;

  private project: ProjectDefinition;
  private terrain: TerrainPreset;

  private recorder: ReplayRecorder | null = null;
  private mode: PlaybackMode = 'live';
  private activeReplay: ReplayDefinition | null = null;
  private replayTick = 0;

  private cameraYaw = 0;
  private cameraPitch = 0.25;
  private timeScale = 1;
  private paused = false;
  private stepOnce = false;

  /** Latest tick record, read by the renderer every frame. */
  lastRecord: TickRecord | null = null;

  /** Ghost trace rendered alongside the live character for before/after. */
  ghostTrace: ReplayTrace | null = null;
  ghostTick = 0;

  private listeners = new Set<() => void>();

  constructor(project: ProjectDefinition) {
    this.project = project;
    this.terrain = findTerrainPreset(project.defaultTerrainPresetId);
    this.simulation = this.createSimulation();
    this.sampler = new BrowserInputSampler(project.inputMap);
    this.haptics = new HapticPlayer(project.haptics, detectCapability(readActiveGamepad()), () =>
      readActiveGamepad() as unknown as { id: string; vibrationActuator?: never } | null,
    );
  }

  private createSimulation(): Simulation {
    return new Simulation({
      project: this.project,
      terrain: this.terrain,
      seed: 1,
      initialPosition: { x: 0, y: 2, z: 0 },
      initialYawRad: 0,
      cameraYawRad: this.cameraYaw,
    });
  }

  attachInput(): void {
    this.sampler.attach();
  }

  detachInput(): void {
    this.sampler.detach();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  /** Applies edited canonical data to the running preview without a restart. */
  setProject(project: ProjectDefinition): void {
    this.project = project;
    this.simulation.updateProject(project);
    this.sampler.setInputMap(project.inputMap);
    this.haptics.setProfile(project.haptics);
  }

  /**
   * Switches terrain and returns the character to the spawn point.
   *
   * Without the reset, switching preset mid-run leaves the character wherever it
   * happened to be — which is frequently inside or under the new geometry, with
   * no way to recover. You switch preset to test that terrain, so starting at
   * its origin is also what you wanted.
   */
  setTerrainPreset(id: string): void {
    this.terrain = findTerrainPreset(id);
    this.simulation.setTerrain(this.terrain);
    this.reset();
  }

  get terrainPreset(): TerrainPreset {
    return this.terrain;
  }

  get currentProject(): ProjectDefinition {
    return this.project;
  }

  get simulationState() {
    return this.simulation.state;
  }

  get activeDevice(): string {
    return this.sampler.activeDevice;
  }

  setVirtualPad(state: VirtualPadState): void {
    this.sampler.setVirtualPad(state);
  }

  clearVirtualPad(): void {
    this.sampler.setVirtualPad(emptyVirtualPad());
  }

  setTimeScale(scale: number): void {
    this.timeScale = scale;
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  /** Advances exactly one simulation tick while paused. */
  frameStep(): void {
    this.stepOnce = true;
  }

  injectFrameDrop(count: number): void {
    this.accumulator.injectFrameDrop(count);
  }

  reset(): void {
    this.simulation = this.createSimulation();
    this.accumulator.reset();
    this.lastRecord = null;
    this.replayTick = 0;
    this.mode = 'live';
    this.notify();
  }

  startRecording(replayId: string): void {
    this.reset();
    this.recorder = new ReplayRecorder({
      id: replayId,
      label: `Recorded ${new Date().toLocaleTimeString()}`,
      revisionId: this.project.revisionId,
      seed: 1,
      terrainPresetId: this.terrain.id,
      initialPosition: { x: 0, y: 2, z: 0 },
      initialYawRad: 0,
      cameraYawRad: this.cameraYaw,
    });
    this.mode = 'live';
    this.notify();
  }

  stopRecording(): ReplayDefinition | null {
    if (!this.recorder) return null;
    const replay = this.recorder.finish();
    this.recorder = null;
    this.notify();
    return replay;
  }

  get isRecording(): boolean {
    return this.recorder !== null;
  }

  /** Plays a replay deterministically from tick 0. */
  playReplay(replay: ReplayDefinition): void {
    this.activeReplay = replay;
    this.replayTick = 0;
    this.mode = 'replay';
    this.terrain = findTerrainPreset(replay.terrainPresetId);
    this.cameraYaw = replay.cameraYawRad;
    this.simulation = new Simulation({
      project: this.project,
      terrain: this.terrain,
      seed: replay.seed,
      initialPosition: replay.initialPosition,
      initialYawRad: replay.initialYawRad,
      cameraYawRad: replay.cameraYawRad,
    });
    this.accumulator.reset();
    this.notify();
  }

  stopReplay(): void {
    this.mode = 'live';
    this.activeReplay = null;
    this.notify();
  }

  /** Runs a replay headlessly against a document, for comparison panels. */
  traceFor(document: ProjectDefinition, replay: ReplayDefinition): ReplayTrace {
    return runReplay(document, replay);
  }

  setGhost(trace: ReplayTrace | null): void {
    this.ghostTrace = trace;
    this.ghostTick = 0;
  }

  setCameraYaw(yaw: number): void {
    this.cameraYaw = yaw;
    this.simulation.setCameraYaw(yaw);
  }

  get camera(): { yaw: number; pitch: number } {
    return { yaw: this.cameraYaw, pitch: this.cameraPitch };
  }

  /**
   * Called once per rendered frame. Converts elapsed real time into whole
   * simulation ticks; the number of ticks varies with frame rate but the result
   * of each tick does not.
   */
  advance(deltaSec: number): void {
    if (this.paused && !this.stepOnce) {
      this.accumulator.reset();
      return;
    }

    let ticks: number;
    if (this.stepOnce) {
      ticks = 1;
      this.stepOnce = false;
    } else {
      ticks = this.accumulator.advance(deltaSec * this.timeScale);
    }

    for (let i = 0; i < ticks; i += 1) {
      this.runTick();
    }

    if (ticks > 0) this.notify();
  }

  private runTick(): void {
    const sample =
      this.mode === 'replay' && this.activeReplay
        ? frameAt(this.activeReplay, this.replayTick)
        : this.sampler.sample();

    if (this.mode === 'live') {
      // Camera look is applied before the tick so camera-relative movement uses
      // the same yaw the player is looking at this frame.
      this.cameraYaw -= sample.lookX;
      this.cameraPitch = Math.min(
        this.project.camera.maxPitchRad,
        Math.max(this.project.camera.minPitchRad, this.cameraPitch + sample.lookY),
      );
      this.simulation.setCameraYaw(this.cameraYaw);
    }

    this.recorder?.record(sample);

    const record = this.simulation.step(sample);
    this.lastRecord = record;

    for (const event of record.events) {
      this.haptics.trigger(event as SemanticEventKind);
    }

    if (this.mode === 'replay' && this.activeReplay) {
      this.replayTick += 1;
      if (this.replayTick >= this.activeReplay.tickCount) {
        // Loop the replay so before/after comparison keeps cycling.
        this.playReplay(this.activeReplay);
      }
    }

    if (this.ghostTrace) {
      this.ghostTick = (this.ghostTick + 1) % Math.max(1, this.ghostTrace.ticks.length);
    }
  }

  refreshHapticCapability(): void {
    this.haptics.setCapability(detectCapability(readActiveGamepad()));
  }

  get hapticPlayer(): HapticPlayer {
    return this.haptics;
  }

  snapshot(): EngineSnapshot {
    const state = this.simulation.state;
    const record = this.lastRecord;
    return {
      tick: state.tick,
      position: state.position,
      yawRad: state.yawRad,
      grounded: state.grounded,
      terrainState: state.terrain.state,
      locomotionState: record?.locomotionState ?? 'idle',
      actionState: record?.actionState ?? 'action-none',
      locomotionNormalizedTime: record?.locomotionNormalizedTime ?? 0,
      actionNormalizedTime: record?.actionNormalizedTime ?? 0,
      blendWeight: record?.blendWeight ?? 1,
      speed: Math.hypot(state.velocity.x, state.velocity.z),
      mode: this.mode,
      recording: this.recorder !== null,
      replayProgress:
        this.activeReplay && this.activeReplay.tickCount > 0
          ? this.replayTick / this.activeReplay.tickCount
          : 0,
    };
  }
}
