/**
 * The seam between the play host and game-owned UI.
 *
 * Two things cross it, and nothing else. The game UI asks the host to hold the
 * simulation (a modal menu is open); the host tells the game UI where the
 * camera is looking (a compass and a threat arrow need it). Both are plain
 * mutable stores rather than React state because they are written from inside
 * the render loop, and a `setState` per frame would re-render the whole tree
 * sixty times a second to move one arrow.
 *
 * The host never learns which game is running, and the game never reaches into
 * the host's clock.
 */

export interface PauseRequest {
  /** Who asked. Keys let two reasons overlap without one clearing the other. */
  readonly reasons: Set<string>;
}

const pause: PauseRequest = { reasons: new Set<string>() };
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** Holds the whole simulation, including the match clock, until released. */
export function requestPause(reason: string, active: boolean): void {
  const had = pause.reasons.has(reason);
  if (active === had) return;
  if (active) pause.reasons.add(reason);
  else pause.reasons.delete(reason);
  notify();
}

export function isPaused(): boolean {
  return pause.reasons.size > 0;
}

export function pauseReasons(): string[] {
  return [...pause.reasons].sort();
}

export function subscribePause(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Cleared when a play surface unmounts, so a stale modal cannot wedge the next. */
export function resetPause(): void {
  if (pause.reasons.size === 0) return;
  pause.reasons.clear();
  notify();
}

const suppression = new Set<string>();

/**
 * Holds *player* input without holding the world.
 *
 * A shop that paused the match would stop the day clock and freeze nine other
 * fighters mid-swing for as long as somebody browsed. What a menu actually
 * needs is for the press that confirms a purchase not to also swing a sword,
 * so the host feeds the character a neutral frame while a menu owns the input.
 */
export function suppressGameplayInput(reason: string, active: boolean): void {
  if (active) suppression.add(reason);
  else suppression.delete(reason);
}

export function isGameplayInputSuppressed(): boolean {
  return suppression.size > 0;
}

export function resetGameplayInputSuppression(): void {
  suppression.clear();
}

export interface CameraView {
  yawRad: number;
  x: number;
  y: number;
  z: number;
}

const cameraView: CameraView = { yawRad: 0, x: 0, y: 0, z: 0 };

export function publishCameraView(next: CameraView): void {
  cameraView.yawRad = next.yawRad;
  cameraView.x = next.x;
  cameraView.y = next.y;
  cameraView.z = next.z;
}

export function readCameraView(): Readonly<CameraView> {
  return cameraView;
}
