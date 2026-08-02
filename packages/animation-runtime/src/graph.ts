import type {
  AnimationClipDefinition,
  AnimationGraphDefinition,
  SemanticEventKind,
  StateDefinition,
  TransitionCondition,
  TransitionDefinition,
} from '@atc/schema';
import { FIXED_DT, clamp01 } from '@atc/runtime-core';
import { eventsInRange, isClipFinished, normalizedTimeOf } from './clip.ts';
import { slotForState, type AnimationContext, type MotionResolver } from './motion-resolver.ts';

/**
 * Layers are named by the behaviour asset, not by this union. The MVP still
 * ships exactly `locomotion` and `action`; what changed is that a behaviour
 * wanting a third no longer has to edit the runtime to get it.
 */
export type LayerId = string;

export const LOCOMOTION_LAYER = 'locomotion';
export const ACTION_LAYER = 'action';

/**
 * Fallback recovery point for an action clip that authored none. It is the old
 * dodge default, kept as a last resort behind the state's `recoveryPolicy`.
 */
export const DEFAULT_DODGE_RECOVERY_START_NORMALIZED = 0.78;
export const DODGE_RECOVERY_BLEND_SEC = 0.28;

/**
 * When this action hands the root back.
 *
 * This used to read `actionState.endsWith('-recovery') ? 0 : 0.78`. The rule
 * was right and the way it was selected was wrong: a character whose recovery
 * state happened to be called something else got the dodge default silently.
 * Precedence is unchanged — an authored clip value still wins over the state's
 * policy, which still wins over the global default.
 */
export function recoveryStartFor(
  state: StateDefinition | undefined,
  authored: number | undefined,
): number {
  if (authored !== undefined) return authored;
  return state?.recoveryPolicy?.authorityReturnAtNormalized ?? DEFAULT_DODGE_RECOVERY_START_NORMALIZED;
}

/**
 * True while an action is handing movement authority back to locomotion.
 *
 * Both halves were name checks: the action had to be `dodge` or `*-recovery`,
 * and locomotion had to be `walk` or `run`. Both are now declared.
 */
export function isDodgeRecoveryTransition(
  actionState: StateDefinition | undefined,
  actionNormalizedTime: number,
  locomotionState: StateDefinition | undefined,
  recoveryStartNormalized?: number,
): boolean {
  return (
    actionState?.movementAuthorityPolicy.returnsAuthorityOnRecovery === true &&
    actionNormalizedTime >= recoveryStartFor(actionState, recoveryStartNormalized) &&
    locomotionState?.movementAuthorityPolicy.providesLocomotionAuthority === true
  );
}

export function dodgeRecoveryBlendWeight(
  actionState: StateDefinition | undefined,
  actionNormalizedTime: number,
  actionDurationSec: number,
  locomotionState: StateDefinition | undefined,
  recoveryStartNormalized?: number,
): number {
  if (
    actionDurationSec <= 0 ||
    !isDodgeRecoveryTransition(
      actionState,
      actionNormalizedTime,
      locomotionState,
      recoveryStartNormalized,
    )
  ) {
    return 0;
  }
  const start = recoveryStartFor(actionState, recoveryStartNormalized);
  const blendSec = actionState?.recoveryPolicy?.blendDurationSec ?? DODGE_RECOVERY_BLEND_SEC;
  if (blendSec <= 0) return 1;
  return clamp01(((actionNormalizedTime - start) * actionDurationSec) / blendSec);
}

/** Values transition conditions are evaluated against. */
export interface ParameterSource {
  getNumber(name: string): number;
  getBoolean(name: string): boolean;
  getString(name: string): string;
  /** For the `buffered` operator: was this action pressed within the window. */
  isBuffered(action: string, bufferMs: number): boolean;
  consumeBuffered(action: string, bufferMs: number): boolean;
}

export interface LayerRuntimeState {
  stateId: string;
  /** Seconds spent in the current state, scaled by playback speed. */
  timeSec: number;
  normalizedTime: number;
  /** State being blended out of, if any. */
  previousStateId: string | null;
  previousNormalizedTime: number;
  blendElapsedSec: number;
  blendDurationSec: number;
  /** 1 = fully in the current state. */
  blendWeight: number;
  lastTransitionId: string | null;
  /** Extra speed multiplier contributed by the transition that entered this state. */
  playbackSpeed: number;
  /** Ticks spent sitting on the final frame under a `hold-final-frame` policy. */
  holdTicks: number;
}

/**
 * A layer that is not present in the behaviour's `layers` list.
 *
 * Returned instead of `undefined` so a panel written against locomotion/action
 * still renders when a behaviour names its layers differently, rather than
 * crashing the whole chamber over a missing key.
 */
export const EMPTY_LAYER_STATE: LayerRuntimeState = Object.freeze({
  stateId: '',
  timeSec: 0,
  normalizedTime: 0,
  previousStateId: null,
  previousNormalizedTime: 0,
  blendElapsedSec: 0,
  blendDurationSec: 0,
  blendWeight: 1,
  lastTransitionId: null,
  playbackSpeed: 1,
  holdTicks: 0,
});

export function layerStateOf(
  snapshot: Record<LayerId, LayerRuntimeState>,
  layerId: LayerId,
): LayerRuntimeState {
  return snapshot[layerId] ?? EMPTY_LAYER_STATE;
}

export interface FiredEvent {
  kind: SemanticEventKind;
  eventId: string;
  layer: LayerId;
  stateId: string;
  normalizedTime: number;
}

export interface GraphTickResult {
  events: FiredEvent[];
  /** Transitions that fired this tick, in the order they were applied. */
  transitions: { layer: LayerId; transitionId: string; from: string; to: string }[];
}

function compare(operator: TransitionCondition['operator'], left: number, right: number): boolean {
  switch (operator) {
    case 'greaterThan':
      return left > right;
    case 'lessThan':
      return left < right;
    case 'greaterOrEqual':
      return left >= right;
    case 'lessOrEqual':
      return left <= right;
    default:
      return false;
  }
}

/**
 * Two-layer animation graph (PLAN 7). Locomotion and Action each hold at most
 * one active state; the action layer composites on top and can suppress
 * locomotion movement through `actionMovementAuthority`.
 */
export class AnimationGraphRuntime {
  private readonly layers = new Map<LayerId, LayerRuntimeState>();
  private states = new Map<string, StateDefinition>();
  private transitionsByLayer = new Map<LayerId, TransitionDefinition[]>();
  private speedScales = new Map<LayerId, number>();

  constructor(
    private graph: AnimationGraphDefinition,
    private motion: MotionResolver,
    private context: AnimationContext = {},
  ) {
    this.rebuildIndex();
    this.reset();
  }

  /**
   * Swaps in edited canonical data without restarting the simulation, so a
   * slider drag is reflected in the live preview on the next tick.
   */
  updateGraph(
    graph: AnimationGraphDefinition,
    motion: MotionResolver,
    context: AnimationContext = this.context,
  ): void {
    this.graph = graph;
    this.motion = motion;
    this.context = context;
    this.rebuildIndex();
    // Keep playing whatever is active; fall back to the default if a state vanished.
    for (const layer of this.graph.layers) {
      const runtime = this.layers.get(layer.id);
      if (!runtime) continue;
      if (!this.states.has(runtime.stateId)) {
        this.enterState(layer.id, layer.defaultState, null, 0, 0, 1);
        continue;
      }
      // Playback speed is the product of the arriving transition's speed and
      // the state's, and it was baked in on entry. Re-derive it so editing
      // either one is visible in the state you are already standing in —
      // otherwise a speed slider does nothing until the state is re-entered.
      const state = this.states.get(runtime.stateId)!;
      const arrivedBy = runtime.lastTransitionId
        ? this.graph.transitions.find(
            (transition) => transition.id === runtime.lastTransitionId,
          )
        : undefined;
      runtime.playbackSpeed = (arrivedBy?.playbackSpeed ?? 1) * state.speed;
    }
  }

  private rebuildIndex(): void {
    this.states = new Map(this.graph.states.map((state) => [state.id, state]));
    this.transitionsByLayer = new Map();
    // Layer ids come from the behaviour asset. Iterating a hard-coded pair here
    // would have quietly dropped every transition on any third layer.
    for (const layerId of this.graph.layers.map((layer) => layer.id)) {
      const forLayer = this.graph.transitions.filter((transition) => {
        const target = this.states.get(transition.to);
        return target?.layer === layerId;
      });
      this.transitionsByLayer.set(layerId, this.sortTransitions(forLayer));
    }
  }

  /**
   * Deterministic ordering: forced-transition rank first (Death > Hit > Dodge
   * Cancel > Guard > Action > Locomotion), then explicit priority, then id.
   */
  private sortTransitions(transitions: TransitionDefinition[]): TransitionDefinition[] {
    const rankOf = (stateId: string): number => {
      const index = this.graph.forcedTransitionOrder.indexOf(stateId);
      return index === -1 ? this.graph.forcedTransitionOrder.length : index;
    };
    return [...transitions].sort((a, b) => {
      const rankDelta = rankOf(a.to) - rankOf(b.to);
      if (rankDelta !== 0) return rankDelta;
      if (a.priority !== b.priority) return b.priority - a.priority;
      return a.id.localeCompare(b.id);
    });
  }

  reset(): void {
    this.layers.clear();
    for (const layer of this.graph.layers) {
      this.enterState(layer.id, layer.defaultState, null, 0, 0, 1);
    }
  }

  /** Per-tick playback multiplier on top of the transition's authored speed. */
  setLayerSpeedScale(layerId: LayerId, scale: number): void {
    this.speedScales.set(layerId, scale);
  }

  /** Clip seconds this layer advances per fixed tick. */
  layerStepSec(layerId: LayerId): number {
    return FIXED_DT * this.getLayer(layerId).playbackSpeed * (this.speedScales.get(layerId) ?? 1);
  }

  getLayer(layerId: LayerId): LayerRuntimeState {
    const state = this.layers.get(layerId);
    if (!state) throw new Error(`layer "${layerId}" is not initialized`);
    return state;
  }

  getStateDefinition(stateId: string): StateDefinition | undefined {
    return this.states.get(stateId);
  }

  /**
   * The clip this state plays right now. The graph knows a slot; the motion
   * resolver knows which of the character's clips fills it.
   */
  getClipFor(stateId: string): AnimationClipDefinition | undefined {
    const state = this.states.get(stateId);
    if (!state) return undefined;
    return this.motion.resolve(slotForState(state, this.context), this.context);
  }

  /** The slot a state plays, for diagnostics and the library's slot table. */
  motionSlotFor(stateId: string): string | undefined {
    const state = this.states.get(stateId);
    return state ? slotForState(state, this.context) : undefined;
  }

  /** True when the action layer is doing something other than its default state. */
  isActionActive(): boolean {
    const layer = this.graph.layers.find((l) => l.id === 'action');
    if (!layer) return false;
    return this.getLayer('action').stateId !== layer.defaultState;
  }

  private enterState(
    layerId: LayerId,
    stateId: string,
    transition: TransitionDefinition | null,
    startOffsetNormalized: number,
    blendDurationSec: number,
    playbackSpeed: number,
  ): void {
    const previous = this.layers.get(layerId);
    const clip = this.getClipFor(stateId);
    const startTime = clip ? startOffsetNormalized * clip.durationSec : 0;

    this.layers.set(layerId, {
      stateId,
      timeSec: startTime,
      normalizedTime: startOffsetNormalized,
      previousStateId: previous ? previous.stateId : null,
      previousNormalizedTime: previous ? previous.normalizedTime : 0,
      blendElapsedSec: 0,
      blendDurationSec,
      blendWeight: blendDurationSec > 0 ? 0 : 1,
      lastTransitionId: transition ? transition.id : null,
      playbackSpeed,
      holdTicks: 0,
    });
  }

  private evaluateCondition(condition: TransitionCondition, params: ParameterSource): boolean {
    const { parameter, operator, value } = condition;

    if (operator === 'buffered') {
      // `value` carries the buffer window in milliseconds.
      return params.isBuffered(parameter, typeof value === 'number' ? value : 0);
    }
    if (operator === 'equals' || operator === 'notEquals') {
      let actual: number | boolean | string;
      if (typeof value === 'boolean') actual = params.getBoolean(parameter);
      else if (typeof value === 'number') actual = params.getNumber(parameter);
      else actual = params.getString(parameter);
      return operator === 'equals' ? actual === value : actual !== value;
    }
    if (typeof value !== 'number') return false;
    return compare(operator, params.getNumber(parameter), value);
  }

  private canFire(
    transition: TransitionDefinition,
    layer: LayerRuntimeState,
    params: ParameterSource,
  ): boolean {
    const sourceMatches = transition.from === '*' || transition.from === layer.stateId;
    if (!sourceMatches) return false;

    const target = this.states.get(transition.to);
    if (!target) return false;

    // Re-entry into the same state must be opted into explicitly.
    if (transition.to === layer.stateId && !target.allowReEntry) return false;

    const currentState = this.states.get(layer.stateId);
    const blending = layer.blendWeight < 1;

    // While a non-interruptible blend is running, nothing may cut in.
    if (blending && !transition.interruptible) return false;
    if (currentState && !currentState.interruptible && transition.from !== '*') {
      // A non-interruptible state cannot simply be cut short, but it can still
      // be left through a transition that declares *when* leaving is legal:
      // an exit time, or a cancel window. A cancel window on a non-interruptible
      // state is exactly how combo and dodge cancels are authored, so refusing
      // it here would make those windows dead data.
      if (transition.exitTimeNormalized === undefined && !transition.cancelWindow) return false;
    }

    if (
      transition.exitTimeNormalized !== undefined &&
      layer.normalizedTime < transition.exitTimeNormalized
    ) {
      return false;
    }

    if (transition.cancelWindow) {
      const { start, end } = transition.cancelWindow;
      if (layer.normalizedTime < start || layer.normalizedTime > end) return false;
    }

    return transition.conditions.every((condition) => this.evaluateCondition(condition, params));
  }

  /**
   * Advances one fixed tick. Layers are evaluated in `order`, so the action
   * layer sees the locomotion result from the same tick.
   */
  tick(params: ParameterSource): GraphTickResult {
    const result: GraphTickResult = { events: [], transitions: [] };
    const ordered = [...this.graph.layers].sort((a, b) => a.order - b.order);

    for (const layerDef of ordered) {
      const layerId = layerDef.id;
      const layer = this.getLayer(layerId);
      const candidates = this.transitionsByLayer.get(layerId) ?? [];

      const chosen = candidates.find((transition) => this.canFire(transition, layer, params));

      if (chosen) {
        // Consume the buffered input that satisfied this transition so a single
        // press cannot also trigger the next transition on a later tick.
        for (const condition of chosen.conditions) {
          if (condition.operator === 'buffered') {
            params.consumeBuffered(
              condition.parameter,
              typeof condition.value === 'number' ? condition.value : 0,
            );
          }
        }
        const target = this.states.get(chosen.to)!;
        this.enterState(
          layerId,
          chosen.to,
          chosen,
          chosen.startOffsetNormalized,
          chosen.blendDurationSec,
          chosen.playbackSpeed * target.speed,
        );
        result.transitions.push({
          layer: layerId,
          transitionId: chosen.id,
          from: layer.stateId,
          to: chosen.to,
        });
      }

      this.advanceLayer(layerId, result);
    }

    return result;
  }

  private advanceLayer(layerId: LayerId, result: GraphTickResult): void {
    const layer = this.getLayer(layerId);
    const state = this.states.get(layer.stateId);
    const clip = this.getClipFor(layer.stateId);
    if (!state || !clip) return;

    const previousNormalized = layer.normalizedTime;
    const finishedBeforeAdvance = isClipFinished(clip, layer.timeSec);
    layer.timeSec += this.layerStepSec(layerId);
    layer.normalizedTime = normalizedTimeOf(clip, layer.timeSec);

    for (const event of eventsInRange(clip, previousNormalized, layer.normalizedTime)) {
      result.events.push({
        kind: event.kind,
        eventId: event.id,
        layer: layerId,
        stateId: layer.stateId,
        normalizedTime: event.at,
      });
    }

    if (layer.blendDurationSec > 0 && layer.blendWeight < 1) {
      layer.blendElapsedSec += FIXED_DT;
      layer.blendWeight = clamp01(layer.blendElapsedSec / layer.blendDurationSec);
      if (layer.blendWeight >= 1) {
        layer.previousStateId = null;
      }
    } else {
      layer.blendWeight = 1;
      layer.previousStateId = null;
    }

    // State timeout and clip completion both fall through to the fallback state.
    const timedOut = state.timeoutSec > 0 && layer.timeSec >= state.timeoutSec;
    /*
     * `hold-final-frame` falls through one tick late, so the last frame of a
     * swing is rendered rather than swallowed by the fallback. This used to be
     * `stateId.startsWith('attack-')`, which meant the behaviour was a property
     * of the spelling: a second character whose combo states were named
     * differently lost its final frames with nothing to point at.
     *
     * `wait-for-transition` never falls through at all — only an authored
     * transition may leave it.
     */
    const policy = state.completionPolicy;
    const finished =
      policy.mode === 'wait-for-transition'
        ? false
        : policy.mode === 'hold-final-frame'
          ? finishedBeforeAdvance && layer.holdTicks >= policy.holdTicks
          : isClipFinished(clip, layer.timeSec);
    if (policy.mode === 'hold-final-frame' && finishedBeforeAdvance) {
      layer.holdTicks += 1;
    }
    const fallbackState = state.fallbackState;
    if (
      (timedOut || finished) &&
      fallbackState &&
      fallbackState !== layer.stateId
    ) {
      const fallback = this.states.get(fallbackState);
      if (fallback) {
        this.enterState(layerId, fallbackState, null, 0, 0.05, fallback.speed);
        result.transitions.push({
          layer: layerId,
          transitionId: `${state.id}:fallback`,
          from: state.id,
          to: fallbackState,
        });
      }
    }
  }

  /** Compact per-layer snapshot used by traces and the UI. */
  snapshot(): Record<LayerId, LayerRuntimeState> {
    return Object.fromEntries(
      this.graph.layers.map((layer) => [layer.id, { ...this.getLayer(layer.id) }]),
    );
  }
}
