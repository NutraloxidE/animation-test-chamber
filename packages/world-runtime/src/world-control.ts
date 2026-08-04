/**
 * Transitional alias for the control track, which now lives in
 * `@atc/scene-runtime`.
 *
 * The module was never World-specific — it records camera yaw, and camera yaw
 * is an input to any camera-relative simulation — so it moved rather than being
 * copied. This file keeps the old names alive for the un-migrated world tests
 * and disappears with the package around it.
 */
export {
  ControlTrackRecorder,
  RecordedControlSource,
  validateControlTrack,
  type ControlValidationIssue,
  type SceneControlKeyframe as WorldControlKeyframe,
  type SceneControlSource as WorldControlSource,
  type SceneControlState as WorldControlState,
} from '@atc/scene-runtime';
