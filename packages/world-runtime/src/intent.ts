/**
 * Intent sources.
 *
 * Every instance is fed by exactly one of these, and they all answer the same
 * question — "what is this instance's normalized intent on tick N?" — so the
 * world tick loop has no idea whether it is driving a keyboard, a track, a
 * recording, or nothing at all. That is the whole point of the abstraction: a
 * keyboard that reached the state machine directly would make a scripted test
 * of the same motion impossible to write.
 */
import type { ButtonAction, IntentSourceDefinition, IntentTrackDefinition } from '@atc/schema';
import { BUTTON_ACTIONS } from '@atc/schema';
import { emptySample, frameToSample, type ActionSample } from '@atc/input-runtime';
import type { ReplayDefinition } from '@atc/schema';

/**
 * The normalized per-tick intent. Deliberately the *existing* `ActionSample`
 * rather than a new world-only shape: a second intent type would need a
 * conversion at every boundary, and the first thing to rot would be the two
 * definitions of what "Move" means.
 */
export type NormalizedIntent = ActionSample;

export interface IntentSource {
  readonly kind: IntentSourceDefinition['kind'];
  /** Intent for `tick`. Must be pure with respect to the tick number. */
  sample(tick: number): NormalizedIntent;
  /** Per-source cursor state, surfaced for observation and snapshot hashing. */
  cursor(): number;
  reset(): void;
}

export function neutralIntent(): NormalizedIntent {
  return emptySample();
}

/** A source that is always neutral. Used by `{ kind: 'none' }`. */
export class NeutralIntentSource implements IntentSource {
  readonly kind = 'none' as const;
  sample(): NormalizedIntent {
    return neutralIntent();
  }
  cursor(): number {
    return 0;
  }
  reset(): void {}
}

/**
 * A source fed from outside the world — the browser's device sampler, or a
 * test injecting one frame.
 *
 * The device is polled *once* per frame by the caller and the result handed to
 * exactly the instances bound to that player index. Letting each instance poll
 * would make "which instance did that keypress reach?" a question about
 * enumeration order.
 */
export class InjectedIntentSource implements IntentSource {
  readonly kind = 'local-input' as const;
  private current: NormalizedIntent = neutralIntent();
  private ticks = 0;

  constructor(readonly playerIndex: number) {}

  /** Called by the host before the world steps. */
  inject(intent: NormalizedIntent): void {
    this.current = intent;
  }

  sample(): NormalizedIntent {
    this.ticks += 1;
    return this.current;
  }

  cursor(): number {
    return this.ticks;
  }

  reset(): void {
    this.current = neutralIntent();
    this.ticks = 0;
  }
}

/**
 * Samples an authored track.
 *
 * Hold semantics (DECISION 0009): every field keeps the value of the latest
 * keyframe at or before the sampled tick. A button is therefore held down for
 * exactly the ticks between the keyframe that sets it true and the one that
 * sets it false, which makes a press edge a thing an author can point at in the
 * document rather than a thing they have to infer.
 */
export class ScriptedTrackIntentSource implements IntentSource {
  readonly kind = 'scripted-track' as const;
  private lastLocalTick = 0;

  /** Keyframes sorted once; sampling must not depend on authored order. */
  private readonly frames: IntentTrackDefinition['keyframes'];

  constructor(
    readonly track: IntentTrackDefinition,
    /** World tick at which this instance's track begins. */
    readonly startTick = 0,
  ) {
    this.frames = [...track.keyframes].sort((a, b) => a.tick - b.tick);
  }

  /** Track-local tick for a world tick, honouring `loop`. -1 = before start. */
  localTick(worldTick: number): number {
    const elapsed = worldTick - this.startTick;
    if (elapsed < 0) return -1;
    if (this.track.loop) return elapsed % this.track.durationTicks;
    return Math.min(elapsed, this.track.durationTicks - 1);
  }

  sample(tick: number): NormalizedIntent {
    const local = this.localTick(tick);
    this.lastLocalTick = local;
    if (local < 0) return neutralIntent();

    const intent = neutralIntent();
    for (const frame of this.frames) {
      if (frame.tick > local) break;
      if (frame.move) {
        intent.moveX = frame.move.x;
        intent.moveY = frame.move.y;
      }
      if (frame.look) {
        intent.lookX = frame.look.x;
        intent.lookY = frame.look.y;
      }
      for (const action of BUTTON_ACTIONS) {
        const value = frame.buttons?.[action as ButtonAction];
        if (value !== undefined) intent.buttons[action as ButtonAction] = value;
      }
    }
    return intent;
  }

  cursor(): number {
    return this.lastLocalTick;
  }

  reset(): void {
    this.lastLocalTick = 0;
  }
}

/**
 * Replays recorded *normalized* frames.
 *
 * Not synthesized DOM events: a replay that pushed fake keydowns would be
 * testing the browser's event plumbing, and would not run in Node at all.
 */
export class ReplayIntentSource implements IntentSource {
  readonly kind = 'replay' as const;
  private lastTick = 0;

  constructor(
    readonly replay: ReplayDefinition,
    readonly startTick = 0,
  ) {}

  sample(tick: number): NormalizedIntent {
    const local = tick - this.startTick;
    this.lastTick = local;
    if (local < 0) return neutralIntent();
    const frame = this.replay.frames.find((entry) => entry.tick === local);
    return frame ? frameToSample(frame) : neutralIntent();
  }

  cursor(): number {
    return this.lastTick;
  }

  reset(): void {
    this.lastTick = 0;
  }
}
