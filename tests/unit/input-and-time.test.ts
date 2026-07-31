import { describe, expect, it } from 'vitest';
import {
  FIXED_DT,
  FIXED_HZ,
  FixedStepAccumulator,
  applyDeadzone,
  createRandom,
  msToTicks,
} from '@atc/runtime-core';
import { InputState, decodeButtons, emptyButtons, encodeButtons } from '@atc/input-runtime';
import { ChamberEngine } from '../../apps/web/src/engine.ts';
import { loadResolvedDemoProject } from '../fixtures/project.ts';
import { normalizedTimeOf, sampleRootMotion } from '@atc/animation-runtime';

const project = loadResolvedDemoProject();

function sampleWith(buttons: Partial<Record<string, boolean>>, move = 0) {
  return {
    moveX: 0,
    moveY: move,
    lookX: 0,
    lookY: 0,
    buttons: { ...emptyButtons(), ...buttons } as ReturnType<typeof emptyButtons>,
  };
}

describe('fixed timestep', () => {
  it('uses the same nonlinear progress for pose time and root displacement', () => {
    const clip = structuredClone(project.clips.find((entry) => entry.id === 'dodge')!);
    clip.timeCurve = { x1: 0.42, y1: 0, x2: 1, y2: 1 };
    clip.rootMotionCurve = undefined;

    const midpoint = normalizedTimeOf(clip, clip.durationSec / 2);
    const root = sampleRootMotion(clip, 0, midpoint);

    expect(midpoint).toBeLessThan(0.5);
    expect(root.z).toBeCloseTo(clip.rootDisplacement.z * midpoint, 5);
    expect(normalizedTimeOf(clip, clip.durationSec)).toBe(1);
  });

  it('produces the same number of logic ticks regardless of frame rate', () => {
    const at60 = new FixedStepAccumulator();
    const at30 = new FixedStepAccumulator();
    const at120 = new FixedStepAccumulator();

    let ticks60 = 0;
    let ticks30 = 0;
    let ticks120 = 0;

    // One second of wall time, delivered in different frame sizes.
    for (let i = 0; i < 60; i += 1) ticks60 += at60.advance(1 / 60);
    for (let i = 0; i < 30; i += 1) ticks30 += at30.advance(1 / 30);
    for (let i = 0; i < 120; i += 1) ticks120 += at120.advance(1 / 120);

    expect(ticks60).toBe(FIXED_HZ);
    expect(ticks30).toBe(FIXED_HZ);
    expect(ticks120).toBe(FIXED_HZ);
  });

  it('clamps a huge delta instead of spiralling', () => {
    const accumulator = new FixedStepAccumulator();
    // A tab restore can hand us many seconds at once.
    expect(accumulator.advance(30)).toBeLessThanOrEqual(8);
  });

  it('drops exactly the injected number of ticks', () => {
    const accumulator = new FixedStepAccumulator();
    accumulator.injectFrameDrop(3);
    let ticks = 0;
    for (let i = 0; i < 60; i += 1) ticks += accumulator.advance(FIXED_DT);
    expect(accumulator.dropped).toBe(3);
    expect(ticks).toBe(57);
  });

  it('keeps camera look active while simulation is paused', () => {
    const engine = new ChamberEngine(project);
    const sampler = (engine as unknown as {
      sampler: { sample: () => ReturnType<typeof sampleWith> };
    }).sampler;
    sampler.sample = () => ({ ...sampleWith({}), lookX: 0.2 });

    const tick = engine.snapshot().tick;
    engine.setPaused(true);
    engine.advance(FIXED_DT);

    expect(engine.snapshot().tick).toBe(tick);
    expect(engine.camera.yaw).toBeCloseTo(-0.2);
  });
});

describe('deterministic random', () => {
  it('produces an identical stream for the same seed', () => {
    const a = createRandom(42);
    const b = createRandom(42);
    const c = createRandom(43);
    const first = Array.from({ length: 5 }, () => a());
    const second = Array.from({ length: 5 }, () => b());
    const third = Array.from({ length: 5 }, () => c());
    expect(first).toEqual(second);
    expect(first).not.toEqual(third);
  });
});

describe('stick deadzone', () => {
  it('zeroes input inside the deadzone', () => {
    expect(applyDeadzone(0.05, 0.05, 0.2)).toEqual({ x: 0, y: 0 });
  });

  it('rescales so the edge of the deadzone maps to zero, not a jump', () => {
    const justOutside = applyDeadzone(0.21, 0, 0.2);
    expect(justOutside.x).toBeGreaterThan(0);
    expect(justOutside.x).toBeLessThan(0.05);
  });

  it('still reaches full magnitude at the stick edge', () => {
    const full = applyDeadzone(1, 0, 0.2);
    expect(full.x).toBeCloseTo(1, 5);
  });
});

describe('button encoding', () => {
  it('round-trips through the replay bitmask', () => {
    const buttons = { ...emptyButtons(), Jump: true, Dodge: true };
    expect(decodeButtons(encodeButtons(buttons))).toEqual(buttons);
  });
});

describe('stick smoothing', () => {
  it('ramps to full deflection and snaps back to rest', () => {
    const input = new InputState(project.inputMap);

    input.beginTick(0, sampleWith({}, 1));
    const first = input.moveY;
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(1);

    for (let tick = 1; tick < 60; tick += 1) input.beginTick(tick, sampleWith({}, 1));
    expect(input.moveY).toBeCloseTo(1, 2);

    // Release: decays, then reads as exactly no input rather than a crawl.
    input.beginTick(60, sampleWith({}, 0));
    expect(input.moveY).toBeLessThan(1);
    expect(input.moveY).toBeGreaterThan(0);
    for (let tick = 61; tick < 120; tick += 1) input.beginTick(tick, sampleWith({}, 0));
    expect(input.moveMagnitude).toBe(0);
  });
});

describe('input buffering', () => {
  it('reports a press as buffered inside the window', () => {
    const input = new InputState(project.inputMap);
    input.beginTick(0, sampleWith({ Jump: true }));
    expect(input.isBuffered('Jump', 140)).toBe(true);

    // 140ms is ~8 ticks at 60Hz.
    input.beginTick(msToTicks(140), sampleWith({ Jump: true }));
    expect(input.isBuffered('Jump', 140)).toBe(true);
  });

  it('expires a press once the window passes', () => {
    const input = new InputState(project.inputMap);
    input.beginTick(0, sampleWith({ Jump: true }));
    input.beginTick(1, sampleWith({}));
    input.beginTick(40, sampleWith({}));
    expect(input.isBuffered('Jump', 140)).toBe(false);
  });

  it('consumes a buffered press so it cannot fire twice', () => {
    const input = new InputState(project.inputMap);
    input.beginTick(0, sampleWith({ Jump: true }));
    expect(input.consumeBuffered('Jump', 140)).toBe(true);
    expect(input.consumeBuffered('Jump', 140)).toBe(false);
  });

  it('re-arms the buffer on a fresh press after a consumed one', () => {
    const input = new InputState(project.inputMap);
    input.beginTick(0, sampleWith({ Jump: true }));
    input.consumeBuffered('Jump', 140);
    input.beginTick(1, sampleWith({}));
    input.beginTick(2, sampleWith({ Jump: true }));
    expect(input.isBuffered('Jump', 140)).toBe(true);
  });

  it('discards a fresh press while its action window is closed', () => {
    const input = new InputState(project.inputMap);
    input.beginTick(0, sampleWith({ PrimaryAction: true }), () => false);
    expect(input.isBuffered('PrimaryAction', 200)).toBe(false);
    expect(input.isAcceptedDown('PrimaryAction')).toBe(false);

    input.beginTick(1, sampleWith({}));
    input.beginTick(2, sampleWith({ PrimaryAction: true }), () => true);
    expect(input.isBuffered('PrimaryAction', 200)).toBe(true);
  });

  it('distinguishes press, hold and release edges', () => {
    const input = new InputState(project.inputMap);
    input.beginTick(0, sampleWith({ Guard: true }));
    expect(input.justPressed('Guard')).toBe(true);
    expect(input.isDown('Guard')).toBe(true);

    input.beginTick(1, sampleWith({ Guard: true }));
    expect(input.justPressed('Guard')).toBe(false);
    expect(input.heldTicks('Guard')).toBe(1);

    input.beginTick(2, sampleWith({}));
    expect(input.justReleased('Guard')).toBe(true);
    expect(input.isDown('Guard')).toBe(false);
  });
});

describe('coyote time', () => {
  it('stays available briefly after leaving the ground', () => {
    const input = new InputState(project.inputMap);
    input.beginTick(0, sampleWith({}));
    input.markGrounded(true);

    // coyoteTimeMs is 120ms, about 7 ticks.
    input.beginTick(5, sampleWith({}));
    input.markGrounded(false);
    expect(input.hasCoyoteTime()).toBe(true);

    input.beginTick(30, sampleWith({}));
    input.markGrounded(false);
    expect(input.hasCoyoteTime()).toBe(false);
  });
});
