import type { SurfaceMaterial, TerrainFeature, TerrainPreset, Vec3 } from '@atc/schema';
import { normalizeVec3, vec3 } from '@atc/runtime-core';

export interface GroundSample {
  /** Ground height at the queried column, or null when there is no ground. */
  height: number | null;
  normal: Vec3;
  surface: SurfaceMaterial;
  /** Velocity of the supporting surface, for moving platforms. */
  platformVelocity: Vec3;
  platformAngularVelocity: number;
  featureKind: TerrainFeature['kind'] | null;
}

const DEFAULT_SURFACE: SurfaceMaterial = {
  id: 'default',
  friction: 1,
  accelerationScale: 1,
  dragScale: 1,
};

function surfaceOf(preset: TerrainPreset, id: string): SurfaceMaterial {
  return preset.surfaces.find((surface) => surface.id === id) ?? DEFAULT_SURFACE;
}

/** Current world offset of a moving platform at simulation time `timeSec`. */
export function movingPlatformOffset(
  feature: Extract<TerrainFeature, { kind: 'moving-platform' }>,
  timeSec: number,
): number {
  const omega = (Math.PI * 2) / feature.periodSec;
  return Math.sin(omega * timeSec) * feature.amplitude;
}

export function movingPlatformVelocity(
  feature: Extract<TerrainFeature, { kind: 'moving-platform' }>,
  timeSec: number,
): Vec3 {
  const omega = (Math.PI * 2) / feature.periodSec;
  const speed = Math.cos(omega * timeSec) * feature.amplitude * omega;
  if (feature.axis === 'x') return vec3(speed, 0, 0);
  if (feature.axis === 'y') return vec3(0, speed, 0);
  return vec3(0, 0, speed);
}

interface Contribution {
  height: number;
  normal: Vec3;
  surfaceId: string;
  platformVelocity: Vec3;
  platformAngularVelocity: number;
  kind: TerrainFeature['kind'];
}

function contributionOf(
  feature: TerrainFeature,
  x: number,
  z: number,
  timeSec: number,
): Contribution | null {
  switch (feature.kind) {
    case 'plane':
      return {
        height: feature.height,
        normal: vec3(0, 1, 0),
        surfaceId: feature.surface,
        platformVelocity: vec3(),
        platformAngularVelocity: 0,
        kind: 'plane',
      };

    case 'slope': {
      const span = feature.endZ - feature.startZ;
      if (Math.abs(span) < 1e-6) return null;
      // Outside the ramp the slope contributes its flat start/end plateau.
      const t = (z - feature.startZ) / span;
      const clamped = Math.min(Math.max(t, 0), 1);
      const height = clamped * feature.rise;
      const slopeNormal =
        t <= 0 || t >= 1
          ? vec3(0, 1, 0)
          : normalizeVec3(vec3(0, Math.abs(span), -feature.rise * Math.sign(span)));
      return {
        height,
        normal: slopeNormal,
        surfaceId: feature.surface,
        platformVelocity: vec3(),
        platformAngularVelocity: 0,
        kind: 'slope',
      };
    }

    case 'steps': {
      const local = z - feature.startZ;
      if (local < 0) {
        return {
          height: 0,
          normal: vec3(0, 1, 0),
          surfaceId: feature.surface,
          platformVelocity: vec3(),
          platformAngularVelocity: 0,
          kind: 'steps',
        };
      }
      const index = Math.min(Math.floor(local / feature.stepDepth) + 1, feature.count);
      return {
        height: index * feature.stepHeight,
        normal: vec3(0, 1, 0),
        surfaceId: feature.surface,
        platformVelocity: vec3(),
        platformAngularVelocity: 0,
        kind: 'steps',
      };
    }

    case 'box': {
      const halfX = feature.size.x / 2;
      const halfZ = feature.size.z / 2;
      if (
        x < feature.center.x - halfX ||
        x > feature.center.x + halfX ||
        z < feature.center.z - halfZ ||
        z > feature.center.z + halfZ
      ) {
        return null;
      }
      return {
        height: feature.center.y + feature.size.y / 2,
        normal: vec3(0, 1, 0),
        surfaceId: feature.surface,
        platformVelocity: vec3(),
        platformAngularVelocity: 0,
        kind: 'box',
      };
    }

    case 'ledge':
      if (z > feature.edgeZ) return null;
      return {
        height: feature.height,
        normal: vec3(0, 1, 0),
        surfaceId: feature.surface,
        platformVelocity: vec3(),
        platformAngularVelocity: 0,
        kind: 'ledge',
      };

    case 'moving-platform': {
      const offset = movingPlatformOffset(feature, timeSec);
      const center = {
        x: feature.center.x + (feature.axis === 'x' ? offset : 0),
        y: feature.center.y + (feature.axis === 'y' ? offset : 0),
        z: feature.center.z + (feature.axis === 'z' ? offset : 0),
      };
      const halfX = feature.size.x / 2;
      const halfZ = feature.size.z / 2;
      if (x < center.x - halfX || x > center.x + halfX || z < center.z - halfZ || z > center.z + halfZ) {
        return null;
      }
      return {
        height: center.y + feature.size.y / 2,
        normal: vec3(0, 1, 0),
        surfaceId: feature.surface,
        platformVelocity: movingPlatformVelocity(feature, timeSec),
        platformAngularVelocity: feature.angularVelocity,
        kind: 'moving-platform',
      };
    }

    case 'uneven': {
      const height =
        feature.amplitude * Math.sin(feature.frequencyX * x) * Math.cos(feature.frequencyZ * z);
      // Analytic gradient keeps the normal exact and frame-rate independent.
      const dx =
        feature.amplitude *
        feature.frequencyX *
        Math.cos(feature.frequencyX * x) *
        Math.cos(feature.frequencyZ * z);
      const dz =
        -feature.amplitude *
        feature.frequencyZ *
        Math.sin(feature.frequencyX * x) *
        Math.sin(feature.frequencyZ * z);
      return {
        height,
        normal: normalizeVec3(vec3(-dx, 1, -dz)),
        surfaceId: feature.surface,
        platformVelocity: vec3(),
        platformAngularVelocity: 0,
        kind: 'uneven',
      };
    }
  }
}

/**
 * Samples the terrain column at (x, z). Features are combined by taking the
 * highest contributor, which is what makes boxes and platforms stack over a
 * base plane without a real collision engine.
 */
export function sampleGround(preset: TerrainPreset, x: number, z: number, timeSec: number): GroundSample {
  let best: Contribution | null = null;
  for (const feature of preset.features) {
    const contribution = contributionOf(feature, x, z, timeSec);
    if (!contribution) continue;
    if (!best || contribution.height > best.height) best = contribution;
  }

  if (!best) {
    return {
      height: null,
      normal: vec3(0, 1, 0),
      surface: DEFAULT_SURFACE,
      platformVelocity: vec3(),
      platformAngularVelocity: 0,
      featureKind: null,
    };
  }

  return {
    height: best.height,
    normal: best.normal,
    surface: surfaceOf(preset, best.surfaceId),
    platformVelocity: best.platformVelocity,
    platformAngularVelocity: best.platformAngularVelocity,
    featureKind: best.kind,
  };
}

/** Slope angle in radians, derived from the sampled normal. */
export function slopeAngle(normal: Vec3): number {
  return Math.acos(Math.min(1, Math.max(-1, normal.y)));
}
