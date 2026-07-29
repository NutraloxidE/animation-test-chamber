import type { AnimationClipDefinition, SemanticEventDefinition, Vec3 } from '@atc/schema';
import { scaleVec3 } from '@atc/runtime-core';

const FAST_IN_END = 0.1;

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
  if (!clip.loop) return Math.min(raw, 1);
  return raw - Math.floor(raw);
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
  const wrapped = toNormalized < fromNormalized;
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
