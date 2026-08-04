/**
 * Scene Editor selection.
 *
 * One union, so that Hierarchy and Viewport cannot hold two different ideas of
 * what is selected (work package §11.3). A separately writable
 * `selectedEntityId` beside a `selectedScene` flag is the shape that produces
 * "the Inspector shows one thing and the outline is around another".
 *
 * Selection is *never* canonical data. Changing it must not change the
 * document, stage anything, or alter runtime behaviour (§4.3) — which is why it
 * lives here in UI state and appears in no Scene schema.
 */

export type SceneSelection =
  | { kind: 'scene'; sceneId: string }
  | { kind: 'entity'; sceneId: string; entityId: string };

export function selectedEntityId(selection: SceneSelection): string | null {
  return selection.kind === 'entity' ? selection.entityId : null;
}

/** What the Asset Panel has highlighted. Deliberately *not* SceneSelection. */
export type SceneAssetSelection =
  | { kind: 'character'; characterId: string }
  | { kind: 'prop'; assetId: string }
  | { kind: 'model'; assetPath: string }
  | { kind: 'create-light'; lightType: 'directional' | 'point' | 'spot' }
  | { kind: 'create-camera' };
