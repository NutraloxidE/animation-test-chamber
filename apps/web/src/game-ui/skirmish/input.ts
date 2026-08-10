/**
 * The game UI's own input, edge-triggered.
 *
 * Separate from the character's input sampler on purpose: what a menu needs is
 * "this key went down once", and what a character needs is "this button is held
 * this tick". Sharing one path is how a single press buys two potions.
 *
 * Keyboard and gamepad produce the same named actions, so every menu is usable
 * either way, and a controller that disappears mid-match simply stops
 * contributing frames instead of throwing.
 */
import { useEffect, useRef } from "react";

export type UiAction =
  | "loadout-1"
  | "loadout-2"
  | "loadout-3"
  | "loadout-4"
  | "loadout-next"
  | "interact"
  | "consumable"
  | "panel"
  | "debug"
  | "cancel"
  | "confirm"
  | "up"
  | "down";

const KEY_ACTIONS: Record<string, UiAction> = {
  Digit1: "loadout-1",
  Digit2: "loadout-2",
  Digit3: "loadout-3",
  Digit4: "loadout-4",
  Tab: "panel",
  KeyE: "interact",
  KeyK: "consumable",
  F3: "debug",
  Escape: "cancel",
  Enter: "confirm",
  ArrowUp: "up",
  ArrowDown: "down",
};

/** Standard Gamepad button indices the authored input map leaves free. */
const PAD_ACTIONS: Record<number, UiAction> = {
  12: "up",
  13: "down",
  14: "loadout-next",
  15: "loadout-next",
  3: "consumable",
  7: "interact",
  0: "confirm",
  1: "cancel",
  9: "cancel",
};

/** D-pad left and right step the loadout in opposite directions. */
const PAD_DIRECTION: Record<number, number> = { 14: -1, 15: 1 };

export interface UiInputEvent {
  action: UiAction;
  /** −1 or +1 for a directional loadout step; 0 otherwise. */
  direction: number;
}

export function useUiInput(handler: (event: UiInputEvent) => void): void {
  const latest = useRef(handler);
  latest.current = handler;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.repeat) return;
      const action = KEY_ACTIONS[event.code];
      if (!action) return;
      /* Tab would otherwise walk the browser's focus ring out of the game. */
      if (event.code === "Tab" || event.code === "F3") event.preventDefault();
      latest.current({ action, direction: 0 });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    const held = new Set<string>();
    let frame = 0;
    const poll = (): void => {
      frame = requestAnimationFrame(poll);
      /*
       * A disconnected controller yields an empty list rather than an error, and
       * the previously held buttons are dropped so a reconnect does not replay
       * a press nobody made.
       */
      const pads = typeof navigator.getGamepads === "function" ? navigator.getGamepads() : [];
      const seen = new Set<string>();
      for (const pad of pads) {
        if (!pad) continue;
        for (const [index, action] of Object.entries(PAD_ACTIONS)) {
          const button = pad.buttons[Number(index)];
          if (!button?.pressed) continue;
          const key = `${pad.index}:${index}`;
          seen.add(key);
          if (held.has(key)) continue;
          latest.current({ action, direction: PAD_DIRECTION[Number(index)] ?? 0 });
        }
      }
      for (const key of [...held]) if (!seen.has(key)) held.delete(key);
      for (const key of seen) held.add(key);
    };
    frame = requestAnimationFrame(poll);
    return () => cancelAnimationFrame(frame);
  }, []);
}
