/**
 * What makes the preview run.
 *
 * The engine advances from wall-clock deltas handed to it; it does not own a
 * loop. In the donor that hand belonged to the viewport's `useFrame`, which was
 * fine while a viewport was the only thing that wanted the simulation moving —
 * and wrong now, because Graph, Inspector and Timeline all show live state and
 * none of them draws anything.
 *
 * So the clock lives in the workspace shell, and stands down via `enabled`
 * whenever the viewport is mounted and driving the same engine from
 * `useFrame` — two drivers on one accumulator is two simulations' worth of
 * ticks per frame. What remains for the clock is the subject with no body to
 * draw, which still needs live state in Graph and Timeline.
 */
import { useEffect } from 'react';
import type { ChamberEngine } from '../engine.ts';

/** Longest delta fed to the engine, so a backgrounded tab cannot burst-tick. */
const MAX_DELTA_SEC = 0.1;

export function useAnimationPreviewClock(
  engine: ChamberEngine | null,
  options: { enabled?: boolean } = {},
): void {
  const enabled = options.enabled ?? true;

  useEffect(() => {
    if (!engine || !enabled) return undefined;
    let frame = 0;
    let previous = performance.now();

    const tick = (now: number): void => {
      /*
       * Clamped rather than passed through. A tab restored after a minute
       * hands back a sixty-second delta, and an unclamped fixed-step
       * accumulator would then run thousands of ticks in one frame — which
       * looks exactly like a hang.
       */
      const delta = Math.min((now - previous) / 1000, MAX_DELTA_SEC);
      previous = now;
      engine.advance(delta);
      frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [engine, enabled]);
}
