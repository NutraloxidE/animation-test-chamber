import { useCallback, useEffect, useRef, useState } from 'react';
import type { ButtonAction } from '@atc/schema';
import type { VirtualPadState } from '@atc/input-runtime';
import { useChamber } from '../store.ts';
import type { ChamberEngine } from '../engine.ts';
import type { InputMapDefinition } from '@atc/schema';

const BUTTONS: { action: ButtonAction; label: string }[] = [
  { action: 'Jump', label: 'A' },
  { action: 'PrimaryAction', label: 'X' },
  { action: 'SecondaryAction', label: 'Y' },
  { action: 'Dodge', label: 'B' },
  { action: 'Guard', label: 'LB' },
];

/**
 * On-screen pad (PLAN 6.2). Multi-touch: the stick, the camera drag area and the
 * buttons are tracked by pointer id, so steering, looking and attacking can all
 * happen at once. It writes into the same ActionSample as every other device.
 */
export function MobilePad({ engine: suppliedEngine, inputMap, hideUi: suppliedHideUi }: { engine?: ChamberEngine; inputMap?: InputMapDefinition; hideUi?: boolean } = {}) {
  const storeEngine = useChamber((state) => state.engine);
  const project = useChamber((state) => state.project);
  const storeHideUi = useChamber((state) => state.hideUiForRecording);
  const engine = suppliedEngine ?? storeEngine;
  const hideUi = suppliedHideUi ?? storeHideUi;

  const layout = (inputMap ?? project.inputMap).mobilePad;
  const [stickVector, setStickVector] = useState({ x: 0, y: 0 });
  const [stickOrigin, setStickOrigin] = useState<{ x: number; y: number } | null>(null);

  const stickPointer = useRef<number | null>(null);
  const lookPointer = useRef<number | null>(null);
  const lookLast = useRef<{ x: number; y: number } | null>(null);
  const padState = useRef<VirtualPadState>({ moveX: 0, moveY: 0, lookX: 0, lookY: 0, buttons: {} });

  const push = useCallback(() => {
    engine.setVirtualPad({ ...padState.current, buttons: { ...padState.current.buttons } });
    // Look is a per-frame delta: consume it so it does not keep applying.
    padState.current.lookX = 0;
    padState.current.lookY = 0;
  }, [engine]);

  useEffect(() => {
    const interval = window.setInterval(push, 16);
    return () => {
      window.clearInterval(interval);
      engine.clearVirtualPad();
    };
  }, [engine, push]);

  const radius = 60 * layout.buttonScale;

  const onStickDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (stickPointer.current !== null) return;
    stickPointer.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
    if (layout.stickMode === 'floating') {
      setStickOrigin({ x: event.clientX, y: event.clientY });
    } else {
      const rect = event.currentTarget.getBoundingClientRect();
      setStickOrigin({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
    }
  };

  const onStickMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (stickPointer.current !== event.pointerId || !stickOrigin) return;
    const dx = event.clientX - stickOrigin.x;
    const dy = event.clientY - stickOrigin.y;
    const distance = Math.min(Math.hypot(dx, dy), radius);
    const angle = Math.atan2(dy, dx);
    const nx = (Math.cos(angle) * distance) / radius;
    const ny = (Math.sin(angle) * distance) / radius;
    setStickVector({ x: nx * radius, y: ny * radius });
    padState.current.moveX = nx;
    // Screen Y grows downward; forward is negative screen Y.
    padState.current.moveY = -ny;
  };

  const onStickUp = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (stickPointer.current !== event.pointerId) return;
    stickPointer.current = null;
    setStickVector({ x: 0, y: 0 });
    if (layout.stickMode === 'floating') setStickOrigin(null);
    padState.current.moveX = 0;
    padState.current.moveY = 0;
  };

  const onLookDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (lookPointer.current !== null) return;
    lookPointer.current = event.pointerId;
    lookLast.current = { x: event.clientX, y: event.clientY };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onLookMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (lookPointer.current !== event.pointerId || !lookLast.current) return;
    padState.current.lookX += (event.clientX - lookLast.current.x) * 0.004;
    padState.current.lookY += (event.clientY - lookLast.current.y) * 0.004;
    lookLast.current = { x: event.clientX, y: event.clientY };
  };

  const onLookUp = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (lookPointer.current !== event.pointerId) return;
    lookPointer.current = null;
    lookLast.current = null;
  };

  if (hideUi || layout.hideForRecording) return null;

  return (
    <div
      className={`mobile-pad${layout.leftHanded ? ' mobile-pad--left-handed' : ''}`}
      style={{ opacity: layout.opacity }}
      data-testid="mobile-pad"
    >
      <div
        className="mobile-pad__look"
        onPointerDown={onLookDown}
        onPointerMove={onLookMove}
        onPointerUp={onLookUp}
        onPointerCancel={onLookUp}
        aria-label="camera drag area"
      />

      <div
        className="mobile-pad__stick"
        style={{ width: radius * 2, height: radius * 2 }}
        onPointerDown={onStickDown}
        onPointerMove={onStickMove}
        onPointerUp={onStickUp}
        onPointerCancel={onStickUp}
        data-testid="mobile-stick"
        aria-label="movement stick"
      >
        <div
          className="mobile-pad__knob"
          style={{ transform: `translate(${stickVector.x}px, ${stickVector.y}px)` }}
        />
      </div>

      <div className="mobile-pad__buttons">
        {BUTTONS.map((button) => (
          <button
            type="button"
            key={button.action}
            className="mobile-pad__button"
            style={{ width: 56 * layout.buttonScale, height: 56 * layout.buttonScale }}
            data-testid={`pad-${button.action}`}
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture(event.pointerId);
              padState.current.buttons[button.action] = true;
            }}
            onPointerUp={() => {
              padState.current.buttons[button.action] = false;
            }}
            onPointerCancel={() => {
              padState.current.buttons[button.action] = false;
            }}
          >
            {button.label}
          </button>
        ))}
      </div>
    </div>
  );
}
