import type { TransformDefinition } from '@atc/schema';

type Quat = TransformDefinition['rotation'];
type Vec = TransformDefinition['position'];

function multiplyQuaternions(a: Quat, b: Quat): Quat {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

function rotateVector(q: Quat, v: Vec): Vec {
  // t = 2 * (q.xyz × v); v' = v + q.w * t + q.xyz × t
  const tx = 2 * (q.y * v.z - q.z * v.y);
  const ty = 2 * (q.z * v.x - q.x * v.z);
  const tz = 2 * (q.x * v.y - q.y * v.x);
  return {
    x: v.x + q.w * tx + (q.y * tz - q.z * ty),
    y: v.y + q.w * ty + (q.z * tx - q.x * tz),
    z: v.z + q.w * tz + (q.x * ty - q.y * tx),
  };
}

/**
 * `child` expressed in `parent`'s parent space — ordinary TRS composition.
 *
 * A nested Prefab instance declares where the nested root sits inside the
 * nesting Prefab, and the nested Prefab's own root declares how its contents
 * sit relative to itself. Both are real, authored placements, so resolution
 * composes them rather than picking one; discarding either would silently move
 * every nested object the moment someone gave the nested root an offset.
 *
 * Values are rounded to a fixed precision. Composition happens inside a
 * migration whose output is committed and byte-compared, and the last bits of a
 * float are exactly where "deterministic" quietly stops being true across
 * platforms.
 */
export function composeTransforms(
  parent: TransformDefinition,
  child: TransformDefinition,
): TransformDefinition {
  const scaled: Vec = {
    x: child.position.x * parent.scale.x,
    y: child.position.y * parent.scale.y,
    z: child.position.z * parent.scale.z,
  };
  const rotated = rotateVector(parent.rotation, scaled);
  return roundTransform({
    position: {
      x: parent.position.x + rotated.x,
      y: parent.position.y + rotated.y,
      z: parent.position.z + rotated.z,
    },
    rotation: multiplyQuaternions(parent.rotation, child.rotation),
    scale: {
      x: parent.scale.x * child.scale.x,
      y: parent.scale.y * child.scale.y,
      z: parent.scale.z * child.scale.z,
    },
  });
}

const PRECISION = 1e9;

function round(value: number): number {
  // `+ 0` collapses -0 to 0, so two runs that differ only in the sign of zero
  // do not produce two different JSON documents.
  return Math.round(value * PRECISION) / PRECISION + 0;
}

export function roundTransform(transform: TransformDefinition): TransformDefinition {
  return {
    position: {
      x: round(transform.position.x),
      y: round(transform.position.y),
      z: round(transform.position.z),
    },
    rotation: {
      x: round(transform.rotation.x),
      y: round(transform.rotation.y),
      z: round(transform.rotation.z),
      w: round(transform.rotation.w),
    },
    scale: {
      x: round(transform.scale.x),
      y: round(transform.scale.y),
      z: round(transform.scale.z),
    },
  };
}
