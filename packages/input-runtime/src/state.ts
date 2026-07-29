import {
  ACTION_BIT,
  BUTTON_ACTIONS,
  type ButtonAction,
  type InputMapDefinition,
  type ReplayFrame,
} from '@atc/schema';
import { applyDeadzone, msToTicks } from '@atc/runtime-core';

/** Device-independent input for a single simulation tick. */
export interface ActionSample {
  moveX: number;
  moveY: number;
  lookX: number;
  lookY: number;
  buttons: Record<ButtonAction, boolean>;
}

export function emptyButtons(): Record<ButtonAction, boolean> {
  return Object.fromEntries(BUTTON_ACTIONS.map((a) => [a, false])) as Record<ButtonAction, boolean>;
}

export function emptySample(): ActionSample {
  return { moveX: 0, moveY: 0, lookX: 0, lookY: 0, buttons: emptyButtons() };
}

export function encodeButtons(buttons: Record<ButtonAction, boolean>): number {
  let mask = 0;
  for (const action of BUTTON_ACTIONS) {
    if (buttons[action]) mask |= ACTION_BIT[action];
  }
  return mask;
}

export function decodeButtons(mask: number): Record<ButtonAction, boolean> {
  const buttons = emptyButtons();
  for (const action of BUTTON_ACTIONS) {
    buttons[action] = (mask & ACTION_BIT[action]) !== 0;
  }
  return buttons;
}

export function frameToSample(frame: ReplayFrame): ActionSample {
  return {
    moveX: frame.moveX,
    moveY: frame.moveY,
    lookX: frame.lookX,
    lookY: frame.lookY,
    buttons: decodeButtons(frame.buttons),
  };
}

export function sampleToFrame(tick: number, sample: ActionSample): ReplayFrame {
  return {
    tick,
    moveX: sample.moveX,
    moveY: sample.moveY,
    lookX: sample.lookX,
    lookY: sample.lookY,
    buttons: encodeButtons(sample.buttons),
  };
}

interface ButtonRecord {
  down: boolean;
  pressedTick: number;
  releasedTick: number;
  /** Tick at which a buffered press was consumed; -1 when still eligible. */
  consumedTick: number;
}

/**
 * Tracks press/release/hold edges and per-action input buffering on the fixed
 * timestep. All windows are expressed in milliseconds in canonical data and
 * converted to ticks here, so buffering is frame-rate independent.
 */
export class InputState {
  private readonly records = new Map<ButtonAction, ButtonRecord>();
  private current: ActionSample = emptySample();
  private tick = 0;

  /** Last tick at which the character was grounded, for coyote time. */
  private lastGroundedTick = -1;

  constructor(private inputMap: InputMapDefinition) {
    for (const action of BUTTON_ACTIONS) {
      this.records.set(action, { down: false, pressedTick: -1, releasedTick: -1, consumedTick: -1 });
    }
  }

  setInputMap(inputMap: InputMapDefinition): void {
    this.inputMap = inputMap;
  }

  reset(): void {
    this.tick = 0;
    this.current = emptySample();
    this.lastGroundedTick = -1;
    for (const record of this.records.values()) {
      record.down = false;
      record.pressedTick = -1;
      record.releasedTick = -1;
      record.consumedTick = -1;
    }
  }

  /** Feeds one tick of input. Must be called exactly once per simulation tick. */
  beginTick(tick: number, sample: ActionSample): void {
    this.tick = tick;
    const move = applyDeadzone(sample.moveX, sample.moveY, this.inputMap.stickDeadzone);
    this.current = {
      moveX: move.x,
      moveY: move.y,
      lookX: sample.lookX,
      lookY: sample.lookY,
      buttons: sample.buttons,
    };

    for (const action of BUTTON_ACTIONS) {
      const record = this.records.get(action)!;
      const isDown = sample.buttons[action] === true;
      if (isDown && !record.down) {
        record.pressedTick = tick;
        // A fresh press re-arms the buffer even if a previous one was consumed.
        record.consumedTick = -1;
      } else if (!isDown && record.down) {
        record.releasedTick = tick;
      }
      record.down = isDown;
    }
  }

  markGrounded(grounded: boolean): void {
    if (grounded) this.lastGroundedTick = this.tick;
  }

  get moveX(): number {
    return this.current.moveX;
  }

  get moveY(): number {
    return this.current.moveY;
  }

  get lookX(): number {
    return this.current.lookX;
  }

  get lookY(): number {
    return this.current.lookY;
  }

  get moveMagnitude(): number {
    return Math.min(1, Math.hypot(this.current.moveX, this.current.moveY));
  }

  isDown(action: ButtonAction): boolean {
    return this.records.get(action)?.down ?? false;
  }

  justPressed(action: ButtonAction): boolean {
    return this.records.get(action)?.pressedTick === this.tick;
  }

  justReleased(action: ButtonAction): boolean {
    return this.records.get(action)?.releasedTick === this.tick;
  }

  heldTicks(action: ButtonAction): number {
    const record = this.records.get(action);
    if (!record || !record.down || record.pressedTick < 0) return 0;
    return this.tick - record.pressedTick;
  }

  /**
   * True when a press happened within `bufferMs` and has not been consumed.
   * Does not consume it — use `consumeBuffered` when the transition actually fires.
   */
  isBuffered(action: ButtonAction, bufferMs?: number): boolean {
    const record = this.records.get(action);
    if (!record || record.pressedTick < 0) return false;
    if (record.consumedTick >= 0) return false;
    const window = msToTicks(bufferMs ?? this.inputMap.defaultInputBufferMs);
    return this.tick - record.pressedTick <= window;
  }

  /** Consumes a buffered press so one input cannot trigger two transitions. */
  consumeBuffered(action: ButtonAction, bufferMs?: number): boolean {
    if (!this.isBuffered(action, bufferMs)) return false;
    const record = this.records.get(action)!;
    record.consumedTick = this.tick;
    return true;
  }

  /** Jump remains available briefly after leaving the ground (PLAN 6.3). */
  hasCoyoteTime(): boolean {
    if (this.lastGroundedTick < 0) return false;
    return this.tick - this.lastGroundedTick <= msToTicks(this.inputMap.coyoteTimeMs);
  }

  /** Jump pressed shortly before landing still fires on touchdown. */
  hasJumpBuffer(): boolean {
    return this.isBuffered('Jump', this.inputMap.jumpBufferMs);
  }

  consumeJumpBuffer(): boolean {
    return this.consumeBuffered('Jump', this.inputMap.jumpBufferMs);
  }

  snapshot(): ActionSample {
    return {
      moveX: this.current.moveX,
      moveY: this.current.moveY,
      lookX: this.current.lookX,
      lookY: this.current.lookY,
      buttons: { ...this.current.buttons },
    };
  }
}
