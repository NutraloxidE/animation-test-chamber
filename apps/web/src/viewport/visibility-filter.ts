/**
 * What the viewport draws — as a filter, not as a second renderer.
 *
 * "Isolate" used to be a different code path: `world` drew the multi-instance
 * scene through `WorldViewport`, `isolate-selection` drew one character through
 * the legacy focused `Viewport`, and a feature attached to one engine was
 * invisible in the other. The Clip Preview override was attached to the world
 * engine, so the panel had to tell the user to switch to World view to see the
 * thing they had just pressed Play on — in the presentation where inspecting
 * one character's animation is *easiest*, which is exactly backwards.
 *
 * Isolate is a visibility filter. That is all it ever meant.
 */

export type VisibilityFilter =
  | { kind: 'all' }
  | { kind: 'instance'; instanceId: string };

export const SHOW_ALL: VisibilityFilter = { kind: 'all' };

export function isVisible(filter: VisibilityFilter, instanceId: string): boolean {
  return filter.kind === 'all' || filter.instanceId === instanceId;
}
