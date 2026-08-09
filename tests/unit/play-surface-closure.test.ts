import { describe, expect, it } from "vitest";
import type { CameraProfile } from "@atc/schema";
import { deterministicBlendWeights } from "../../apps/web/src/game-objects/animation-blend.ts";
import { authoredFollowCameraState } from "../../apps/web/src/game-runtime/camera-follow.ts";

const cameraProfile: CameraProfile = {
  id: "test-camera",
  schemaVersion: 1,
  fovDeg: 60,
  distance: 6,
  height: 2,
  lookAtHeight: 1.5,
  followLagSec: 0.1,
  minPitchRad: -1,
  maxPitchRad: 1,
};

describe("play surface closure", () => {
  it("keeps a same-take state transition at full contribution", () => {
    expect(
      deterministicBlendWeights("shared-take", "shared-take", 0.2),
    ).toEqual({
      previous: 0,
      current: 1,
    });
    expect(deterministicBlendWeights("idle", "walk", 0.2)).toEqual({
      previous: 0.8,
      current: 0.2,
    });
  });

  it("derives the initial follow orbit from the authored camera transform", () => {
    const state = authoredFollowCameraState(
      { x: 0, y: 2, z: 6 },
      { x: 0, y: 0, z: 0 },
      cameraProfile,
    );

    expect(Math.abs(state.yaw)).toBeCloseTo(Math.PI);
    expect(state.pitch).toBeCloseTo(0);
  });
});
