/**
 * The production Scene operations (§8).
 *
 * Thirteen operations over `scene.gameObjects`, and the same thirteen whether
 * they were dispatched by a gizmo drag, an Inspector field, a drop from the
 * Asset Panel, an AI command or a `curl`. What they replace is the entity union
 * next door in `operations.ts`, and the replacement is not a rename:
 *
 *   scene.place_asset          four payload branches, one per entity kind
 *   scene.place_prefab         one payload, naming an exact Prefab version
 *
 *   scene.set_character_source only meaningful on a character
 *   scene.bind_controller      only meaningful on a character
 *   scene.set_prefab_source    meaningful on anything
 *   scene.set_instance_binding meaningful on anything with a motor to bind
 *
 * There is no `kind` anywhere below, and that absence is the contract: what an
 * object can do comes from the Components its resolved Prefab carries, which is
 * what `PrefabCapabilities` answers.
 *
 * Every function here is pure. It does not mutate its input, it reads no clock
 * and no registry of its own, and it returns issues rather than throwing — a
 * refused drop has to explain itself next to the thing that was dropped, and an
 * exception cannot.
 */
import type {
  GameObjectInstanceDefinition,
  GameObjectPrefabReference,
  GameObjectSceneOperation,
  SceneDefinition,
  TransformDefinition,
  ValidationIssue,
} from '@atc/schema';
import {
  prefabReferenceKey,
  validateAgainst,
  validateSceneGameObjectReferences,
} from '@atc/schema';
import type { PrefabCapabilities } from '@atc/prefab-runtime';
import { defaultPlacementTransform, type OperationResult } from './operations.ts';

export type { GameObjectSceneOperation } from '@atc/schema';

/**
 * Every operation type the union declares, for naming an unknown one.
 *
 * Three of these names — `scene.set_transform`, `scene.set_enabled`,
 * `scene.set_active_camera` — are shared with the retired entity union, and
 * their payloads are not. That is deliberate and it is safe, because the
 * *field* differs: an entity operation carries `entityId`, a GameObject
 * operation carries `gameObjectId`, and `additionalProperties: false` makes
 * each refuse the other's shape outright rather than half-understanding it.
 */
export const SCENE_GAME_OBJECT_OPERATION_TYPES = [
  'scene.place_prefab',
  'scene.delete_game_object',
  'scene.duplicate_game_object',
  'scene.rename_game_object',
  'scene.set_transform',
  'scene.set_enabled',
  'scene.set_prefab_source',
  'scene.set_component_override',
  'scene.clear_component_override',
  'scene.set_instance_binding',
  'scene.set_relation',
  'scene.reorder_game_object',
  'scene.set_active_camera',
] as const;

/**
 * What the engine needs to know that a Scene document cannot tell it.
 *
 * `knownPrefabKeys` is the exact-reference set (§8.2): `assetId@version#hash`.
 * An operation naming a Prefab outside it is refused rather than resolved to
 * "latest", because "latest" is a value that changes without anybody editing
 * the Scene — and a Scene that silently moved onto a Prefab version nobody
 * approved is the failure exact references exist to prevent.
 *
 * `capabilities` is optional so the engine still runs where no registry is in
 * hand — a unit test of pure reordering, say. Where it is absent the
 * capability-dependent refusals cannot be made, so the callers that must make
 * them (the editor session and the apply endpoint) always supply it.
 */
export interface SceneGameObjectOperationContext {
  knownPrefabKeys: ReadonlySet<string>;
  capabilities?: (reference: GameObjectPrefabReference) => PrefabCapabilities | undefined;
}

/**
 * The exact-reference key a `knownPrefabKeys` set is built from.
 *
 * `prefabReferenceKey` stops at `type:id@version`; this appends the content
 * hash, because two references that agree on the version and disagree on the
 * hash name two different documents, and treating them as one is precisely the
 * drift exact references exist to catch (§8.2).
 */
export function exactPrefabReferenceKey(reference: GameObjectPrefabReference): string {
  return `${prefabReferenceKey(reference)}#${reference.contentHash}`;
}

/**
 * Validates one untrusted value as a `GameObjectSceneOperation`.
 *
 * The `type` is checked by hand *before* the schema, for the reason its entity
 * twin does: a union of thirteen closed objects reports an unknown `type` as
 * thirteen simultaneous failures, none of which say the useful thing. An
 * operation the server does not implement has to be refused by name — a caller
 * that sent `scene.delete_entity` needs to read that word back, together with
 * what it should have sent instead.
 */
export function parseSceneGameObjectOperation(
  value: unknown,
):
  | { ok: true; operation: GameObjectSceneOperation }
  | { ok: false; issues: ValidationIssue[] } {
  const type = (value as { type?: unknown } | null)?.type;
  if (
    typeof type !== 'string' ||
    !(SCENE_GAME_OBJECT_OPERATION_TYPES as readonly string[]).includes(type)
  ) {
    return {
      ok: false,
      issues: [
        {
          path: '/type',
          message:
            `unknown operation type ${JSON.stringify(type)}; expected one of ` +
            `${SCENE_GAME_OBJECT_OPERATION_TYPES.join(', ')}. Scene edits address ` +
            'GameObjects; the entity operations are no longer applied.',
          keyword: 'unsupported',
        },
      ],
    };
  }

  const result = validateAgainst('GameObjectSceneOperation', value);
  if (!result.valid) {
    // Only the failures of the member that matched this `type` are interesting;
    // the other twelve failed on the discriminator alone.
    const issues = result.issues.filter((issue) => issue.path !== '/type');
    return { ok: false, issues: issues.length > 0 ? issues : result.issues };
  }
  return { ok: true, operation: value as GameObjectSceneOperation };
}

function fail(path: string, message: string, keyword = 'operation'): OperationResult<never> {
  return { ok: false, issues: [{ path, message, keyword }] };
}

const gameObjectsOf = (scene: SceneDefinition): GameObjectInstanceDefinition[] => [
  ...(scene.gameObjects ?? []),
];

/**
 * Applies one operation to a Scene, returning the result rather than mutating.
 *
 * Only `gameObjects`, `activeCameraGameObjectId` and the Scene's own fields are
 * ever touched. `entities` is passed through by identity — not rebuilt, not
 * regenerated, not reconciled (§9.1). That is what makes "no production edit
 * writes entities" a property of this function rather than a habit of its
 * callers, and it is asserted byte-for-byte by the operation tests.
 */
export function applySceneGameObjectOperation(
  scene: SceneDefinition,
  operation: GameObjectSceneOperation,
  context: SceneGameObjectOperationContext,
): OperationResult<SceneDefinition> {
  switch (operation.type) {
    case 'scene.place_prefab':
      return placePrefab(scene, operation, context);

    case 'scene.delete_game_object':
      return deleteGameObject(scene, operation.gameObjectId);

    case 'scene.duplicate_game_object':
      return duplicateGameObject(scene, operation.gameObjectId);

    case 'scene.rename_game_object':
      return withGameObject(scene, operation.gameObjectId, (gameObject) => ({
        gameObject: { ...gameObject, displayName: operation.displayName },
        paths: [`/gameObjects/${operation.gameObjectId}/displayName`],
      }));

    case 'scene.set_transform': {
      const issues = transformIssues(
        operation.transform,
        `/gameObjects/${operation.gameObjectId}/transform`,
      );
      if (issues.length > 0) return { ok: false, issues };
      return withGameObject(scene, operation.gameObjectId, (gameObject) => ({
        gameObject: { ...gameObject, transform: operation.transform },
        paths: [`/gameObjects/${operation.gameObjectId}/transform`],
      }));
    }

    case 'scene.set_enabled':
      return setEnabled(scene, operation.gameObjectId, operation.enabled);

    case 'scene.set_prefab_source':
      return setPrefabSource(scene, operation.gameObjectId, operation.prefab, context);

    case 'scene.set_component_override':
      return setComponentOverride(scene, operation, context);

    case 'scene.clear_component_override':
      return clearComponentOverride(scene, operation);

    case 'scene.set_instance_binding':
      return setInstanceBinding(scene, operation, context);

    case 'scene.set_relation':
      return setRelation(scene, operation, context);

    case 'scene.reorder_game_object':
      return reorderGameObject(scene, operation.gameObjectId, operation.toIndex);

    case 'scene.set_active_camera':
      return setActiveCamera(scene, operation.gameObjectId, context);
  }
}

/**
 * Which GameObject ids one operation's result differs from the input in.
 *
 * Derived from the *actual* documents rather than declared by each branch, so a
 * branch that forgot to name what it touched cannot under-report. The apply
 * endpoint returns this to the caller (§9.4), and a response that named the
 * wrong ids would be worse than one that named none.
 */
export function changedGameObjectIds(
  before: SceneDefinition,
  after: SceneDefinition,
): string[] {
  const previous = new Map(
    (before.gameObjects ?? []).map((gameObject) => [gameObject.id, gameObject]),
  );
  const next = new Map((after.gameObjects ?? []).map((gameObject) => [gameObject.id, gameObject]));
  const changed = new Set<string>();

  for (const [id, gameObject] of next) {
    const was = previous.get(id);
    if (!was || JSON.stringify(was) !== JSON.stringify(gameObject)) changed.add(id);
  }
  for (const id of previous.keys()) if (!next.has(id)) changed.add(id);

  /*
   * A reorder changes no object's own bytes, and it is still a change to every
   * object involved: declaration order *is* tick and draw order. Reporting an
   * empty list for it would tell a caller that reordering does nothing.
   *
   * Compared over the *surviving* objects only. Comparing the raw key lists
   * would make every placement and every deletion look like a reorder too —
   * appending one object at the end changes the list without moving anything —
   * and the response would then name every object in the Scene for an operation
   * that touched one.
   */
  const survivors = (ids: Iterable<string>): string[] =>
    [...ids].filter((id) => previous.has(id) && next.has(id));
  const previousOrder = survivors(previous.keys()).join(',');
  const nextOrder = survivors(next.keys()).join(',');
  if (previousOrder !== nextOrder) {
    for (const id of next.keys()) changed.add(id);
  }

  return [...changed].sort();
}

function ok(
  scene: SceneDefinition,
  changedPaths: string[],
): OperationResult<SceneDefinition> {
  /*
   * Every operation validates its *result*, not just its input. An operation
   * that only checked what it was given can still produce an invalid document
   * by interacting with what was already there — disabling the object the
   * active camera names is the obvious one — and discovering that at Apply time
   * means the human learns about it several edits later.
   */
  const validation = validateSceneGameObjectReferences(scene);
  if (!validation.valid) return { ok: false, issues: validation.issues };
  return { ok: true, issues: [], document: scene, changedPaths };
}

function placePrefab(
  scene: SceneDefinition,
  operation: Extract<GameObjectSceneOperation, { type: 'scene.place_prefab' }>,
  context: SceneGameObjectOperationContext,
): OperationResult<SceneDefinition> {
  const gameObjects = gameObjectsOf(scene);
  if (gameObjects.some((gameObject) => gameObject.id === operation.gameObjectId)) {
    return fail(
      `/gameObjects/${operation.gameObjectId}`,
      `GameObject id "${operation.gameObjectId}" already exists`,
      'unique',
    );
  }

  const reference = prefabIssue(operation.prefab, context, `/gameObjects/${operation.gameObjectId}/prefab`);
  if (reference) return { ok: false, issues: [reference] };

  const capabilities = context.capabilities?.(operation.prefab);
  if (capabilities?.abstract) {
    return fail(
      `/gameObjects/${operation.gameObjectId}/prefab`,
      `Prefab "${operation.prefab.assetId}@${operation.prefab.version}" is abstract and cannot be placed`,
      'abstract',
    );
  }

  const transform = operation.transform ?? defaultPlacementTransform();
  const issues = transformIssues(transform, `/gameObjects/${operation.gameObjectId}/transform`);
  if (issues.length > 0) return { ok: false, issues };

  /*
   * A newly placed object opens unbound and unrelated. Defaulting a character
   * to "player 0" would mean an ordinary drop silently stole the human
   * controller from whichever object already had it — a change nothing in the
   * gesture suggests, discovered later as a character that stopped responding.
   */
  const placed: GameObjectInstanceDefinition = {
    schemaVersion: scene.schemaVersion,
    id: operation.gameObjectId,
    displayName: operation.displayName,
    enabled: true,
    prefab: operation.prefab,
    transform,
    componentOverrides: [],
    bindings: {},
    relations: {},
  };

  return ok(
    { ...scene, gameObjects: [...gameObjects, placed] },
    [`/gameObjects/${operation.gameObjectId}`],
  );
}

/**
 * Deleting refuses while anything still points at the object (§8.3).
 *
 * Refusal rather than a cascade, and the difference matters: cascading would
 * mean deleting one object silently un-aims somebody else's camera, and the
 * human who pressed Delete on a prop would have no way to know a camera
 * elsewhere in the Scene had changed. The active camera is the one exception —
 * "the Scene plays through this" is a property *of the Scene*, and clearing it
 * is visible in the Scene Inspector the deletion happened in.
 */
function deleteGameObject(
  scene: SceneDefinition,
  gameObjectId: string,
): OperationResult<SceneDefinition> {
  const gameObjects = gameObjectsOf(scene);
  if (!gameObjects.some((gameObject) => gameObject.id === gameObjectId)) {
    return fail(`/gameObjects/${gameObjectId}`, `no GameObject "${gameObjectId}"`, 'reference');
  }

  const holders = gameObjects.filter(
    (gameObject) =>
      gameObject.id !== gameObjectId &&
      gameObject.relations.cameraTargetGameObjectId === gameObjectId,
  );
  if (holders.length > 0) {
    return fail(
      `/gameObjects/${gameObjectId}`,
      `GameObject "${gameObjectId}" cannot be deleted: ` +
        `${holders.map((holder) => `"${holder.id}"`).join(', ')} ` +
        `${holders.length === 1 ? 'targets' : 'target'} it. Clear the relation first.`,
      'reference',
    );
  }

  const next: SceneDefinition = {
    ...scene,
    gameObjects: gameObjects.filter((gameObject) => gameObject.id !== gameObjectId),
    ...(scene.activeCameraGameObjectId === gameObjectId
      ? { activeCameraGameObjectId: undefined }
      : {}),
  };
  return ok(next, [`/gameObjects/${gameObjectId}`]);
}

/**
 * Duplicating copies the placement, not the relationships (§7.3).
 *
 * The Prefab reference, transform, enabled flag, component overrides and
 * bindings come along; the camera relation deliberately does not. Two cameras
 * following one character is a thing somebody might want and never a thing
 * duplication should decide for them — and unlike the other fields, a copied
 * relation changes what the *other* object is involved in.
 */
function duplicateGameObject(
  scene: SceneDefinition,
  gameObjectId: string,
): OperationResult<SceneDefinition> {
  const gameObjects = gameObjectsOf(scene);
  const source = gameObjects.find((gameObject) => gameObject.id === gameObjectId);
  if (!source) {
    return fail(`/gameObjects/${gameObjectId}`, `no GameObject "${gameObjectId}"`, 'reference');
  }

  const newId = uniqueGameObjectId(`${gameObjectId}-copy`, gameObjects);
  const copy: GameObjectInstanceDefinition = {
    ...source,
    id: newId,
    displayName: `${source.displayName} copy`,
    componentOverrides: source.componentOverrides.map((override) => ({ ...override })),
    bindings: { ...source.bindings },
    relations: {},
  };

  const index = gameObjects.findIndex((gameObject) => gameObject.id === gameObjectId);
  gameObjects.splice(index + 1, 0, copy);
  return ok({ ...scene, gameObjects }, [`/gameObjects/${newId}`]);
}

/**
 * Disabling clears the active camera when it names this object.
 *
 * The alternative is a Scene whose active camera is disabled, which validation
 * refuses — so without this, "hide that camera for a moment" would be an
 * operation the engine had to reject for a reason the human did not connect to
 * the checkbox they just clicked.
 */
function setEnabled(
  scene: SceneDefinition,
  gameObjectId: string,
  enabled: boolean,
): OperationResult<SceneDefinition> {
  const gameObjects = gameObjectsOf(scene);
  if (!gameObjects.some((gameObject) => gameObject.id === gameObjectId)) {
    return fail(`/gameObjects/${gameObjectId}`, `no GameObject "${gameObjectId}"`, 'reference');
  }
  const paths = [`/gameObjects/${gameObjectId}/enabled`];
  const clearsCamera = !enabled && scene.activeCameraGameObjectId === gameObjectId;
  if (clearsCamera) paths.push('/activeCameraGameObjectId');

  return ok(
    {
      ...scene,
      gameObjects: gameObjects.map((gameObject) =>
        gameObject.id === gameObjectId ? { ...gameObject, enabled } : gameObject,
      ),
      ...(clearsCamera ? { activeCameraGameObjectId: undefined } : {}),
    },
    paths,
  );
}

/**
 * Pointing an instance at a different Prefab clears incompatible overrides
 * (§7.2).
 *
 * An override addresses a `nodeId` and a `componentId`, and both identities
 * belong to the graph of the Prefab that had them. Carried across to a
 * different Prefab they would either dangle — an override for a node that does
 * not exist — or, far worse, land on a node that happens to share an id and
 * silently patch something nobody meant. Overrides whose targets survive are
 * kept; the rest are dropped, and the UI states that before applying.
 */
function setPrefabSource(
  scene: SceneDefinition,
  gameObjectId: string,
  prefab: GameObjectPrefabReference,
  context: SceneGameObjectOperationContext,
): OperationResult<SceneDefinition> {
  const gameObjects = gameObjectsOf(scene);
  const source = gameObjects.find((gameObject) => gameObject.id === gameObjectId);
  if (!source) {
    return fail(`/gameObjects/${gameObjectId}`, `no GameObject "${gameObjectId}"`, 'reference');
  }

  const unknown = prefabIssue(prefab, context, `/gameObjects/${gameObjectId}/prefab`);
  if (unknown) return { ok: false, issues: [unknown] };

  const capabilities = context.capabilities?.(prefab);
  if (capabilities?.abstract) {
    return fail(
      `/gameObjects/${gameObjectId}/prefab`,
      `Prefab "${prefab.assetId}@${prefab.version}" is abstract and cannot be placed`,
      'abstract',
    );
  }

  const kept = capabilities
    ? source.componentOverrides.filter((override) =>
        capabilities.nodes.some(
          (node) =>
            node.nodeId === override.nodeId &&
            node.componentIds.includes(override.componentId),
        ),
      )
    : source.componentOverrides;

  const paths = [`/gameObjects/${gameObjectId}/prefab`];
  if (kept.length !== source.componentOverrides.length) {
    paths.push(`/gameObjects/${gameObjectId}/componentOverrides`);
  }

  /*
   * A binding or a relation the new Prefab cannot support goes with the
   * overrides. Keeping a `characterIntent` on a Prefab with no motor would
   * produce a Scene that fails resolution, which is a refusal arriving one
   * screen too late.
   */
  const bindings =
    capabilities && !capabilities.hasCharacterMotor ? {} : { ...source.bindings };
  if (JSON.stringify(bindings) !== JSON.stringify(source.bindings)) {
    paths.push(`/gameObjects/${gameObjectId}/bindings`);
  }
  const relations = capabilities && !capabilities.hasCamera ? {} : { ...source.relations };
  if (JSON.stringify(relations) !== JSON.stringify(source.relations)) {
    paths.push(`/gameObjects/${gameObjectId}/relations`);
  }

  return ok(
    {
      ...scene,
      gameObjects: gameObjects.map((gameObject) =>
        gameObject.id === gameObjectId
          ? { ...gameObject, prefab, componentOverrides: kept, bindings, relations }
          : gameObject,
      ),
    },
    paths,
  );
}

/**
 * Which overrides a Prefab source change would drop.
 *
 * Exported so the confirmation UI can *state* it before applying (§7.2), from
 * the same computation the operation performs. A dialog that listed a different
 * set than the operation drops would be worse than no dialog.
 */
export function overridesClearedByPrefabSourceChange(
  gameObject: GameObjectInstanceDefinition,
  capabilities: PrefabCapabilities | undefined,
): { nodeId: string; componentId: string }[] {
  if (!capabilities) return [];
  return gameObject.componentOverrides
    .filter(
      (override) =>
        !capabilities.nodes.some(
          (node) =>
            node.nodeId === override.nodeId && node.componentIds.includes(override.componentId),
        ),
    )
    .map((override) => ({ nodeId: override.nodeId, componentId: override.componentId }));
}

/**
 * An override addresses one Component on one node, and is checked against the
 * resolved Prefab (§8.5).
 *
 * Not an arbitrary JSON Pointer write into the Prefab: an override that could
 * name any path could rewrite the shared asset's structure from one placement,
 * which is exactly the sharing the definition/instance split protects.
 */
function setComponentOverride(
  scene: SceneDefinition,
  operation: Extract<GameObjectSceneOperation, { type: 'scene.set_component_override' }>,
  context: SceneGameObjectOperationContext,
): OperationResult<SceneDefinition> {
  const gameObjects = gameObjectsOf(scene);
  const source = gameObjects.find((gameObject) => gameObject.id === operation.gameObjectId);
  if (!source) {
    return fail(
      `/gameObjects/${operation.gameObjectId}`,
      `no GameObject "${operation.gameObjectId}"`,
      'reference',
    );
  }

  const capabilities = context.capabilities?.(source.prefab);
  const base = `/gameObjects/${operation.gameObjectId}/componentOverrides`;
  if (capabilities) {
    const node = capabilities.nodes.find((entry) => entry.nodeId === operation.override.nodeId);
    if (!node) {
      return fail(
        `${base}/${operation.override.nodeId}`,
        `Prefab "${source.prefab.assetId}@${source.prefab.version}" has no node "${operation.override.nodeId}"`,
        'reference',
      );
    }
    if (!node.componentIds.includes(operation.override.componentId)) {
      return fail(
        `${base}/${operation.override.nodeId}/${operation.override.componentId}`,
        `node "${operation.override.nodeId}" has no Component "${operation.override.componentId}"`,
        'reference',
      );
    }
  }

  const others = source.componentOverrides.filter(
    (override) =>
      !(
        override.nodeId === operation.override.nodeId &&
        override.componentId === operation.override.componentId
      ),
  );

  return ok(
    {
      ...scene,
      gameObjects: gameObjects.map((gameObject) =>
        gameObject.id === operation.gameObjectId
          ? { ...gameObject, componentOverrides: [...others, operation.override] }
          : gameObject,
      ),
    },
    [`${base}/${operation.override.nodeId}/${operation.override.componentId}`],
  );
}

function clearComponentOverride(
  scene: SceneDefinition,
  operation: Extract<GameObjectSceneOperation, { type: 'scene.clear_component_override' }>,
): OperationResult<SceneDefinition> {
  const gameObjects = gameObjectsOf(scene);
  const source = gameObjects.find((gameObject) => gameObject.id === operation.gameObjectId);
  if (!source) {
    return fail(
      `/gameObjects/${operation.gameObjectId}`,
      `no GameObject "${operation.gameObjectId}"`,
      'reference',
    );
  }
  const base = `/gameObjects/${operation.gameObjectId}/componentOverrides`;
  const remaining = source.componentOverrides.filter(
    (override) =>
      !(override.nodeId === operation.nodeId && override.componentId === operation.componentId),
  );
  if (remaining.length === source.componentOverrides.length) {
    return fail(
      `${base}/${operation.nodeId}/${operation.componentId}`,
      `GameObject "${operation.gameObjectId}" has no override for "${operation.nodeId}/${operation.componentId}"`,
      'reference',
    );
  }

  return ok(
    {
      ...scene,
      gameObjects: gameObjects.map((gameObject) =>
        gameObject.id === operation.gameObjectId
          ? { ...gameObject, componentOverrides: remaining }
          : gameObject,
      ),
    },
    [`${base}/${operation.nodeId}/${operation.componentId}`],
  );
}

function setInstanceBinding(
  scene: SceneDefinition,
  operation: Extract<GameObjectSceneOperation, { type: 'scene.set_instance_binding' }>,
  context: SceneGameObjectOperationContext,
): OperationResult<SceneDefinition> {
  const gameObjects = gameObjectsOf(scene);
  const source = gameObjects.find((gameObject) => gameObject.id === operation.gameObjectId);
  if (!source) {
    return fail(
      `/gameObjects/${operation.gameObjectId}`,
      `no GameObject "${operation.gameObjectId}"`,
      'reference',
    );
  }

  const capabilities = context.capabilities?.(source.prefab);
  if (operation.bindings.characterIntent && capabilities && !capabilities.hasCharacterMotor) {
    return fail(
      `/gameObjects/${operation.gameObjectId}/bindings/characterIntent`,
      `GameObject "${operation.gameObjectId}" resolves to a Prefab with no character-motor to drive`,
      'capability',
    );
  }

  return ok(
    {
      ...scene,
      gameObjects: gameObjects.map((gameObject) =>
        gameObject.id === operation.gameObjectId
          ? { ...gameObject, bindings: operation.bindings }
          : gameObject,
      ),
    },
    [`/gameObjects/${operation.gameObjectId}/bindings`],
  );
}

function setRelation(
  scene: SceneDefinition,
  operation: Extract<GameObjectSceneOperation, { type: 'scene.set_relation' }>,
  context: SceneGameObjectOperationContext,
): OperationResult<SceneDefinition> {
  const gameObjects = gameObjectsOf(scene);
  const source = gameObjects.find((gameObject) => gameObject.id === operation.gameObjectId);
  if (!source) {
    return fail(
      `/gameObjects/${operation.gameObjectId}`,
      `no GameObject "${operation.gameObjectId}"`,
      'reference',
    );
  }

  const target = operation.relations.cameraTargetGameObjectId;
  const capabilities = context.capabilities?.(source.prefab);
  if (target !== undefined && capabilities && !capabilities.hasCamera) {
    return fail(
      `/gameObjects/${operation.gameObjectId}/relations/cameraTargetGameObjectId`,
      `GameObject "${operation.gameObjectId}" resolves to a Prefab with no camera to aim`,
      'capability',
    );
  }
  if (target === operation.gameObjectId) {
    return fail(
      `/gameObjects/${operation.gameObjectId}/relations/cameraTargetGameObjectId`,
      `GameObject "${operation.gameObjectId}" cannot follow itself`,
      'reference',
    );
  }

  return ok(
    {
      ...scene,
      gameObjects: gameObjects.map((gameObject) =>
        gameObject.id === operation.gameObjectId
          ? { ...gameObject, relations: operation.relations }
          : gameObject,
      ),
    },
    [`/gameObjects/${operation.gameObjectId}/relations`],
  );
}

/**
 * Reordering changes declaration order and nothing else (§8.4).
 *
 * Relations are id-based, so they survive untouched — which is the property
 * that makes reordering safe at all. An index-based relation would break on
 * every reorder, and reordering is a first-class Scene operation.
 */
function reorderGameObject(
  scene: SceneDefinition,
  gameObjectId: string,
  toIndex: number,
): OperationResult<SceneDefinition> {
  const gameObjects = gameObjectsOf(scene);
  const from = gameObjects.findIndex((gameObject) => gameObject.id === gameObjectId);
  if (from === -1) {
    return fail(`/gameObjects/${gameObjectId}`, `no GameObject "${gameObjectId}"`, 'reference');
  }
  if (!Number.isInteger(toIndex) || toIndex < 0 || toIndex >= gameObjects.length) {
    return fail('/gameObjects', `target index ${toIndex} is outside the scene`, 'range');
  }

  const [moved] = gameObjects.splice(from, 1);
  gameObjects.splice(toIndex, 0, moved!);
  // Declaration order *is* tick and draw order, so a reorder is a semantic
  // change to the whole list rather than to one object — hence the list path.
  return ok({ ...scene, gameObjects }, ['/gameObjects']);
}

/**
 * Only an enabled GameObject that resolves to a Camera Component may become the
 * active camera (§7.4).
 *
 * All three refusals happen before any write. A Scene that plays through an
 * object with no camera has no viewpoint at all, and discovering that at load
 * time — as a black frame — is the outcome this check exists to prevent.
 */
function setActiveCamera(
  scene: SceneDefinition,
  gameObjectId: string | null,
  context: SceneGameObjectOperationContext,
): OperationResult<SceneDefinition> {
  if (gameObjectId === null) {
    return ok({ ...scene, activeCameraGameObjectId: undefined }, ['/activeCameraGameObjectId']);
  }

  const target = gameObjectsOf(scene).find((gameObject) => gameObject.id === gameObjectId);
  if (!target) {
    return fail('/activeCameraGameObjectId', `no GameObject "${gameObjectId}"`, 'reference');
  }
  if (!target.enabled) {
    return fail(
      '/activeCameraGameObjectId',
      `GameObject "${gameObjectId}" is disabled and cannot be the active camera`,
      'enabled',
    );
  }
  const capabilities = context.capabilities?.(target.prefab);
  if (capabilities && !capabilities.hasCamera) {
    return fail(
      '/activeCameraGameObjectId',
      `GameObject "${gameObjectId}" resolves to Prefab "${target.prefab.assetId}@${target.prefab.version}", which has no camera Component`,
      'capability',
    );
  }

  return ok({ ...scene, activeCameraGameObjectId: gameObjectId }, ['/activeCameraGameObjectId']);
}

function withGameObject(
  scene: SceneDefinition,
  gameObjectId: string,
  update: (gameObject: GameObjectInstanceDefinition) => {
    gameObject: GameObjectInstanceDefinition;
    paths: string[];
  },
): OperationResult<SceneDefinition> {
  const gameObjects = gameObjectsOf(scene);
  const existing = gameObjects.find((gameObject) => gameObject.id === gameObjectId);
  if (!existing) {
    return fail(`/gameObjects/${gameObjectId}`, `no GameObject "${gameObjectId}"`, 'reference');
  }
  const { gameObject, paths } = update(existing);
  return ok(
    {
      ...scene,
      gameObjects: gameObjects.map((entry) => (entry.id === gameObjectId ? gameObject : entry)),
    },
    paths,
  );
}

/** A Prefab reference the repository does not hold, named exactly (§8.2). */
function prefabIssue(
  reference: GameObjectPrefabReference,
  context: SceneGameObjectOperationContext,
  path: string,
): ValidationIssue | undefined {
  if (context.knownPrefabKeys.has(exactPrefabReferenceKey(reference))) return undefined;
  return {
    path,
    message:
      `unknown Prefab "${reference.assetId}@${reference.version}" ` +
      `(content ${reference.contentHash.slice(0, 12)}…); ` +
      'Scene references are exact and are never resolved to "latest"',
    keyword: 'reference',
  };
}

function transformIssues(transform: TransformDefinition, base: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const field of ['position', 'rotation', 'scale'] as const) {
    for (const [axis, value] of Object.entries(transform[field] as Record<string, number>)) {
      if (!Number.isFinite(value)) {
        issues.push({
          path: `${base}/${field}/${axis}`,
          message: `transform ${field} ${axis} must be finite`,
          keyword: 'finite',
        });
      }
    }
  }
  return issues;
}

/**
 * A collision-free GameObject id derived from `base` (§7.3).
 *
 * A stable counter rather than a random suffix. A random id is deterministic in
 * no useful sense: two runs of the same script would produce documents that
 * diff against each other, and a fixture asserting on the duplicate's id could
 * never be written.
 */
export function uniqueGameObjectId(base: string, existing: readonly { id: string }[]): string {
  const taken = new Set(existing.map((entry) => entry.id));
  if (!taken.has(base)) return base;
  for (let index = 2; ; index += 1) {
    const candidate = `${base}-${index}`;
    if (!taken.has(candidate)) return candidate;
  }
}
