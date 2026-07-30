import type { AnimationClipDefinition, SemanticEventDefinition, Vec3 } from '@atc/schema';
import { scaleVec3 } from '@atc/runtime-core';

const FAST_IN_END = 0.1;

function cubicBezier(t: number, p1: number, p2: number): number {
  const inverse = 1 - t;
  return 3 * inverse * inverse * t * p1 + 3 * inverse * t * t * p2 + t * t * t;
}

/** Maps wall-clock progress to clip progress using CSS cubic-bezier semantics. */
export function applyClipTimeCurve(
  clip: AnimationClipDefinition,
  elapsedNormalized: number,
): number {
  const curve = clip.timeCurve;
  const x = Math.max(0, Math.min(elapsedNormalized, 1));
  if (!curve || x === 0 || x === 1) return x;

  // x(t) is monotonic because both control-point x values are constrained to [0,1].
  let low = 0;
  let high = 1;
  for (let i = 0; i < 14; i += 1) {
    const t = (low + high) / 2;
    if (cubicBezier(t, curve.x1, curve.x2) < x) low = t;
    else high = t;
  }
  return cubicBezier((low + high) / 2, curve.y1, curve.y2);
}

function rootMotionProgress(clip: AnimationClipDefinition, normalized: number): number {
  if (clip.rootMotionCurve !== 'FastInSlowOut') return normalized;
  const time = Math.max(0, Math.min(normalized, 1));
  return time <= FAST_IN_END
    ? (time * time) / FAST_IN_END
    : 1 - ((1 - time) * (1 - time)) / (1 - FAST_IN_END);
}

/** Normalized position within a clip, honouring its loop flag. */
export function normalizedTimeOf(clip: AnimationClipDefinition, timeSec: number): number {
  if (clip.durationSec <= 0) return 0;
  const raw = timeSec / clip.durationSec;
  const elapsed = !clip.loop ? Math.min(raw, 1) : raw - Math.floor(raw);
  return applyClipTimeCurve(clip, elapsed);
}

/** True once a non-looping clip has played through. */
export function isClipFinished(clip: AnimationClipDefinition, timeSec: number): boolean {
  return !clip.loop && timeSec >= clip.durationSec;
}

/**
 * Root displacement produced between two normalized times. Authored
 * displacement is treated as linear across the clip, which is enough for the
 * MVP's procedural clips and keeps the Unity adapter's arithmetic identical.
 */
export function sampleRootMotion(
  clip: AnimationClipDefinition,
  fromNormalized: number,
  toNormalized: number,
): Vec3 {
  let delta = rootMotionProgress(clip, toNormalized) - rootMotionProgress(clip, fromNormalized);
  // A loop wrap shows up as a large negative step; treat it as forward progress.
  if (delta < -0.5) delta += 1;
  return scaleVec3(clip.rootDisplacement, delta);
}

/** True when the given foot is authored as planted at this normalized time. */
export function isFootPlanted(
  clip: AnimationClipDefinition,
  normalized: number,
  side: 'left' | 'right',
): boolean {
  const windows = side === 'left' ? clip.footContacts.left : clip.footContacts.right;
  return windows.some((window) => normalized >= window.start && normalized <= window.end);
}

/**
 * Semantic events whose authored time falls in (from, to]. Handles the loop
 * wrap so a looping clip fires its events once per cycle, never twice and
 * never zero times when a tick straddles the boundary.
 */
export function eventsInRange(
  clip: AnimationClipDefinition,
  fromNormalized: number,
  toNormalized: number,
): SemanticEventDefinition[] {
  const wrapped = clip.loop && toNormalized < fromNormalized;
  return clip.events.filter((event) => {
    if (wrapped) {
      return event.at > fromNormalized || event.at <= toNormalized;
    }
    return event.at > fromNormalized && event.at <= toNormalized;
  });
}

export function findClip(
  clips: AnimationClipDefinition[],
  clipId: string,
): AnimationClipDefinition | undefined {
  return clips.find((clip) => clip.id === clipId);
}
