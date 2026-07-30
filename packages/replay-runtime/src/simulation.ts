import type { AnimationClipDefinition, ButtonAction, ProjectDefinition, SemanticEventKind, TerrainPreset, TerrainState, Vec3 } from '@atc/schema';
import { FIXED_DT, addVec3, clamp01, createRandom, horizontalLength, moveTowards, quantize, rotateTowardsAngle, scaleVec3, vec3 } from '@atc/runtime-core';
import {
  AnimationGraphRuntime,
  DEFAULT_DODGE_RECOVERY_START_NORMALIZED,
  dodgeRecoveryBlendWeight,
  isFootPlanted,
  normalizedTimeOf,
  sampleRootMotion,
  type LayerId,
  type LayerRuntimeState,
  type ParameterSource,
} from '@atc/animation-runtime';
import { InputState, type ActionSample } from '@atc/input-runtime';
import { applyGroundSnap, createFootIkState, resolveTerrain, solveFootIk, type FootIkResult, type TerrainResolution } from '@atc/terrain-runtime';

/** How long a lock-queued jump survives after the root unlocks. */
const QUEUED_JUMP_GRACE_MS = 140;
const NEXT_ACTION_INPUTS = new Set<ButtonAction>([
  'PrimaryAction',
  'SecondaryAction',
  'Dodge',
  'Guard',
]);

export interface SimulationInit {
  project: ProjectDefinition;
  terrain: TerrainPreset;
  seed: number;
  initialPosition: Vec3;
  initialYawRad: number;
  cameraYawRad: number;
  upperBodyActionRootMotionEnabled?: boolean;
  actionRootMotionTracks?: Record<string, RootMotionTrack>;
  weaponModeId?: string;
}

export interface RootMotionTrack {
  times: number[];
  positions: Vec3[];
}

export interface TickRecord {
  tick: number;
  position: Vec3;
  velocity: Vec3;
  yawRad: number;
  grounded: boolean;
  terrainState: TerrainState;
  locomotionState: string;
  actionState: string;
  locomotionNormalizedTime: number;
  actionNormalizedTime: number;
  blendWeight: number;
  events: SemanticEventKind[];
  footSlidingDistance: number;
  penetration: number;
  floating: number;
  pelvisOffset: number;
}

export interface SimulationState {
  tick: number;
  timeSec: number;
  position: Vec3;
  velocity: Vec3;
  yawRad: number;
  cameraYawRad: number;
  grounded: boolean;
  terrain: TerrainResolution;
  footIk: FootIkResult | null;
  /** Cumulative displacement the clips asked for, for root-motion error metrics. */
  authoredRootDisplacement: number;
  actualDisplacement: number;
}

/**
 * The deterministic character simulation.
 *
 * Everything that affects behaviour comes from canonical data plus the input
 * sample for the tick — no wall-clock time, no Math.random, no renderer state.
 * That is what lets the same replay produce an identical trace at 30, 60 or
 * 120fps render rates and in a headless test.
 */
export class Simulation {
  private readonly graph: AnimationGraphRuntime;
  private readonly input: InputState;
  private readonly footIkState = createFootIkState();
  private readonly random: () => number;

  private project: ProjectDefinition;
  private terrain: TerrainPreset;

  private tickIndex = 0;
  private timeSec = 0;
  private position: Vec3;
  private velocity: Vec3 = vec3();
  private yawRad: number;
  private cameraYawRad: number;
  private wasGrounded = true;
  private lastTerrain: TerrainResolution;
  private lastFootIk: FootIkResult | null = null;
  private authoredRootDisplacement = 0;
  private actualDisplacement = 0;
  private upperBodyActionRootMotionEnabled: boolean;
  private actionRootMotionTracks: Record<string, RootMotionTrack>;
  private weaponModeId: string;

  /** Set for one tick when the graph enters a jump state, so the impulse fires once. */
  private pendingJumpImpulse = false;

  /** A jump pressed while the root was locked, held until the lock opens. */
  private queuedJump = false;
  private queuedJumpGraceTicks = 0;

  constructor(init: SimulationInit) {
    this.project = init.project;
    this.terrain = init.terrain;
    this.position = { ...init.initialPosition };
    this.yawRad = init.initialYawRad;
    this.cameraYawRad = init.cameraYawRad;
    this.upperBodyActionRootMotionEnabled = init.upperBodyActionRootMotionEnabled ?? false;
    this.actionRootMotionTracks = init.actionRootMotionTracks ?? {};
    this.weaponModeId = init.weaponModeId ?? 'unarmed';
    this.random = createRandom(init.seed);

    this.graph = new AnimationGraphRuntime(init.project.graph, init.project.clips);
    this.input = new InputState(init.project.inputMap);
    this.lastTerrain = resolveTerrain(this.terrain, this.project.terrain, {
      position: this.position,
      yawRad: this.yawRad,
      verticalVelocity: 0,
      horizontalSpeed: 0,
      wasGrounded: true,
      timeSec: 0,
    });
  }

  /**
   * Applies edited canonical data mid-session. Used by the editor so a slider
   * drag shows up in the running preview without resetting the character.
   */
  updateProject(project: ProjectDefinition): void {
    this.project = project;
    this.graph.updateGraph(project.graph, project.clips);
    this.input.setInputMap(project.inputMap);
  }

  setTerrain(terrain: TerrainPreset): void {
    this.terrain = terrain;
  }

  setCameraYaw(yawRad: number): void {
    this.cameraYawRad = yawRad;
  }

  setUpperBodyActionRootMotionEnabled(enabled: boolean): void {
    this.upperBodyActionRootMotionEnabled = enabled;
  }

  setActionRootMotionTracks(tracks: Record<string, RootMotionTrack>): void {
    this.actionRootMotionTracks = tracks;
  }

  setWeaponModeId(id: string): void {
    this.weaponModeId = id;
  }

  get state(): SimulationState {
    return {
      tick: this.tickIndex,
      timeSec: this.timeSec,
      position: { ...this.position },
      velocity: { ...this.velocity },
      yawRad: this.yawRad,
      cameraYawRad: this.cameraYawRad,
      grounded: this.lastTerrain.grounded,
      terrain: this.lastTerrain,
      footIk: this.lastFootIk,
      authoredRootDisplacement: this.authoredRootDisplacement,
      actualDisplacement: this.actualDisplacement,
    };
  }

  get graphRuntime(): AnimationGraphRuntime {
    return this.graph;
  }

  private parameterSource(): ParameterSource {
    const input = this.input;
    const terrain = this.lastTerrain;
    const speed = horizontalLength(this.velocity);
    const graph = this.graph;

    return {
      getNumber: (name) => {
        switch (name) {
          case 'moveMagnitude':
            // A stationary action pins the character, so locomotion must see a
            // released stick and fall back to idle instead of walking in place.
            return this.actionIsStationary() ? 0 : input.moveMagnitude;
          case 'speed':
            return speed;
          case 'verticalVelocity':
            return this.velocity.y;
          case 'slopeRad':
            return terrain.slopeRad;
          case 'walkSpeed':
            return this.project.movement.walkSpeed;
          case 'runSpeed':
            return this.project.movement.runSpeed;
          default:
            return 0;
        }
      },
      getBoolean: (name) => {
        switch (name) {
          case 'grounded':
            return terrain.grounded;
          case 'airborne':
            return !terrain.grounded;
          case 'actionActive':
            return graph.isActionActive();
          case 'rootLocked':
            return this.rootLocked();
          case 'guardHeld':
            return input.isAcceptedDown('Guard');
          case 'jumpHeld':
            return input.isDown('Jump');
          case 'jumpRequested':
            return input.isDown('Jump') || input.isBuffered('Jump', 140) || this.queuedJump;
          case 'primaryActionPressed':
            return input.justPressed('PrimaryAction');
          case 'secondaryActionPressed':
            return input.justPressed('SecondaryAction');
          case 'dodgePressed':
            return input.justPressed('Dodge');
          case 'nearLedge':
            return terrain.nearLedge;
          case 'sliding':
            return terrain.state === 'Sliding';
          default:
            return false;
        }
      },
      getString: (name) => {
        switch (name) {
          case 'terrainState':
            return terrain.state;
          case 'surface':
            return terrain.surface.id;
          case 'weaponMode':
            return this.weaponModeId;
          default:
            return '';
        }
      },
      isBuffered: (action, bufferMs) =>
        (action === 'Jump' && this.queuedJump) ||
        input.isBuffered(action as Parameters<InputState['isBuffered']>[0], bufferMs),
      // The queued jump is deliberately not cleared on consume: locomotion is
      // evaluated first, and the action layer still needs to see the request on
      // the same tick to release the dodge.
      consumeBuffered: (action, bufferMs) =>
        input.consumeBuffered(action as Parameters<InputState['consumeBuffered']>[0], bufferMs) ||
        (action === 'Jump' && this.queuedJump),
    };
  }

  /** Advances exactly one fixed timestep and returns the trace record. */
  step(sample: ActionSample): TickRecord {
    this.input.beginTick(this.tickIndex, sample, (action) => this.acceptsActionPress(action));
    this.input.markGrounded(this.lastTerrain.grounded);

    this.updateQueuedJump();

    const previousLocomotion = this.graph.getLayer('locomotion').stateId;
    const graphResult = this.graph.tick(this.parameterSource());

    // A jump impulse is applied on the tick the locomotion layer enters a state
    // whose clip emits JumpTakeoff, so the height comes from canonical data.
    const locomotion = this.graph.getLayer('locomotion');
    if (locomotion.stateId !== previousLocomotion && this.stateTakesOff(locomotion.stateId)) {
      this.pendingJumpImpulse = true;
    }

    const previousPosition = { ...this.position };
    this.integrateMovement();
    this.resolveGrounding();

    const events = graphResult.events.map((event) => event.kind);
    // Terrain-driven events are not authored in clips; emit them here so the
    // haptics and hitbox tracks see one unified event stream.
    if (this.lastTerrain.landing !== 'none') events.push('Landing');

    this.lastFootIk = this.solveFeet();

    this.actualDisplacement += horizontalLength({
      x: this.position.x - previousPosition.x,
      y: 0,
      z: this.position.z - previousPosition.z,
    });

    const record: TickRecord = {
      tick: this.tickIndex,
      position: quantizeVec(this.position),
      velocity: quantizeVec(this.velocity),
      yawRad: quantize(this.yawRad),
      grounded: this.lastTerrain.grounded,
      terrainState: this.lastTerrain.state,
      locomotionState: locomotion.stateId,
      actionState: this.graph.getLayer('action').stateId,
      locomotionNormalizedTime: quantize(locomotion.normalizedTime, 4),
      actionNormalizedTime: quantize(this.graph.getLayer('action').normalizedTime, 4),
      blendWeight: quantize(locomotion.blendWeight, 4),
      events,
      footSlidingDistance: quantize((this.lastFootIk?.left.slidingDistance ?? 0) + (this.lastFootIk?.right.slidingDistance ?? 0), 6),
      penetration: quantize(this.lastTerrain.penetration, 6),
      floating: quantize(this.lastTerrain.floating, 6),
      pelvisOffset: quantize(this.lastFootIk?.pelvisOffset ?? 0, 6),
    };

    this.tickIndex += 1;
    this.timeSec += FIXED_DT;
    return record;
  }

  private acceptsActionPress(action: ButtonAction): boolean {
    if (!NEXT_ACTION_INPUTS.has(action) || !this.graph.isActionActive()) return true;
    const layer = this.graph.getLayer('action');
    const clip = this.graph.getClipFor(layer.stateId);
    return layer.normalizedTime >= (clip?.inputAcceptanceStartNormalized ?? 0);
  }

  private stateTakesOff(stateId: string): boolean {
    const clip = this.graph.getClipFor(stateId);
    return clip?.events.some((event) => event.kind === 'JumpTakeoff') ?? false;
  }

  private integrateMovement(): void {
    const movement = this.project.movement;
    const rootMotion = this.project.rootMotion;
    const terrain = this.lastTerrain;

    // Camera-relative stick vector. +Z is forward for the character (PLAN 3.2).
    const stickX = this.input.moveX;
    const stickY = this.input.moveY;
    const magnitude = this.input.moveMagnitude;

    let desiredX = stickX;
    let desiredZ = stickY;
    if (movement.cameraRelative) {
      const cos = Math.cos(this.cameraYawRad);
      const sin = Math.sin(this.cameraYawRad);
      desiredX = -stickX * cos + stickY * sin;
      desiredZ = stickX * sin + stickY * cos;
    }

    // Walking below the stick threshold, running above it.
    const targetSpeed = magnitude < 0.6 ? movement.walkSpeed * (magnitude / 0.6) : movement.runSpeed * magnitude;

    const action = this.graph.getLayer('action');
    const actionClip = this.graph.getClipFor(action.stateId);
    const recoveryWeight = dodgeRecoveryBlendWeight(
      action.stateId,
      action.normalizedTime,
      actionClip?.durationSec ?? 0,
      this.graph.getLayer('locomotion').stateId,
      actionClip?.recoveryTransitionStartNormalized,
    );
    const actionIsStationary = this.actionIsStationary();
    const actionIsAttack = this.actionIsAttack();

    // Match the visual crossfade: code-driven locomotion regains authority as
    // the dodge pose fades out instead of snapping on at clip completion.
    const actionScale = actionIsStationary || actionIsAttack
      ? 0
      : this.graph.isActionActive()
        ? movement.actionMovementAuthority +
          (1 - movement.actionMovementAuthority) * recoveryWeight
        : 1;
    const airScale = terrain.grounded ? 1 : movement.airControl;
    const surfaceScale = terrain.grounded ? terrain.accelerationScale : 1;

    const effectiveTarget = targetSpeed * terrain.speedScale * actionScale;

    const desiredVx = magnitude > 0 ? (desiredX / Math.max(magnitude, 1e-6)) * effectiveTarget : 0;
    const desiredVz = magnitude > 0 ? (desiredZ / Math.max(magnitude, 1e-6)) * effectiveTarget : 0;

    const accelerating = magnitude > 0;
    const rate = (accelerating ? movement.acceleration : movement.deceleration) * airScale * surfaceScale * FIXED_DT;

    if (
      actionIsStationary ||
      actionIsAttack ||
      (movement.stopBehavior === 'instant' && !accelerating && terrain.grounded)
    ) {
      this.velocity.x = 0;
      this.velocity.z = 0;
    } else {
      this.velocity.x = moveTowards(this.velocity.x, desiredVx, rate);
      this.velocity.z = moveTowards(this.velocity.z, desiredVz, rate);
    }

    // Facing follows the intended direction, not the current velocity, so the
    // character turns crisply even while sliding.
    const acceptsFacingInput =
      !actionIsAttack ||
      action.normalizedTime >= (actionClip?.inputAcceptanceStartNormalized ?? 0);
    if (magnitude > 0.01 && acceptsFacingInput) {
      const targetYaw = Math.atan2(desiredX, desiredZ);
      const authority = actionIsStationary ? 0 : this.graph.isActionActive() ? this.currentRotationAuthority() : 1;
      this.yawRad = rotateTowardsAngle(this.yawRad, targetYaw, movement.rotationSpeed * FIXED_DT * authority);
    }

    if (this.pendingJumpImpulse) {
      this.pendingJumpImpulse = false;
      // v = sqrt(2 g h) reproduces the authored jump height exactly.
      this.velocity.y = Math.sqrt(2 * movement.gravity * movement.jumpHeight);
    } else if (!terrain.grounded) {
      this.velocity.y -= movement.gravity * FIXED_DT;
    } else if (this.velocity.y < 0) {
      this.velocity.y = 0;
    }

    // Root motion contribution, blended against code-driven velocity by authority.
    const rootDelta = this.sampleRootMotionDelta(recoveryWeight);
    // Locomotion root motion is the other half of the same movement the code
    // path damps during an action; leaving it at full authority is what made
    // upper-body attacks keep gliding forward.
    const locomotionRootScale = this.actionOwnsRoot() ? 1 : actionScale;
    const horizontalAuthority =
      actionIsStationary || rootMotion.mode === 'InPlace'
        ? 0
        : rootMotion.horizontalAuthority * locomotionRootScale;
    const codeWeight = 1 - horizontalAuthority;

    let deltaX = this.velocity.x * FIXED_DT * codeWeight;
    let deltaZ = this.velocity.z * FIXED_DT * codeWeight;

    if (horizontalAuthority > 0) {
      // Authored displacement is in character space; rotate it into the world.
      const cos = Math.cos(this.yawRad);
      const sin = Math.sin(this.yawRad);
      const worldX = rootDelta.x * cos + rootDelta.z * sin;
      const worldZ = -rootDelta.x * sin + rootDelta.z * cos;
      deltaX += worldX * horizontalAuthority;
      deltaZ += worldZ * horizontalAuthority;
      this.authoredRootDisplacement += Math.hypot(worldX, worldZ) * horizontalAuthority;
    }

    const verticalAuthority = rootMotion.mode === 'InPlace' ? 0 : rootMotion.verticalAuthority;
    const deltaY = this.velocity.y * FIXED_DT * (1 - verticalAuthority) + rootDelta.y * verticalAuthority;

    const platform = terrain.platformVelocity;
    this.position = addVec3(this.position, {
      x: deltaX + platform.x * FIXED_DT,
      y: deltaY + platform.y * FIXED_DT,
      z: deltaZ + platform.z * FIXED_DT,
    });

    if (terrain.platformAngularVelocity !== 0) {
      this.yawRad += terrain.platformAngularVelocity * FIXED_DT;
    }

    // A wall blocks forward progress rather than letting the capsule pass through.
    if (terrain.againstWall && this.project.terrain.obstaclePushback > 0) {
      const forwardX = Math.sin(this.yawRad);
      const forwardZ = Math.cos(this.yawRad);
      const into = this.velocity.x * forwardX + this.velocity.z * forwardZ;
      if (into > 0) {
        const push = this.project.terrain.obstaclePushback;
        this.velocity.x -= forwardX * into * push;
        this.velocity.z -= forwardZ * into * push;
        this.position.x -= forwardX * into * FIXED_DT * push;
        this.position.z -= forwardZ * into * FIXED_DT * push;
      }
    }
  }

  /**
   * A clip authored as InPlace (guard, attack, hit, ...) must hold its ground and
   * its facing while it plays, regardless of stick input or the authority sliders.
   */
  private actionIsStationary(): boolean {
    if (!this.graph.isActionActive()) return false;
    return this.graph.getClipFor(this.graph.getLayer('action').stateId)?.rootMotionMode === 'InPlace';
  }

  private actionIsAttack(): boolean {
    if (!this.graph.isActionActive()) return false;
    return this.graph.getLayer('action').stateId.startsWith('attack-');
  }

  private currentRotationAuthority(): number {
    const layer = this.graph.getLayer('action');
    const transitionId = layer.lastTransitionId;
    const transition = this.project.graph.transitions.find((t) => t.id === transitionId);
    return transition?.rotationAuthority ?? this.project.rootMotion.rotationAuthority;
  }

  /**
   * A jump pressed during the root lock would otherwise expire inside it, since
   * the lock outlasts the 140ms input buffer. Latch it, then let it live a
   * buffer's worth of ticks past the unlock so the press fires on the way out.
   */
  private updateQueuedJump(): void {
    if (this.rootLocked()) {
      if (this.input.justPressed('Jump')) this.queuedJump = true;
      this.queuedJumpGraceTicks = 0;
      return;
    }
    if (!this.queuedJump) return;
    this.queuedJumpGraceTicks += 1;
    if (this.queuedJumpGraceTicks * FIXED_DT * 1000 > QUEUED_JUMP_GRACE_MS) {
      this.queuedJump = false;
      this.queuedJumpGraceTicks = 0;
    }
  }

  /**
   * True while a full-body action owns the root at 100% — before its recovery
   * window opens. Locomotion transitions that move the character (jump) must
   * stay out until the action starts handing authority back.
   */
  private rootLocked(): boolean {
    if (!this.actionOwnsRoot()) return false;
    const layer = this.graph.getLayer('action');
    const recoveryStart =
      this.graph.getClipFor(layer.stateId)?.recoveryTransitionStartNormalized ??
      DEFAULT_DODGE_RECOVERY_START_NORMALIZED;
    return layer.normalizedTime < recoveryStart;
  }

  /** Moving actions drive the root even when their pose mask is upper-body. */
  private actionOwnsRoot(): boolean {
    const stateId = this.graph.getLayer('action').stateId;
    if (!this.graph.isActionActive()) return false;
    const clip = this.graph.getClipFor(stateId);
    return (
      this.graph.getStateDefinition(stateId)?.bodyMask === 'full' ||
      (this.upperBodyActionRootMotionEnabled &&
        (clip?.rootMotionMode === 'RootMotion' || clip?.rootMotionMode === 'Hybrid'))
    );
  }

  private sampleRootMotionDelta(recoveryWeight: number): Vec3 {
    const action = this.graph.getLayer('action');
    const actionOwnsRoot = this.actionOwnsRoot();
    const locomotion = this.graph.getLayer('locomotion');
    const sampleLayer = (layer: LayerRuntimeState): Vec3 => {
      const clip = this.graph.getClipFor(layer.stateId);
      if (!clip) return vec3();
      // Re-sample the prior wall-clock instant through the same timing curve.
      // Subtracting a linear normalized delta would desync root movement from
      // a nonlinearly sampled pose.
      const previous = normalizedTimeOf(
        clip,
        layer.timeSec - FIXED_DT * layer.playbackSpeed,
      );
      const track = this.actionRootMotionTracks[layer.stateId];
      if (track) {
        return addVec3(
          sampleRootTrack(track, clip.rootDisplacement, layer.normalizedTime),
          scaleVec3(sampleRootTrack(track, clip.rootDisplacement, previous), -1),
        );
      }
      return sampleRootMotion(clip, previous, layer.normalizedTime);
    };

    if (!actionOwnsRoot) return sampleLayer(locomotion);
    if (recoveryWeight <= 0) return sampleLayer(action);
    return addVec3(
      scaleVec3(sampleLayer(action), 1 - recoveryWeight),
      scaleVec3(sampleLayer(locomotion), recoveryWeight),
    );
  }

  private resolveGrounding(): void {
    const resolution = resolveTerrain(this.terrain, this.project.terrain, {
      position: this.position,
      yawRad: this.yawRad,
      verticalVelocity: this.velocity.y,
      horizontalSpeed: horizontalLength(this.velocity),
      wasGrounded: this.wasGrounded,
      timeSec: this.timeSec,
    });

    if (resolution.grounded) {
      const descending = this.velocity.y <= 0;
      this.position.y = applyGroundSnap(this.project.terrain, this.position.y, resolution.groundHeight, descending);
      if (this.velocity.y < 0) this.velocity.y = 0;

      // Re-measure against the snapped position. resolveTerrain sees the
      // pre-snap position, so its penetration is the depth that was *about to
      // be corrected*; the number worth recording is the one that survives into
      // the frame the player actually sees.
      const residual = this.position.y - resolution.groundHeight;
      resolution.penetration = residual < 0 ? -residual : 0;
      resolution.floating = residual > 0 ? residual : 0;
    }

    this.wasGrounded = resolution.grounded;
    this.lastTerrain = resolution;
  }

  private solveFeet(): FootIkResult {
    const clip = this.graph.getClipFor(this.graph.getLayer('locomotion').stateId);
    const normalized = this.graph.getLayer('locomotion').normalizedTime;

    // Procedural foot placement: feet swing along the facing axis out of phase.
    // Real clips replace this once a GLB with skinned feet is registered.
    const stride = 0.35;
    const cos = Math.cos(this.yawRad);
    const sin = Math.sin(this.yawRad);
    const lateral = 0.12;
    const phase = normalized * Math.PI * 2;

    const footWorld = (side: -1 | 1, offset: number): Vec3 => {
      const localX = side * lateral;
      const localZ = offset;
      return {
        x: this.position.x + localX * cos + localZ * sin,
        y: this.position.y,
        z: this.position.z - localX * sin + localZ * cos,
      };
    };

    const leftOffset = Math.sin(phase) * stride;
    const rightOffset = Math.sin(phase + Math.PI) * stride;

    return solveFootIk(
      this.terrain,
      this.project.terrain,
      {
        originalPosition: footWorld(-1, leftOffset),
        planted: clip ? isFootPlanted(clip, normalized, 'left') : true,
      },
      {
        originalPosition: footWorld(1, rightOffset),
        planted: clip ? isFootPlanted(clip, normalized, 'right') : true,
      },
      this.timeSec,
      this.footIkState,
    );
  }

  /** Exposed so callers can seed deterministic variation without new RNG sources. */
  nextRandom(): number {
    return this.random();
  }

  layerState(layer: LayerId) {
    return this.graph.getLayer(layer);
  }

  clipFor(layer: LayerId): AnimationClipDefinition | undefined {
    return this.graph.getClipFor(this.graph.getLayer(layer).stateId);
  }
}

function sampleRootTrack(
  track: RootMotionTrack,
  displacementAdjustment: Vec3,
  normalizedTime: number,
): Vec3 {
  const time = Math.max(0, Math.min(normalizedTime, 1));
  const last = track.times.length - 1;
  if (last < 0 || track.positions.length !== track.times.length) return vec3();
  let position: Vec3;
  if (time <= track.times[0]!) {
    position = track.positions[0]!;
  } else if (time >= track.times[last]!) {
    position = track.positions[last]!;
  } else {
    const next = track.times.findIndex((at) => at >= time);
    const previous = next - 1;
    const span = track.times[next]! - track.times[previous]!;
    const alpha = span > 0 ? (time - track.times[previous]!) / span : 1;
    const from = track.positions[previous]!;
    const to = track.positions[next]!;
    position = {
      x: from.x + (to.x - from.x) * alpha,
      y: from.y + (to.y - from.y) * alpha,
      z: from.z + (to.z - from.z) * alpha,
    };
  }

  const total = track.positions[last]!;
  const adjusted = (value: number, sourceTotal: number, adjustment: number): number =>
    Math.abs(sourceTotal) > 1e-6
      ? value * ((sourceTotal + adjustment) / sourceTotal)
      : value + adjustment * time;
  return {
    x: adjusted(position.x, total.x, displacementAdjustment.x),
    y: adjusted(position.y, total.y, displacementAdjustment.y),
    z: adjusted(position.z, total.z, displacementAdjustment.z),
  };
}

function quantizeVec(v: Vec3): Vec3 {
  return { x: quantize(v.x), y: quantize(v.y), z: quantize(v.z) };
}

/** Scales a normalized clip contribution; kept for symmetry with Unity's adapter. */
export function scaleRootMotion(displacement: Vec3, weight: number): Vec3 {
  return scaleVec3(displacement, clamp01(weight));
}
