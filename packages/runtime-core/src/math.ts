import type { CurveKind, Vec3 } from '@atc/schema';

export const vec3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });
export const cloneVec3 = (v: Vec3): Vec3 => ({ x: v.x, y: v.y, z: v.z });
export const addVec3 = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const subVec3 = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const scaleVec3 = (a: Vec3, s: number): Vec3 => ({ x: a.x * s, y: a.y * s, z: a.z * s });
export const lengthVec3 = (a: Vec3): number => Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
export const horizontalLength = (a: Vec3): number => Math.sqrt(a.x * a.x + a.z * a.z);
export const distanceVec3 = (a: Vec3, b: Vec3): number => lengthVec3(subVec3(a, b));

export function normalizeVec3(a: Vec3): Vec3 {
  const len = lengthVec3(a);
  return len < 1e-9 ? vec3(0, 0, 0) : scaleVec3(a, 1 / len);
}

export function dotVec3(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function lerpVec3(a: Vec3, b: Vec3, t: number): Vec3 {
  return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), z: lerp(a.z, b.z, t) };
}

export function moveTowards(current: number, target: number, maxDelta: number): number {
  const delta = target - current;
  if (Math.abs(delta) <= maxDelta) return target;
  return current + Math.sign(delta) * maxDelta;
}

/** Shortest signed angular difference, in radians. */
export function angleDelta(from: number, to: number): number {
  let delta = (to - from) % (Math.PI * 2);
  if (delta > Math.PI) delta -= Math.PI * 2;
  if (delta < -Math.PI) delta += Math.PI * 2;
  return delta;
}

export function rotateTowardsAngle(current: number, target: number, maxDelta: number): number {
  const delta = angleDelta(current, target);
  if (Math.abs(delta) <= maxDelta) return target;
  return current + Math.sign(delta) * maxDelta;
}

/** Applies a radial deadzone and rescales the remainder to the full range. */
export function applyDeadzone(x: number, y: number, deadzone: number): { x: number; y: number } {
  const magnitude = Math.sqrt(x * x + y * y);
  if (magnitude <= deadzone || magnitude < 1e-9) return { x: 0, y: 0 };
  const scaled = Math.min((magnitude - deadzone) / (1 - deadzone), 1);
  return { x: (x / magnitude) * scaled, y: (y / magnitude) * scaled };
}

export function evaluateCurve(kind: CurveKind, t: number): number {
  const x = clamp01(t);
  switch (kind) {
    case 'linear':
      return x;
    case 'ease-in':
      return x * x;
    case 'ease-out':
      return 1 - (1 - x) * (1 - x);
    case 'ease-in-out':
      return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2;
    case 'step':
      return x < 1 ? 0 : 1;
  }
}

/**
 * Rounds to a fixed number of decimals. Used on every simulated quantity that
 * ends up in a trace so replay comparison is not sensitive to float noise.
 */
export function quantize(value: number, decimals = 6): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** Deterministic PRNG (mulberry32). Same seed always yields the same stream. */
export function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
