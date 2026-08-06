/**
 * What makes the preview run.
 *
 * The engine advances from wall-clock deltas handed to it; it does not own a
 * loop. In the donor that hand belonged to the viewport's `useFrame`, which was
 * fine while a viewport was the only thing that wanted the simulation moving —
 * and wrong now, because Graph, Inspector and Timeline all show live state and
 * none of them draws anything.
 *
 * So the clock lives in the workspace shell. When the 3D viewport arrives it
 * takes the same `AnimationPreviewControls` handle and this hook stands down
 * via `enabled`, because two drivers on one accumulator is two simulations'
 * worth of ticks per frame.
 */
import { useEffect } from 'react';
import type { AnimationPreviewControls } from './AnimationLivePreview.ts';

/** Longest delta fed to the engine, so a backgrounded tab cannot burst-tick. */
const MAX_DELTA_SEC = 0.1;

export function useAnimationPreviewClock(
  controls: AnimationPreviewControls | null,
  options: { enabled?: boolean } = {},
): void {
  const enabled = options.enabled ?? true;

  useEffect(() => {
    if (!controls || !enabled) return undefined;
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
      controls.advance(delta);
      frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [controls, enabled]);
}
