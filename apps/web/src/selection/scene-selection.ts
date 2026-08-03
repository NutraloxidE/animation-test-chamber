/**
 * What is selected in the scene — one value, for the whole application.
 *
 * The chamber used to answer "what am I looking at?" twice: a `selectedInstanceId`
 * the world panel wrote, and an `activePanel` the pseudo-hierarchy wrote. Two
 * writable answers to one question can disagree, and when they did the right-hand
 * dock showed one object's properties under another object's name.
 *
 * So there is one union here and exactly one writer for it. Everything else —
 * which instance is selected, whether the inspector shows a world or an
 * attachment — is *derived*. That is the difference between a selection model
 * and two variables that usually agree.
 *
 * This is a UI model, deliberately not a canonical schema. `attachment` in
 * particular is a projection of an equipment slot the world document already
 * owns; nothing here is written to a world file.
 */

export type SceneSelection =
  | { kind: 'world' }
  | { kind: 'instance'; instanceId: string }
  | { kind: 'attachment'; instanceId: string; slotId: string }
  | { kind: 'terrain' }
  | { kind: 'camera' };

export const WORLD_SELECTION: SceneSelection = { kind: 'world' };

/**
 * The instance a selection belongs to, or null.
 *
 * An attachment resolves to its *parent* instance rather than to nothing: the
 * viewport highlight, the camera and "which instance does this edit target"
 * all mean the same thing whether the user clicked the instance row or the
 * shield hanging off it.
 */
export function selectedInstanceId(selection: SceneSelection): string | null {
  switch (selection.kind) {
    case 'instance':
      return selection.instanceId;
    case 'attachment':
      return selection.instanceId;
    case 'world':
    case 'terrain':
    case 'camera':
      return null;
  }
}

/** Stable identity for expansion state and test ids. Never a React array index. */
export function sceneNodeKey(selection: SceneSelection): string {
  switch (selection.kind) {
    case 'world':
      return 'world';
    case 'instance':
      return `instance:${selection.instanceId}`;
    case 'attachment':
      return `attachment:${selection.instanceId}:${selection.slotId}`;
    case 'terrain':
      return 'terrain';
    case 'camera':
      return 'camera';
  }
}

export function sameSelection(a: SceneSelection, b: SceneSelection): boolean {
  return sceneNodeKey(a) === sceneNodeKey(b);
}

/**
 * Keeps a selection pointing at something that still exists.
 *
 * Deleting the selected instance must not leave the inspector rendering a
 * ghost, and the only selection guaranteed to survive any world edit is the
 * world root — so that is the fallback, rather than "whichever instance is
 * first", which would silently move the user's focus somewhere they never
 * clicked.
 */
export function reconcileSelection(
  selection: SceneSelection,
  instanceIds: readonly string[],
): SceneSelection {
  const instanceId = selectedInstanceId(selection);
  if (instanceId === null) return selection;
  return instanceIds.includes(instanceId) ? selection : WORLD_SELECTION;
}
