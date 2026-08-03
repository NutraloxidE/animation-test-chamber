/**
 * Clip Preview timing.
 *
 * The bug these exist to keep fixed: the transport advanced a 0..1 loop against
 * a fixed one-second span, so a 0.35 s attack and a 1.20 s dodge both took
 * exactly one second at speed 1 — while the control was labelled "authored
 * rate". Every assertion here is about seconds, because the fix is that the
 * clock has units.
 */
import { describe, expect, it } from 'vitest';
import {
  advancePreviewTime,
  clampPreviewSpeed,
  clampPreviewTime,
  normalizedPreviewTime,
} from '../../../apps/web/src/animation/clip-preview/clip-preview-state.ts';

/** Runs the transport at 60 Hz until it stops, returning seconds elapsed. */
function playToEnd(durationSec: number, speed: number): number {
  const dt = 1 / 600;
  let state = { timeSec: 0, playing: true, loop: false, speed };
  let elapsed = 0;
  for (let i = 0; i < 200_000 && state.playing; i += 1) {
    const next = advancePreviewTime(state, durationSec, dt);
    state = { ...state, ...next };
    elapsed += dt;
  }
  return elapsed;
}

describe('clip preview duration', () => {
  it('plays each clip for its own authored duration, not a shared second', () => {
    expect(playToEnd(0.4, 1)).toBeCloseTo(0.4, 2);
    expect(playToEnd(1.2, 1)).toBeCloseTo(1.2, 2);
  });

  it('gives speed its literal meaning', () => {
    // 0.8 s clip: half speed takes twice as long, double speed takes half.
    expect(playToEnd(0.8, 0.5)).toBeCloseTo(1.6, 2);
    expect(playToEnd(0.8, 1)).toBeCloseTo(0.8, 2);
    expect(playToEnd(0.8, 2)).toBeCloseTo(0.4, 2);
  });

  it('parks at the end when looping is off, and wraps when it is on', () => {
    const parked = advancePreviewTime(
      { timeSec: 0.39, playing: true, loop: false, speed: 1 },
      0.4,
      0.05,
    );
    expect(parked).toEqual({ timeSec: 0.4, playing: false });

    const wrapped = advancePreviewTime(
      { timeSec: 0.39, playing: true, loop: true, speed: 1 },
      0.4,
      0.05,
    );
    expect(wrapped.playing).toBe(true);
    expect(wrapped.timeSec).toBeCloseTo(0.04, 6);
  });
});

describe('clip preview edge cases', () => {
  it('does not advance a state whose slot resolves to nothing', () => {
    // Zero duration used to be a division by zero that parked the playhead at
    // NaN — a frozen pose with nothing to point at.
    const state = { timeSec: 0, playing: true, loop: true, speed: 1 };
    expect(advancePreviewTime(state, 0, 0.016)).toEqual({ timeSec: 0, playing: true });
    expect(normalizedPreviewTime(0.5, 0)).toBe(0);
  });

  it('clamps rather than propagates a non-finite or out-of-range speed', () => {
    expect(clampPreviewSpeed(Number.NaN)).toBe(1);
    expect(clampPreviewSpeed(Number.POSITIVE_INFINITY)).toBe(1);
    expect(clampPreviewSpeed(-3)).toBe(0);
    expect(clampPreviewSpeed(99)).toBe(4);
    expect(
      advancePreviewTime({ timeSec: 0, playing: true, loop: true, speed: Number.NaN }, 1, 0.5),
    ).toEqual({ timeSec: 0.5, playing: true });
  });

  it('clamps the playhead to the clip', () => {
    expect(clampPreviewTime(-1, 0.4)).toBe(0);
    expect(clampPreviewTime(9, 0.4)).toBe(0.4);
    expect(clampPreviewTime(Number.NaN, 0.4)).toBe(0);
    expect(clampPreviewTime(0.2, 0)).toBe(0);
  });

  it('derives normalized time from seconds rather than storing it', () => {
    expect(normalizedPreviewTime(0.18, 0.43)).toBeCloseTo(0.4186, 4);
    expect(normalizedPreviewTime(0.43, 0.43)).toBe(1);
    expect(normalizedPreviewTime(-1, 0.43)).toBe(0);
  });
});
