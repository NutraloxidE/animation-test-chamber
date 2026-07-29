/** Simulation runs at a fixed 60Hz regardless of render rate (PLAN 3.2). */
export const FIXED_HZ = 60;
export const FIXED_DT = 1 / FIXED_HZ;

/** Never advance more than this many sim ticks per rendered frame. */
export const MAX_TICKS_PER_FRAME = 8;

/**
 * Decouples render frames from logic ticks. The renderer feeds real elapsed
 * time; the caller receives a whole number of fixed steps plus the leftover
 * alpha for interpolation, so 30/60/120fps produce identical logic.
 */
export class FixedStepAccumulator {
  private accumulator = 0;
  private droppedTicks = 0;

  /** Ticks intentionally skipped, for frame-drop injection tests. */
  private pendingSkips = 0;

  constructor(private readonly dt: number = FIXED_DT) {}

  /** Injects a deliberate hitch: the next `count` ticks are discarded. */
  injectFrameDrop(count: number): void {
    this.pendingSkips += Math.max(0, Math.floor(count));
  }

  /** Returns how many fixed steps should run for `elapsedSec` of real time. */
  advance(elapsedSec: number): number {
    // Guard against tab-restore spikes producing a spiral of death.
    this.accumulator += Math.min(Math.max(elapsedSec, 0), MAX_TICKS_PER_FRAME * this.dt);
    let ticks = 0;
    while (this.accumulator >= this.dt && ticks < MAX_TICKS_PER_FRAME) {
      this.accumulator -= this.dt;
      if (this.pendingSkips > 0) {
        this.pendingSkips -= 1;
        this.droppedTicks += 1;
        continue;
      }
      ticks += 1;
    }
    return ticks;
  }

  /** Interpolation factor in [0,1) between the last and next tick. */
  get alpha(): number {
    return this.accumulator / this.dt;
  }

  get dropped(): number {
    return this.droppedTicks;
  }

  reset(): void {
    this.accumulator = 0;
    this.droppedTicks = 0;
    this.pendingSkips = 0;
  }
}

export function ticksToSeconds(ticks: number): number {
  return ticks * FIXED_DT;
}

export function secondsToTicks(seconds: number): number {
  return Math.round(seconds * FIXED_HZ);
}

export function msToTicks(ms: number): number {
  return Math.round((ms / 1000) * FIXED_HZ);
}
