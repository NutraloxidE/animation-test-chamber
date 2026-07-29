import type { InputDeviceKind, InputMapDefinition, ButtonAction } from '@atc/schema';
import { BUTTON_ACTIONS } from '@atc/schema';
import { clamp } from '@atc/runtime-core';
import { emptyButtons, type ActionSample } from './state.ts';

/** Touch input injected by the on-screen pad; merged with physical devices. */
export interface VirtualPadState {
  moveX: number;
  moveY: number;
  lookX: number;
  lookY: number;
  buttons: Partial<Record<ButtonAction, boolean>>;
}

export type MouseLookMode = 'free' | 'drag';

export function emptyVirtualPad(): VirtualPadState {
  return { moveX: 0, moveY: 0, lookX: 0, lookY: 0, buttons: {} };
}

/**
 * Collects keyboard, mouse, Standard Gamepad and virtual-pad input and produces
 * one device-independent ActionSample per simulation tick. Nothing downstream
 * knows which device produced a value.
 */
export class BrowserInputSampler {
  private readonly pressedCodes = new Set<string>();

  /**
   * Codes that went down since the last sample, even if they are already back
   * up. Sampling only the current key state loses any tap shorter than one
   * simulation tick (~16ms) — which is exactly the kind of input a fighting or
   * action game must not drop. Latched codes report as pressed for exactly one
   * sample, so a fast tap always reaches the buffer.
   */
  private readonly latchedCodes = new Set<string>();
  private readonly latchedPadButtons = new Set<ButtonAction>();

  private mouseDeltaX = 0;
  private mouseDeltaY = 0;
  private mouseLookMode: MouseLookMode = 'free';
  private mouseDragging = false;
  private virtualPad: VirtualPadState = emptyVirtualPad();
  private lastDevice: InputDeviceKind = 'keyboard';
  private attached = false;

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    // Auto-repeat must not re-latch: it would look like a stream of new presses.
    if (!event.repeat) this.latchedCodes.add(event.code);
    this.pressedCodes.add(event.code);
    this.lastDevice = 'keyboard';
    // Space would otherwise scroll the page while jumping.
    if (event.code === 'Space') event.preventDefault();
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    this.pressedCodes.delete(event.code);
  };

  private readonly onMouseMove = (event: MouseEvent): void => {
    if (this.mouseLookMode === 'drag' && !this.mouseDragging) return;
    this.mouseDeltaX += event.movementX;
    this.mouseDeltaY += event.movementY;
    if (event.movementX !== 0 || event.movementY !== 0) this.lastDevice = 'mouse';
  };

  private readonly onMouseDown = (event: MouseEvent): void => {
    if (event.button === 0 && event.target instanceof HTMLCanvasElement) this.mouseDragging = true;
  };

  private readonly onMouseUp = (event: MouseEvent): void => {
    if (event.button === 0) this.mouseDragging = false;
  };

  private readonly onBlur = (): void => {
    // Without this, a key held while the tab loses focus stays down forever.
    this.pressedCodes.clear();
    this.latchedCodes.clear();
    this.mouseDragging = false;
  };

  constructor(private inputMap: InputMapDefinition) {}

  setInputMap(inputMap: InputMapDefinition): void {
    this.inputMap = inputMap;
  }

  attach(target: HTMLElement | Window = window): void {
    if (this.attached || typeof window === 'undefined') return;
    this.attached = true;
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    (target as HTMLElement).addEventListener('mousemove', this.onMouseMove as EventListener);
    window.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mouseup', this.onMouseUp);
  }

  detach(target: HTMLElement | Window = window): void {
    if (!this.attached || typeof window === 'undefined') return;
    this.attached = false;
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    (target as HTMLElement).removeEventListener('mousemove', this.onMouseMove as EventListener);
    window.removeEventListener('mousedown', this.onMouseDown);
    window.removeEventListener('mouseup', this.onMouseUp);
  }

  setMouseLookMode(mode: MouseLookMode): void {
    this.mouseLookMode = mode;
    this.mouseDragging = false;
    this.mouseDeltaX = 0;
    this.mouseDeltaY = 0;
  }

  setVirtualPad(state: VirtualPadState): void {
    // Latch touch buttons for the same reason as keys: a quick tap can land
    // entirely between two samples.
    for (const action of BUTTON_ACTIONS) {
      if (state.buttons[action]) this.latchedPadButtons.add(action);
    }
    this.virtualPad = state;
    const active =
      state.moveX !== 0 ||
      state.moveY !== 0 ||
      state.lookX !== 0 ||
      state.lookY !== 0 ||
      Object.values(state.buttons).some(Boolean);
    if (active) this.lastDevice = 'touch';
  }

  /** Drives the button-prompt style shown in the UI (PLAN 6.1). */
  get activeDevice(): InputDeviceKind {
    return this.lastDevice;
  }

  private isCodeDown(codes: string[]): boolean {
    return codes.some((code) => this.pressedCodes.has(code) || this.latchedCodes.has(code));
  }

  private readGamepad(): Gamepad | null {
    if (typeof navigator === 'undefined' || !navigator.getGamepads) return null;
    for (const pad of navigator.getGamepads()) {
      if (pad && pad.connected) return pad;
    }
    return null;
  }

  /** Consumes accumulated input and produces the sample for the current tick. */
  sample(): ActionSample {
    const buttons = emptyButtons();
    let moveX = 0;
    let moveY = 0;

    // Keyboard: WASD contributes a unit-square vector, normalized downstream.
    for (const binding of this.inputMap.keyboard) {
      if (binding.action === 'Move' || binding.action === 'Look') continue;
      if (this.isCodeDown(binding.codes)) {
        buttons[binding.action as ButtonAction] = true;
      }
    }
    if (this.isCodeDown(['KeyW', 'ArrowUp'])) moveY += 1;
    if (this.isCodeDown(['KeyS', 'ArrowDown'])) moveY -= 1;
    if (this.isCodeDown(['KeyD', 'ArrowRight'])) moveX += 1;
    if (this.isCodeDown(['KeyA', 'ArrowLeft'])) moveX -= 1;

    let lookX = this.mouseDeltaX * 0.002 * this.inputMap.lookSensitivity;
    let lookY = this.mouseDeltaY * 0.002 * this.inputMap.lookSensitivity;
    this.mouseDeltaX = 0;
    this.mouseDeltaY = 0;

    const pad = this.readGamepad();
    if (pad) {
      const axisX = pad.axes[0] ?? 0;
      const axisY = pad.axes[1] ?? 0;
      const lookAxisX = pad.axes[2] ?? 0;
      const lookAxisY = pad.axes[3] ?? 0;
      if (Math.abs(axisX) > 0.05 || Math.abs(axisY) > 0.05) {
        moveX += axisX;
        // Gamepad Y is inverted relative to our +forward convention.
        moveY += -axisY;
        this.lastDevice = 'gamepad';
      }
      if (Math.abs(lookAxisX) > 0.05 || Math.abs(lookAxisY) > 0.05) {
        lookX += lookAxisX * 0.04 * this.inputMap.lookSensitivity;
        lookY += lookAxisY * 0.04 * this.inputMap.lookSensitivity;
        this.lastDevice = 'gamepad';
      }
      for (const binding of this.inputMap.gamepad) {
        if (binding.action === 'Move' || binding.action === 'Look') continue;
        const pressed = binding.buttons.some((index) => pad.buttons[index]?.pressed === true);
        if (pressed) {
          buttons[binding.action as ButtonAction] = true;
          this.lastDevice = 'gamepad';
        }
      }
    }

    moveX += this.virtualPad.moveX;
    moveY += this.virtualPad.moveY;
    lookX += this.virtualPad.lookX * this.inputMap.lookSensitivity;
    lookY += this.virtualPad.lookY * this.inputMap.lookSensitivity;
    for (const action of BUTTON_ACTIONS) {
      if (this.virtualPad.buttons[action] || this.latchedPadButtons.has(action)) {
        buttons[action] = true;
      }
    }

    if (this.inputMap.invertLookY) lookY = -lookY;

    // Latches survive exactly one sample, so a tap produces one press edge.
    this.latchedCodes.clear();
    this.latchedPadButtons.clear();

    return {
      moveX: clamp(moveX, -1, 1),
      moveY: clamp(moveY, -1, 1),
      lookX: clamp(lookX, -1, 1),
      lookY: clamp(lookY, -1, 1),
      buttons,
    };
  }
}

/** True when the current environment looks like a touch device. */
export function detectTouchDevice(): boolean {
  if (typeof window === 'undefined') return false;
  return 'ontouchstart' in window || (navigator.maxTouchPoints ?? 0) > 0;
}
