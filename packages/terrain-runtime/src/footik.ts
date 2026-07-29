import type { TerrainInteractionProfile, TerrainPreset, Vec3 } from '@atc/schema';
import { clamp01, lerp, vec3 } from '@atc/runtime-core';
import { sampleGround, slopeAngle } from './sample.ts';

export interface FootSolveInput {
  /** World position of the foot as authored by the animation, before IK. */
  originalPosition: Vec3;
  /** True while the clip says this foot is planted. */
  planted: boolean;
}

export interface FootSolve {
  originalPosition: Vec3;
  correctedPosition: Vec3;
  /** Ankle pitch needed to match the ground normal, in radians. */
  ankleRotationRad: number;
  groundNormal: Vec3;
  contact: boolean;
  /** Distance the planted foot slid across the ground this tick. */
  slidingDistance: number;
  /** Positive when the authored foot was below the ground. */
  penetrationDepth: number;
  /** Positive when the planted foot hovered above the ground. */
  floatingDistance: number;
}

export interface FootIkResult {
  left: FootSolve;
  right: FootSolve;
  /** Downward pelvis adjustment so neither leg over-extends. */
  pelvisOffset: number;
}

export interface FootIkState {
  previousLeft: Vec3 | null;
  previousRight: Vec3 | null;
  smoothedLeftY: number | null;
  smoothedRightY: number | null;
}

export function createFootIkState(): FootIkState {
  return { previousLeft: null, previousRight: null, smoothedLeftY: null, smoothedRightY: null };
}

function solveFoot(
  preset: TerrainPreset,
  profile: TerrainInteractionProfile,
  input: FootSolveInput,
  timeSec: number,
  previous: Vec3 | null,
  smoothedY: number | null,
): { solve: FootSolve; smoothedY: number } {
  const sample = sampleGround(preset, input.originalPosition.x, input.originalPosition.z, timeSec);
  const groundY = sample.height ?? input.originalPosition.y;

  const penetrationDepth = Math.max(0, groundY - input.originalPosition.y);
  const floatingDistance = input.planted ? Math.max(0, input.originalPosition.y - groundY) : 0;

  // Blend toward the ground by the tuned IK strength, then temporally smooth so
  // stair edges do not pop. Smoothing is applied to Y only; X/Z stay authored.
  const targetY = lerp(input.originalPosition.y, groundY, profile.footIkStrength);
  const nextSmoothedY =
    smoothedY === null
      ? targetY
      : lerp(targetY, smoothedY, clamp01(profile.footTargetSmoothing));

  const correctedPosition = vec3(input.originalPosition.x, nextSmoothedY, input.originalPosition.z);

  const slidingDistance =
    input.planted && previous
      ? Math.hypot(correctedPosition.x - previous.x, correctedPosition.z - previous.z)
      : 0;

  return {
    solve: {
      originalPosition: input.originalPosition,
      correctedPosition,
      // Ankle follows the ground pitch, scaled by the same IK strength.
      ankleRotationRad: slopeAngle(sample.normal) * profile.footIkStrength,
      groundNormal: sample.normal,
      contact: input.planted && Math.abs(correctedPosition.y - groundY) < 0.02,
      slidingDistance,
      penetrationDepth,
      floatingDistance,
    },
    smoothedY: nextSmoothedY,
  };
}

/**
 * Two-foot grounding pass (PLAN 11.4). Deliberately simple: it corrects foot
 * height to the terrain, derives an ankle angle from the ground normal, and
 * drops the pelvis so the lower foot can reach. It reports every quantity the
 * debug overlay and the regression metrics need, including the ones that
 * indicate it is doing a bad job.
 */
export function solveFootIk(
  preset: TerrainPreset,
  profile: TerrainInteractionProfile,
  left: FootSolveInput,
  right: FootSolveInput,
  timeSec: number,
  state: FootIkState,
): FootIkResult {
  const leftResult = solveFoot(preset, profile, left, timeSec, state.previousLeft, state.smoothedLeftY);
  const rightResult = solveFoot(
    preset,
    profile,
    right,
    timeSec,
    state.previousRight,
    state.smoothedRightY,
  );

  state.previousLeft = leftResult.solve.correctedPosition;
  state.previousRight = rightResult.solve.correctedPosition;
  state.smoothedLeftY = leftResult.smoothedY;
  state.smoothedRightY = rightResult.smoothedY;

  // Lower the pelvis by the larger downward correction so the other leg is not
  // forced to straighten past its rest length.
  const leftDrop = left.originalPosition.y - leftResult.solve.correctedPosition.y;
  const rightDrop = right.originalPosition.y - rightResult.solve.correctedPosition.y;
  const pelvisOffset = Math.min(0, -Math.max(leftDrop, rightDrop)) * profile.pelvisOffsetStrength;

  return { left: leftResult.solve, right: rightResult.solve, pelvisOffset };
}
