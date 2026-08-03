/**
 * Clip Preview: sample a resolved clip, do not run the state machine.
 *
 * The old workspace called itself a preview of "this state on this instance,
 * now", and the implementation was a read-side pose substitution applied after
 * the world had already ticked. The substitution is a good design — it is what
 * makes non-persistence structural rather than a promise — but the *name* was
 * writing cheques the code never intended to cash. Nothing here executes a
 * transition, an exit time, a cancel window, a semantic event, a recovery
 * policy or root motion, and the banner says so in the UI rather than in a
 * tooltip. Runtime behaviour is the State Sandbox's job.
 *
 * The transport clock is seconds of clip time. That is the whole of the timing
 * fix: normalized time is derived from it and the clip's authored duration, so
 * `speed = 1` finally means what the label always claimed.
 */

export type ClipPreviewSource =
  | { kind: 'state'; layer: 'locomotion' | 'action'; stateId: string }
  | { kind: 'clip'; clipId: string };

export interface ClipPreviewState {
  source: ClipPreviewSource | null;
  playing: boolean;
  loop: boolean;
  speed: number;
  /** Primary transport value. Normalized time is always derived from this. */
  timeSec: number;
}

export const NO_CLIP_PREVIEW: ClipPreviewState = {
  source: null,
  playing: false,
  loop: true,
  speed: 1,
  timeSec: 0,
};

/** Transport speeds outside this range are rejected rather than propagated. */
export const MIN_PREVIEW_SPEED = 0;
export const MAX_PREVIEW_SPEED = 4;

export function clampPreviewSpeed(speed: number): number {
  if (!Number.isFinite(speed)) return 1;
  return Math.max(MIN_PREVIEW_SPEED, Math.min(speed, MAX_PREVIEW_SPEED));
}

export function clampPreviewTime(timeSec: number, durationSec: number): number {
  if (!Number.isFinite(timeSec)) return 0;
  if (!(durationSec > 0)) return 0;
  return Math.max(0, Math.min(timeSec, durationSec));
}

export function normalizedPreviewTime(timeSec: number, durationSec: number): number {
  if (!(durationSec > 0)) return 0;
  return Math.max(0, Math.min(timeSec / durationSec, 1));
}

export interface PreviewAdvance {
  timeSec: number;
  playing: boolean;
}

/**
 * One transport step, in seconds of clip time.
 *
 * Shared with the engine's per-frame advance so the number the panel reads and
 * the number the renderer poses from cannot drift: a second implementation of
 * "where is the playhead" is a second answer to it.
 */
export function advancePreviewTime(
  current: PreviewAdvance & { loop: boolean; speed: number },
  durationSec: number,
  deltaSec: number,
): PreviewAdvance {
  if (!current.playing) return { timeSec: current.timeSec, playing: current.playing };
  if (!(durationSec > 0) || !Number.isFinite(deltaSec)) {
    return { timeSec: current.timeSec, playing: current.playing };
  }
  const next = current.timeSec + deltaSec * clampPreviewSpeed(current.speed);
  if (next < durationSec) return { timeSec: next, playing: true };
  if (current.loop) return { timeSec: next % durationSec, playing: true };
  return { timeSec: durationSec, playing: false };
}

/** `0.18 s / 0.43 s` — the readout that makes a duration bug visible. */
export function formatPreviewTime(timeSec: number, durationSec: number): string {
  return `${timeSec.toFixed(2)} s / ${durationSec.toFixed(2)} s`;
}

export function sourceKey(source: ClipPreviewSource | null): string {
  if (!source) return '';
  return source.kind === 'state' ? `state:${source.layer}:${source.stateId}` : `clip:${source.clipId}`;
}
