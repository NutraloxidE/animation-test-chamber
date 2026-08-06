/**
 * Scene Editor selection.
 *
 * One union, so that Hierarchy and Viewport cannot hold two different ideas of
 * what is selected (work package §11.3). A separately writable
 * `selectedGameObjectId` beside a `selectedScene` flag is the shape that
 * produces "the Inspector shows one thing and the outline is around another".
 *
 * ## Four identities, and why they are not one
 *
 * Clicking a lantern hanging from a character's belt has to answer four
 * different questions at once, and collapsing any two of them is a defect (§5.3):
 *
 *   instanceId   the Scene GameObject — `lantern-bearer`. This, and only this,
 *                is what a persistent Scene operation may name.
 *   nodeId       which node inside the resolved Prefab was clicked — `lantern`.
 *                Inspection only.
 *   componentId  which Component's Inspector is open — `light`.
 *   runtime id   what the renderer drew, spelled `<instanceId>/<nodeId>`. It is
 *                a *runtime* identity and appears in no document.
 *
 * The one that used to be dangerous is the last: the runtime names child nodes
 * `bearer/lantern`, and a viewport click that passed that string to
 * `scene.set_transform` would write an operation naming a GameObject that does
 * not exist — or, worse, one that a Scene happened to contain. `operationTarget`
 * is the only supported way to get from a selection to an operation, and it
 * always returns the root instance.
 *
 * Selection is *never* canonical data. Changing it must not change the
 * document, stage anything, or alter runtime behaviour (§4.3) — which is why it
 * lives here in UI state and appears in no Scene schema.
 */

export interface SceneGameObjectSelection {
  /** The Scene instance. Always the operation target. */
  instanceId: string;
  /** A node inside the resolved Prefab, when one was picked. Inspection only. */
  nodeId?: string;
  /** A Component on that node, when one was picked. Inspection only. */
  componentId?: string;
}

export type SceneSelection =
  | { kind: 'scene'; sceneId: string }
  | { kind: 'game-object'; sceneId: string; selection: SceneGameObjectSelection };

/** The Scene instance a selection is about, or `null` for the Scene root. */
export function selectedInstanceId(selection: SceneSelection): string | null {
  return selection.kind === 'game-object' ? selection.selection.instanceId : null;
}

/** The Prefab node a selection names, when it names one. Never an operation target. */
export function selectedNodeId(selection: SceneSelection): string | null {
  return selection.kind === 'game-object' ? (selection.selection.nodeId ?? null) : null;
}

/**
 * The id a *persistent* operation must name (§2.5).
 *
 * Identical to `selectedInstanceId` today, and deliberately a separate function:
 * the two answer different questions — "what is highlighted" and "what may be
 * written" — and the day a child node becomes independently addressable is the
 * day those answers diverge. A call site that reached for the highlight would
 * then start writing operations against a runtime path.
 */
export function operationTarget(selection: SceneSelection): string | null {
  return selectedInstanceId(selection);
}

/**
 * Splits a runtime node id back into its instance and node halves.
 *
 * The runtime spells a child node `<instanceId>/<nodeId>`, and the renderer
 * hands that back on click. Everything before the first slash is the Scene
 * instance; everything after is a path inside the Prefab, which may itself
 * contain slashes for a nested Prefab's nodes.
 */
export function splitRuntimeNodeId(runtimeId: string): {
  instanceId: string;
  nodeId: string | undefined;
} {
  const slash = runtimeId.indexOf('/');
  if (slash === -1) return { instanceId: runtimeId, nodeId: undefined };
  return { instanceId: runtimeId.slice(0, slash), nodeId: runtimeId.slice(slash + 1) };
}

/** The selection a viewport click on a runtime node produces. */
export function selectionForRuntimeNode(sceneId: string, runtimeId: string): SceneSelection {
  const { instanceId, nodeId } = splitRuntimeNodeId(runtimeId);
  return {
    kind: 'game-object',
    sceneId,
    selection: { instanceId, ...(nodeId === undefined ? {} : { nodeId }) },
  };
}

/** What the Asset Panel has highlighted. Deliberately *not* SceneSelection. */
export interface ScenePrefabSelection {
  prefabId: string;
  version: string;
}
