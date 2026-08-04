/**
 * Character intent sources.
 *
 * Every `ControllableCharacter` is fed by exactly one of these, and they all
 * answer the same question — "what is this character's normalized intent on
 * tick N?" — so nothing downstream knows whether it is driving a keyboard, a
 * track, a recording, an AI channel, or nothing at all.
 *
 * That indifference is the whole point. A keyboard wired straight into the
 * state machine makes a scripted test of the same motion impossible to write,
 * and an AI that reaches for `playAnimation` is not controlling a character —
 * it is puppeteering a clip and skipping every transition rule, input window
 * and root-motion policy the character was tuned with.
 */
import type {
  ButtonAction,
  CharacterControllerBindingDefinition,
  IntentTrackDefinition,
  ReplayDefinition,
} from '@atc/schema';
import { BUTTON_ACTIONS } from '@atc/schema';
import { emptySample, type ActionSample } from '@atc/input-runtime';
import { frameAt } from '@atc/replay-runtime';

/**
 * The normalized per-tick intent.
 *
 * Deliberately the *existing* `ActionSample` rather than a new character-only
 * shape. A second intent type would need a conversion at every boundary, and
 * the first thing to rot would be the two definitions of what "Move" means.
 */
export type CharacterIntent = ActionSample;

export interface CharacterIntentSource {
  /**
   * What kind of source this is, for observation.
   *
   * A free string rather than the binding union: `ai` and `human` share one
   * injected implementation, and an observation that could not tell them apart
   * would make "did the AI do that?" unanswerable after the two were proven to
   * behave identically.
   */
  readonly kind: string;
  /** Intent for `tick`. Must be pure with respect to the tick number. */
  sample(tick: number): CharacterIntent;
  /** Per-source cursor state, surfaced for observation and snapshot hashing. */
  cursor(): number;
  reset(): void;
}

export function neutralIntent(): CharacterIntent {
  return emptySample();
}

/** A source that is always neutral. Used by `{ kind: 'none' }`. */
export class NeutralCharacterIntentSource implements CharacterIntentSource {
  readonly kind = 'none';
  sample(): CharacterIntent {
    return neutralIntent();
  }
  cursor(): number {
    return 0;
  }
  reset(): void {}
}

/**
 * A source fed from outside — a browser device sampler, a test injecting one
 * frame, or an AI channel producing normalized frames.
 *
 * The host polls the device *once* per frame and hands the result to exactly
 * the characters bound to that player index. Letting each character poll would
 * make "which character did that keypress reach?" a question about enumeration
 * order, and would put a browser API inside a package that has to run in Node.
 */
export class InjectedCharacterIntentSource implements CharacterIntentSource {
  readonly kind: string = 'human';
  private current: CharacterIntent = neutralIntent();
  private ticks = 0;

  constructor(readonly playerIndex: number) {}

  /** Called by the host before the character steps. */
  inject(intent: CharacterIntent): void {
    this.current = intent;
  }

  sample(): CharacterIntent {
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
 * An AI channel, injected exactly like a human device.
 *
 * The *same* mechanism on purpose: identical normalized frames from a human and
 * from an AI must produce identical behaviour, which is only checkable if there
 * is one code path to check. What differs is identity — `kind` and `channelId`
 * — so an observation can still name the side that produced a frame.
 */
export class AiInjectedCharacterIntentSource extends InjectedCharacterIntentSource {
  override readonly kind = 'ai';

  constructor(readonly channelId: string) {
    // Player index 0 is a placeholder: an AI channel is addressed by channelId,
    // and `injectHumanIntent(0, …)` must never reach it. `SceneRuntime` routes
    // on the source class, not on this number.
    super(0);
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
export class ScriptedTrackCharacterIntentSource implements CharacterIntentSource {
  readonly kind = 'script';
  private lastLocalTick = 0;

  /** Keyframes sorted once; sampling must not depend on authored order. */
  private readonly frames: IntentTrackDefinition['keyframes'];

  constructor(
    readonly track: IntentTrackDefinition,
    /** Scene tick at which this character's track begins. */
    readonly startTick = 0,
  ) {
    this.frames = [...track.keyframes].sort((a, b) => a.tick - b.tick);
  }

  /** Track-local tick for a scene tick, honouring `loop`. -1 = before start. */
  localTick(sceneTick: number): number {
    const elapsed = sceneTick - this.startTick;
    if (elapsed < 0) return -1;
    if (this.track.loop) return elapsed % this.track.durationTicks;
    return Math.min(elapsed, this.track.durationTicks - 1);
  }

  sample(tick: number): CharacterIntent {
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
export class ReplayCharacterIntentSource implements CharacterIntentSource {
  readonly kind = 'replay';
  private lastTick = 0;

  constructor(
    readonly replay: ReplayDefinition,
    readonly startTick = 0,
  ) {}

  sample(tick: number): CharacterIntent {
    const local = tick - this.startTick;
    this.lastTick = local;
    if (local < 0) return neutralIntent();
    // Frames are sparse — one is stored only when the input changed — so the
    // correct sample is the most recent frame at or before this tick. An exact
    // match would feed neutral input on every unrecorded tick, which is how a
    // replayed run would silently disagree with the run that recorded it.
    return frameAt(this.replay, local);
  }

  cursor(): number {
    return this.lastTick;
  }

  reset(): void {
    this.lastTick = 0;
  }
}

/**
 * The concrete source an authored controller binding asks for.
 *
 * A missing track or replay produces a neutral source rather than a throw: the
 * scene still has to open so a human can see which reference is broken, and a
 * runtime that refuses to construct leaves them with a stack trace instead of a
 * validation issue next to the field.
 */
export function buildCharacterIntentSource(
  binding: CharacterControllerBindingDefinition,
  tracks: ReadonlyMap<string, IntentTrackDefinition>,
  replays: ReadonlyMap<string, ReplayDefinition>,
): CharacterIntentSource {
  switch (binding.kind) {
    case 'human':
      return new InjectedCharacterIntentSource(binding.playerIndex);
    case 'ai':
      return new AiInjectedCharacterIntentSource(binding.channelId);
    case 'script': {
      const track = tracks.get(binding.trackId);
      return track
        ? new ScriptedTrackCharacterIntentSource(track)
        : new NeutralCharacterIntentSource();
    }
    case 'replay': {
      const replay = replays.get(binding.replayId);
      return replay ? new ReplayCharacterIntentSource(replay) : new NeutralCharacterIntentSource();
    }
    case 'none':
      return new NeutralCharacterIntentSource();
  }
}

/** The binding target an observation reports: player index, track, replay or channel. */
export function bindingLabel(binding: CharacterControllerBindingDefinition): string {
  switch (binding.kind) {
    case 'human':
      return `player:${binding.playerIndex}`;
    case 'script':
      return binding.trackId;
    case 'replay':
      return binding.replayId;
    case 'ai':
      return `channel:${binding.channelId}`;
    case 'none':
      return '';
  }
}
