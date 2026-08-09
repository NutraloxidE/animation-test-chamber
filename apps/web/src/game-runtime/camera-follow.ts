import type { CameraProfile } from "@atc/schema";

export type PlayCameraState = { yaw: number; pitch: number };

export function authoredFollowCameraState(
  cameraPosition: { x: number; y: number; z: number },
  targetPosition: { x: number; y: number; z: number },
  profile: CameraProfile,
): PlayCameraState {
  const offsetX = cameraPosition.x - targetPosition.x;
  const offsetZ = cameraPosition.z - targetPosition.z;
  const verticalOffset = cameraPosition.y - (targetPosition.y + profile.height);
  return {
    yaw: Math.atan2(-offsetX, -offsetZ),
    pitch: Math.min(
      profile.maxPitchRad,
      Math.max(
        profile.minPitchRad,
        Math.asin(Math.min(1, Math.max(-1, verticalOffset / profile.distance))),
      ),
    ),
  };
}
