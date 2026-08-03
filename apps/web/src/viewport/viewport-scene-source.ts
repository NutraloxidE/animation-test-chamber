/**
 * Where the poses the viewport draws come from.
 *
 * Three sources, one renderer. The alternative — which is what this replaces —
 * is a renderer per source, and the cost of that is not duplication so much as
 * *divergence*: materials, rig binding, camera behaviour and overlays drift
 * apart, and then "it looks wrong in Isolate" becomes a real bug class rather
 * than an impossible one.
 */

export type ViewportSceneSource =
  | { kind: 'live-world' }
  /**
   * The live world, with one instance's pose substituted on the read side.
   * Still the live world: Clip Preview does not replace the scene, it replaces
   * one layer of one character's pose on its way to the renderer.
   */
  | { kind: 'clip-preview'; targetInstanceId: string }
  /** A separate simulation's pose. Nothing in the live world is drawn from it. */
  | { kind: 'state-sandbox' };

export const LIVE_WORLD: ViewportSceneSource = { kind: 'live-world' };
