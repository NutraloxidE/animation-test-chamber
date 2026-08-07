/**
 * Typed repository operations.
 *
 * One operation per persistent semantic change, and the *same* operation
 * whether it was dispatched by a UI drag, an Inspector field, a keyboard
 * shortcut, an external AI command or an API request (work package §4.7). The
 * thing this makes impossible is the shortcut it replaces:
 *
 *     scene.entities.push(entity)      // inside a React event handler
 *
 * which writes canonical data with no validation, no protection check, no undo
 * entry, no staged path and no machine equivalent — so the same change made by
 * an AI would have to travel a second code path, and the two would disagree.
 *
 * Every operation returns issues rather than throwing. A refused drop needs to
 * explain itself next to the thing that was dropped, and an exception cannot.
 */
import type {
  CameraSceneEntity,
  CharacterSceneEntity,
  LightSceneEntity,
  ProjectDefinition,
  PropSceneEntity,
  SceneDefinition,
  SceneEntityDefinition,
  SceneOperation,
  TransformDefinition,
  ValidationIssue,
} from '@atc/schema';
import { IDENTITY_ROTATION, UNIT_SCALE, validateAgainst, validateSceneReferences } from '@atc/schema';

/*
 * The operation union lives in `@atc/schema` and is re-exported here.
 *
 * It was a TypeScript-only union until the API had to accept one over HTTP,
 * where a compile-time union is worth exactly nothing: `POST /api/repository/
 * apply` receives JSON, and a cast is not a check. Declaring it once, as a
 * schema, is what keeps the shape the server enforces and the shape the editor
 * dispatches from being two shapes that drift.
 */
export type { PlaceableAsset, SceneOperation } from '@atc/schema';

/** Every operation type the union declares, for naming an unknown one. */
export const SCENE_OPERATION_TYPES = [
  'scene.rename',
  'scene.place_asset',
  'scene.delete_entity',
  'scene.duplicate_entity',
  'scene.rename_entity',
  'scene.set_transform',
  'scene.set_enabled',
  'scene.set_character_source',
  'scene.bind_controller',
  'scene.reorder_entity',
  'scene.set_active_camera',
] as const;

/**
 * Validates one untrusted value as a `SceneOperation`.
 *
 * The `type` is checked by hand *before* the schema, for one reason: a union of
 * eleven closed objects reports an unknown `type` as eleven simultaneous
 * failures, none of which say the useful thing. An operation the server does
 * not implement has to be refused by name — a caller that sent
 * `scene.set_matereal` needs to read that word back, not an anyOf dump.
 */
export function parseSceneOperation(
  value: unknown,
): { ok: true; operation: SceneOperation } | { ok: false; issues: ValidationIssue[] } {
  const type = (value as { type?: unknown } | null)?.type;
  if (typeof type !== 'string' || !(SCENE_OPERATION_TYPES as readonly string[]).includes(type)) {
    return {
      ok: false,
      issues: [
        {
          path: '/type',
          message: `unknown operation type ${JSON.stringify(type)}; expected one of ${SCENE_OPERATION_TYPES.join(', ')}`,
          keyword: 'unsupported',
        },
      ],
    };
  }

  const result = validateAgainst('SceneOperation', value);
  if (!result.valid) {
    // Only the failures of the member that matched this `type` are interesting;
    // the other ten failed on the discriminator alone.
    const issues = result.issues.filter((issue) => issue.path !== '/type');
    return { ok: false, issues: issues.length > 0 ? issues : result.issues };
  }
  return { ok: true, operation: value as SceneOperation };
}

export interface OperationResult<TDocument> {
  ok: boolean;
  issues: ValidationIssue[];
  /** The document the operation would produce. Absent when `ok` is false. */
  document?: TDocument;
  /**
   * Target-relative canonical paths this operation touched.
   *
   * Always ID-keyed — `/entities/honoka-01/transform/position/x`, never
   * `/entities/0/...`. An index-keyed path means something different after a
   * reorder, so a staged edit would silently land on a different entity than
   * the one the human changed.
   */
  changedPaths?: string[];
}

function fail(path: string, message: string, keyword = 'operation'): OperationResult<never> {
  return { ok: false, issues: [{ path, message, keyword }] };
}

/** The default transform a newly placed entity opens at, when none is supplied. */
export function defaultPlacementTransform(): TransformDefinition {
  return {
    position: { x: 0, y: 0, z: 0 },
    rotation: { ...IDENTITY_ROTATION },
    scale: { ...UNIT_SCALE },
  };
}

/**
 * Applies one operation to a Scene, returning the result rather than mutating.
 *
 * `project` is read for reference checks only — an operation may not change it.
 * A Scene session that could reach the project would be able to stage an
 * unrelated Character edit as a side effect of a Scene edit, which §8.4 forbids
 * precisely because nothing in the Scene UI would show it happening.
 */
export function applySceneOperation(
  scene: SceneDefinition,
  operation: SceneOperation,
  project: Pick<ProjectDefinition, 'characters'>,
): OperationResult<SceneDefinition> {
  switch (operation.type) {
    case 'scene.rename':
      return ok({ ...scene, displayName: operation.displayName }, ['/displayName'], project);

    case 'scene.place_asset':
      return placeAsset(scene, operation, project);

    case 'scene.delete_entity':
      return deleteEntity(scene, operation.entityId, project);

    case 'scene.duplicate_entity':
      return duplicateEntity(scene, operation.entityId, project);

    case 'scene.rename_entity':
      return withEntity(scene, operation.entityId, (entity) => ({
        entity: { ...entity, displayName: operation.displayName } as SceneEntityDefinition,
        paths: [`/entities/${operation.entityId}/displayName`],
      }), project);

    case 'scene.set_transform': {
      const issues = transformIssues(operation.transform, `/entities/${operation.entityId}/transform`);
      if (issues.length > 0) return { ok: false, issues };
      return withEntity(scene, operation.entityId, (entity) => ({
        entity: { ...entity, transform: operation.transform } as SceneEntityDefinition,
        paths: [`/entities/${operation.entityId}/transform`],
      }), project);
    }

    case 'scene.set_enabled':
      return withEntity(scene, operation.entityId, (entity) => ({
        entity: { ...entity, enabled: operation.enabled } as SceneEntityDefinition,
        paths: [`/entities/${operation.entityId}/enabled`],
      }), project);

    case 'scene.set_character_source': {
      if (!project.characters.some((entry) => entry.id === operation.characterId)) {
        return fail(
          `/entities/${operation.entityId}/characterId`,
          `unknown character "${operation.characterId}"`,
          'reference',
        );
      }
      return withCharacterEntity(scene, operation.entityId, (entity) => ({
        entity: { ...entity, characterId: operation.characterId },
        paths: [`/entities/${operation.entityId}/characterId`],
      }), project);
    }

    case 'scene.bind_controller':
      return withCharacterEntity(scene, operation.entityId, (entity) => ({
        entity: { ...entity, controller: operation.controller },
        paths: [`/entities/${operation.entityId}/controller`],
      }), project);

    case 'scene.reorder_entity':
      return reorderEntity(scene, operation.entityId, operation.toIndex, project);

    case 'scene.set_active_camera':
      return setActiveCamera(scene, operation.entityId, project);
  }
}

function ok(
  scene: SceneDefinition,
  changedPaths: string[],
  project: Pick<ProjectDefinition, 'characters'>,
): OperationResult<SceneDefinition> {
  /*
   * Every operation validates its *result*, not just its input. An operation
   * that only checked what it was given can still produce an invalid document
   * by interacting with what was already there — deleting a camera's target is
   * the obvious one — and discovering that at Apply time means the human learns
   * about it several edits later.
   */
  const characterIds = new Set(project.characters.map((entry) => entry.id));
  const validation = validateSceneReferences(scene, characterIds);
  if (!validation.valid) return { ok: false, issues: validation.issues };
  return { ok: true, issues: [], document: scene, changedPaths };
}

function placeAsset(
  scene: SceneDefinition,
  operation: Extract<SceneOperation, { type: 'scene.place_asset' }>,
  project: Pick<ProjectDefinition, 'characters'>,
): OperationResult<SceneDefinition> {
  if (scene.entities.some((entity) => entity.id === operation.entityId)) {
    return fail(`/entities/${operation.entityId}`, `entity id "${operation.entityId}" already exists`, 'unique');
  }

  const transform = operation.transform ?? defaultPlacementTransform();
  const issues = transformIssues(transform, `/entities/${operation.entityId}/transform`);
  if (issues.length > 0) return { ok: false, issues };

  const base = {
    schemaVersion: scene.schemaVersion,
    id: operation.entityId,
    displayName: operation.displayName,
    enabled: true,
    transform,
  };

  const asset = operation.asset;
  let entity: SceneEntityDefinition;
  switch (asset.kind) {
    case 'character': {
      if (!project.characters.some((entry) => entry.id === asset.characterId)) {
        return fail(
          `/entities/${operation.entityId}/characterId`,
          `unknown character "${asset.characterId}"`,
          'reference',
        );
      }
      /*
       * A newly placed character opens unbound. Defaulting to "player 0" would
       * mean an ordinary asset drop silently stole the human controller from
       * whichever entity already had it — a change nothing in the drop gesture
       * suggests, discovered later as a character that stopped responding.
       */
      entity = {
        ...base,
        kind: 'character',
        characterId: asset.characterId,
        controller: { kind: 'none' },
      } satisfies CharacterSceneEntity;
      break;
    }
    case 'prop':
      entity = { ...base, kind: 'prop', asset: asset.asset } satisfies PropSceneEntity;
      break;
    case 'light':
      entity = {
        ...base,
        kind: 'light',
        lightType: asset.lightType,
        intensity: 1,
        color: '#ffffff',
      } satisfies LightSceneEntity;
      break;
    case 'camera':
      entity = {
        ...base,
        kind: 'camera',
        projection: 'perspective',
        fieldOfViewDeg: 60,
      } satisfies CameraSceneEntity;
      break;
  }

  return ok(
    { ...scene, entities: [...scene.entities, entity] },
    [`/entities/${operation.entityId}`],
    project,
  );
}

function deleteEntity(
  scene: SceneDefinition,
  entityId: string,
  project: Pick<ProjectDefinition, 'characters'>,
): OperationResult<SceneDefinition> {
  if (!scene.entities.some((entity) => entity.id === entityId)) {
    return fail(`/entities/${entityId}`, `no entity "${entityId}"`, 'reference');
  }

  /*
   * Dangling references are repaired explicitly, never left behind. A camera
   * still targeting a deleted entity, or an activeCameraEntityId naming one,
   * would fail validation at Apply — long after the human pressed Delete and
   * with no obvious connection to it.
   */
  const entities = scene.entities
    .filter((entity) => entity.id !== entityId)
    .map((entity) =>
      entity.kind === 'camera' && entity.targetEntityId === entityId
        ? ({ ...entity, targetEntityId: undefined } satisfies CameraSceneEntity)
        : entity,
    );

  const next: SceneDefinition = {
    ...scene,
    entities,
    ...(scene.activeCameraEntityId === entityId ? { activeCameraEntityId: undefined } : {}),
  };
  return ok(next, [`/entities/${entityId}`], project);
}

function duplicateEntity(
  scene: SceneDefinition,
  entityId: string,
  project: Pick<ProjectDefinition, 'characters'>,
): OperationResult<SceneDefinition> {
  const source = scene.entities.find((entity) => entity.id === entityId);
  if (!source) return fail(`/entities/${entityId}`, `no entity "${entityId}"`, 'reference');

  const newId = uniqueEntityId(`${entityId}-copy`, scene.entities);
  /*
   * The duplicate copies the authored transform and overrides and keeps
   * referencing the same shared Character or prop asset. Copying the *asset*
   * would turn one shared definition into two that drift apart, which is the
   * sharing the whole definition/instance split exists to protect.
   */
  const copy = { ...source, id: newId, displayName: `${source.displayName} copy` };
  const index = scene.entities.findIndex((entity) => entity.id === entityId);
  const entities = [...scene.entities];
  entities.splice(index + 1, 0, copy as SceneEntityDefinition);

  return ok({ ...scene, entities }, [`/entities/${newId}`], project);
}

function reorderEntity(
  scene: SceneDefinition,
  entityId: string,
  toIndex: number,
  project: Pick<ProjectDefinition, 'characters'>,
): OperationResult<SceneDefinition> {
  const from = scene.entities.findIndex((entity) => entity.id === entityId);
  if (from === -1) return fail(`/entities/${entityId}`, `no entity "${entityId}"`, 'reference');
  if (!Number.isInteger(toIndex) || toIndex < 0 || toIndex >= scene.entities.length) {
    return fail('/entities', `target index ${toIndex} is outside the scene`, 'range');
  }

  const entities = [...scene.entities];
  const [moved] = entities.splice(from, 1);
  entities.splice(toIndex, 0, moved!);
  // Declaration order *is* tick order, so a reorder is a semantic change to the
  // whole list rather than to one entity — hence the list path.
  return ok({ ...scene, entities }, ['/entities'], project);
}

function setActiveCamera(
  scene: SceneDefinition,
  entityId: string | null,
  project: Pick<ProjectDefinition, 'characters'>,
): OperationResult<SceneDefinition> {
  if (entityId === null) {
    return ok({ ...scene, activeCameraEntityId: undefined }, ['/activeCameraEntityId'], project);
  }
  const camera = scene.entities.find((entity) => entity.id === entityId);
  if (!camera) return fail('/activeCameraEntityId', `no entity "${entityId}"`, 'reference');
  if (camera.kind !== 'camera') {
    return fail('/activeCameraEntityId', `entity "${entityId}" is a ${camera.kind}, not a camera`, 'reference');
  }
  return ok({ ...scene, activeCameraEntityId: entityId }, ['/activeCameraEntityId'], project);
}

function withEntity(
  scene: SceneDefinition,
  entityId: string,
  update: (entity: SceneEntityDefinition) => { entity: SceneEntityDefinition; paths: string[] },
  project: Pick<ProjectDefinition, 'characters'>,
): OperationResult<SceneDefinition> {
  const existing = scene.entities.find((entity) => entity.id === entityId);
  if (!existing) return fail(`/entities/${entityId}`, `no entity "${entityId}"`, 'reference');
  const { entity, paths } = update(existing);
  return ok(
    { ...scene, entities: scene.entities.map((entry) => (entry.id === entityId ? entity : entry)) },
    paths,
    project,
  );
}

function withCharacterEntity(
  scene: SceneDefinition,
  entityId: string,
  update: (entity: CharacterSceneEntity) => { entity: CharacterSceneEntity; paths: string[] },
  project: Pick<ProjectDefinition, 'characters'>,
): OperationResult<SceneDefinition> {
  const existing = scene.entities.find((entity) => entity.id === entityId);
  if (!existing) return fail(`/entities/${entityId}`, `no entity "${entityId}"`, 'reference');
  if (existing.kind !== 'character') {
    return fail(`/entities/${entityId}`, `entity "${entityId}" is a ${existing.kind}, not a character`, 'kind');
  }
  const { entity, paths } = update(existing);
  return ok(
    { ...scene, entities: scene.entities.map((entry) => (entry.id === entityId ? entity : entry)) },
    paths,
    project,
  );
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
 * A collision-free entity id derived from `base`.
 *
 * A stable counter rather than a random suffix. A random id is deterministic in
 * no useful sense: two runs of the same script would produce documents that
 * diff against each other, and a fixture asserting on the duplicate's id could
 * never be written.
 */
export function uniqueEntityId(base: string, existing: readonly { id: string }[]): string {
  const taken = new Set(existing.map((entry) => entry.id));
  if (!taken.has(base)) return base;
  for (let index = 2; ; index += 1) {
    const candidate = `${base}-${index}`;
    if (!taken.has(candidate)) return candidate;
  }
}
