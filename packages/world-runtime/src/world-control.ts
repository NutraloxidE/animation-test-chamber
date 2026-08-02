/**
 * World-global control input.
 *
 * Movement is camera-relative: the same normalized "forward" produces a
 * different world-space direction depending on where the camera is pointing.
 * That makes camera yaw an *input to the simulation*, not a presentation
 * detail — and an input that is not recorded is an input a replay cannot
 * reproduce. The first version of world replay wrote yaw as a constant zero,
 * so a recording made while the camera turned replayed as a straight line.
 *
 * Controls are world-global rather than per-instance for the reason given in
 * `WorldRuntimeOptions`: there is one camera, and two instances sharing a view
 * must not disagree about which way forward is.
 */

export interface WorldControlKeyframe {
  tick: number;
  cameraYawRad: number;
}

/** Sampled by the world before each tick. */
export interface WorldControlSource {
  sample(tick: number): { cameraYawRad: number };
}

/**
 * A recorded control track.
 *
 * Change-only keyframes with hold semantics — the same rule intent tracks use,
 * for the same reason: a value an author (or a recorder) can point at beats a
 * value that has to be interpolated back out. Recording every tick would also
 * work and would make a 10,000-tick recording carry 10,000 identical numbers.
 */
export class RecordedControlSource implements WorldControlSource {
  private readonly frames: WorldControlKeyframe[];

  constructor(keyframes: readonly WorldControlKeyframe[]) {
    this.frames = [...keyframes].sort((a, b) => a.tick - b.tick);
  }

  sample(tick: number): { cameraYawRad: number } {
    let held = 0;
    for (const frame of this.frames) {
      if (frame.tick > tick) break;
      held = frame.cameraYawRad;
    }
    return { cameraYawRad: held };
  }
}

/** Appends a keyframe only when the value actually changed. */
export class ControlTrackRecorder {
  private readonly frames: WorldControlKeyframe[] = [];
  private previous: number | null = null;

  record(tick: number, cameraYawRad: number): void {
    if (this.previous !== null && cameraYawRad === this.previous) return;
    this.frames.push({ tick, cameraYawRad });
    this.previous = cameraYawRad;
  }

  finish(): WorldControlKeyframe[] {
    return [...this.frames];
  }
}

export interface ControlValidationIssue {
  path: string;
  message: string;
}

/**
 * Structural checks on a recorded control track.
 *
 * A replay that silently accepted a NaN yaw would produce NaN positions for
 * every instance and no indication of where they came from, so this refuses
 * rather than tolerating.
 */
export function validateControlTrack(
  keyframes: readonly WorldControlKeyframe[],
  tickCount: number,
): ControlValidationIssue[] {
  const issues: ControlValidationIssue[] = [];
  let previous = -1;

  keyframes.forEach((frame, index) => {
    const path = `/controls/cameraYaw/${index}`;
    if (!Number.isInteger(frame.tick) || frame.tick < 0) {
      issues.push({ path, message: `tick must be a non-negative integer, saw ${frame.tick}` });
    }
    if (frame.tick <= previous) {
      issues.push({
        path,
        message: `control keyframe ticks must strictly ascend (saw ${frame.tick} after ${previous})`,
      });
    }
    previous = frame.tick;
    if (frame.tick >= tickCount) {
      issues.push({
        path,
        message: `control keyframe at tick ${frame.tick} is outside tickCount ${tickCount}`,
      });
    }
    if (!Number.isFinite(frame.cameraYawRad)) {
      issues.push({ path: `${path}/cameraYawRad`, message: 'camera yaw must be finite' });
    }
  });

  return issues;
}
