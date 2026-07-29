import type {
  SurfaceMaterial,
  TerrainInteractionProfile,
  TerrainPreset,
  TerrainState,
  Vec3,
} from '@atc/schema';
import { clamp01, vec3 } from '@atc/runtime-core';
import { sampleGround, slopeAngle } from './sample.ts';

/**
 * Below this slope the ground counts as flat for step and wall detection.
 * Chosen to sit clearly under the shallowest authored ramp (~11°) so a gentle
 * slope is never mistaken for a series of steps.
 */
const FLAT_GROUND_EPSILON_RAD = 0.12;

export interface TerrainQuery {
  position: Vec3;
  /** Horizontal facing, used to probe ahead for ledges and walls. */
  yawRad: number;
  verticalVelocity: number;
  horizontalSpeed: number;
  wasGrounded: boolean;
  timeSec: number;
}

export interface TerrainResolution {
  grounded: boolean;
  /** Height the character's feet should rest at, when grounded. */
  groundHeight: number;
  normal: Vec3;
  slopeRad: number;
  surface: SurfaceMaterial;
  state: TerrainState;
  nearLedge: boolean;
  againstWall: boolean;
  onMovingPlatform: boolean;
  platformVelocity: Vec3;
  platformAngularVelocity: number;
  /** Vertical distance the character was lifted by a step this tick. */
  steppedUp: number;
  steppedDown: number;
  /** How much of the character is below the ground surface, if any. */
  penetration: number;
  /** Gap between the feet and the ground while grounded. */
  floating: number;
  landing: 'none' | 'light' | 'heavy';
  /** Speed multiplier from slope compensation and surface material. */
  speedScale: number;
  accelerationScale: number;
}

/**
 * Resolves grounding, terrain state and surface response for one tick.
 *
 * The MVP models the character as a vertical capsule over a height field: the
 * ground probe is a downward ray with a forward look-ahead for ledges and a
 * forward probe at knee height for walls. Everything it produces is a pure
 * function of canonical data plus the query, so the Unity adapter can
 * reimplement it and reach the same terrain states.
 */
export function resolveTerrain(
  preset: TerrainPreset,
  profile: TerrainInteractionProfile,
  query: TerrainQuery,
): TerrainResolution {
  const { position, timeSec } = query;
  const here = sampleGround(preset, position.x, position.z, timeSec);

  const groundHeight = here.height ?? Number.NEGATIVE_INFINITY;
  const distanceToGround = position.y - groundHeight;

  // Grounded while within the probe distance and not moving upward fast.
  const withinProbe =
    here.height !== null &&
    distanceToGround <= profile.groundProbeDistance &&
    distanceToGround >= -profile.stepUpHeight;
  const movingUp = query.verticalVelocity > 0.01;
  const grounded = withinProbe && !movingUp;

  const slopeRad = slopeAngle(here.normal);

  // Look-ahead probe for ledges and walls, in the facing direction.
  const forward = { x: Math.sin(query.yawRad), z: Math.cos(query.yawRad) };
  const aheadDistance = Math.max(profile.ledgeDetectDistance, profile.probeRadius);
  const ahead = sampleGround(
    preset,
    position.x + forward.x * aheadDistance,
    position.z + forward.z * aheadDistance,
    timeSec,
  );

  const nearLedge =
    grounded &&
    (ahead.height === null || groundHeight - ahead.height > profile.groundProbeDistance);

  const aheadRise = ahead.height === null ? 0 : ahead.height - groundHeight;

  /**
   * Steps and walls are *discontinuities*, not merely height changes. On a ramp
   * the ground under the character is already tilted and the height ahead rises
   * smoothly; on a stair or a wall the tread underfoot is flat and the height
   * ahead jumps. Without this distinction every slope reads as an endless
   * staircase, and a steep ramp reads as a wall.
   */
  const onFlatGround = slopeRad < FLAT_GROUND_EPSILON_RAD;

  const againstWall = grounded && onFlatGround && aheadRise > profile.stepUpHeight;

  const steppedUp =
    grounded && onFlatGround && aheadRise > 0 && aheadRise <= profile.stepUpHeight ? aheadRise : 0;
  const steppedDown =
    grounded &&
    onFlatGround &&
    ahead.height !== null &&
    aheadRise < 0 &&
    -aheadRise <= profile.stepUpHeight
      ? -aheadRise
      : 0;

  const penetration = grounded && distanceToGround < 0 ? -distanceToGround : 0;
  const floating = grounded && distanceToGround > 0 ? distanceToGround : 0;

  let landing: TerrainResolution['landing'] = 'none';
  if (grounded && !query.wasGrounded) {
    const impact = Math.abs(query.verticalVelocity);
    landing = impact >= profile.heavyLandingSpeed ? 'heavy' : 'light';
  }

  const sliding = grounded && slopeRad > profile.slideStartAngleRad;
  const onMovingPlatform = grounded && here.featureKind === 'moving-platform';

  // Uphill is +Z-ish rise ahead; use the sign of the ahead-sample delta so the
  // state is stable on flat ground and symmetric going up and down.
  const slopeSign = aheadRise > 0.001 ? 1 : aheadRise < -0.001 ? -1 : 0;

  const state = pickState({
    grounded,
    sliding,
    landing,
    onMovingPlatform,
    againstWall,
    nearLedge,
    steppedUp,
    steppedDown,
    slopeRad,
    slopeSign,
    maxWalkableSlopeRad: profile.maxWalkableSlopeRad,
  });

  // Uphill costs speed, downhill gains a little, scaled by the tuned factor.
  const slopeCompensation = 1 - slopeSign * slopeRad * profile.slopeSpeedCompensation;

  return {
    grounded,
    groundHeight: here.height ?? position.y,
    normal: here.normal,
    slopeRad,
    surface: here.surface,
    state,
    nearLedge,
    againstWall,
    onMovingPlatform,
    platformVelocity: onMovingPlatform
      ? {
          x: here.platformVelocity.x * profile.movingPlatformVelocityInheritance,
          y: here.platformVelocity.y * profile.movingPlatformVelocityInheritance,
          z: here.platformVelocity.z * profile.movingPlatformVelocityInheritance,
        }
      : vec3(),
    platformAngularVelocity: onMovingPlatform
      ? here.platformAngularVelocity * profile.movingPlatformRotationInheritance
      : 0,
    steppedUp,
    steppedDown,
    penetration,
    floating,
    landing,
    speedScale: Math.max(0.1, slopeCompensation * here.surface.friction),
    accelerationScale: here.surface.accelerationScale,
  };
}

interface StateInputs {
  grounded: boolean;
  sliding: boolean;
  landing: 'none' | 'light' | 'heavy';
  onMovingPlatform: boolean;
  againstWall: boolean;
  nearLedge: boolean;
  steppedUp: number;
  steppedDown: number;
  slopeRad: number;
  slopeSign: number;
  maxWalkableSlopeRad: number;
}

/**
 * Terrain states are ordered by how much they should dominate animation
 * selection: a landing beats a slope, a slide beats a step.
 */
function pickState(inputs: StateInputs): TerrainState {
  if (!inputs.grounded) return 'Airborne';
  if (inputs.landing === 'heavy') return 'LandingHeavy';
  if (inputs.landing === 'light') return 'LandingLight';
  if (inputs.sliding || inputs.slopeRad > inputs.maxWalkableSlopeRad) return 'Sliding';
  if (inputs.againstWall) return 'AgainstWall';
  if (inputs.onMovingPlatform) return 'OnMovingPlatform';
  if (inputs.steppedUp > 0) return 'SteppingUp';
  if (inputs.steppedDown > 0) return 'SteppingDown';
  if (inputs.nearLedge) return 'NearLedge';
  if (inputs.slopeSign > 0 && inputs.slopeRad > 0.05) return 'SlopeUp';
  if (inputs.slopeSign < 0 && inputs.slopeRad > 0.05) return 'SlopeDown';
  return 'Grounded';
}

/** Applies ground snapping and downhill adhesion to a proposed Y position. */
export function applyGroundSnap(
  profile: TerrainInteractionProfile,
  proposedY: number,
  groundHeight: number,
  descending: boolean,
): number {
  const strength = descending
    ? clamp01(profile.groundSnapStrength + profile.downhillAdhesion * (1 - profile.groundSnapStrength))
    : profile.groundSnapStrength;
  return proposedY + (groundHeight - proposedY) * strength;
}
