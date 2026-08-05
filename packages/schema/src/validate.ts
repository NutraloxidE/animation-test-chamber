import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv';
import type { TSchema } from '@sinclair/typebox';
import { ProjectDefinition } from './project.ts';
import { ReplayDefinition } from './replay.ts';
import { TerrainPreset } from './terrain.ts';
import { LicenseManifest, CandidateAsset } from './acquisition.ts';
import { AnimationClipDefinition, AnimationGraphDefinition, TransitionDefinition } from './animation.ts';
import { HapticProfile } from './haptics.ts';
import { InputMapDefinition } from './input.ts';
import { MovementProfile, CameraProfile, RootMotionProfile } from './movement.ts';
import { TerrainInteractionProfile } from './terrain.ts';
import {
  AnimationBehaviorAsset,
  AnimationClipAsset,
  AnimationMotionSetAsset,
  AnimationTuningProfileAsset,
  AssetReference,
  CharacterAnimationAssignment,
  HumanoidRigProfileAsset,
} from './animation-assets.ts';
import { SaveAnimationChangesRequest } from './animation-save.ts';
import {
  RuntimeInstanceDefinition,
  WorldDefinition,
} from './world.ts';
import { IntentTrackDefinition } from './intent-track.ts';
import {
  CameraSceneEntity,
  CharacterControllerBindingDefinition,
  CharacterSceneEntity,
  GameObjectInstanceBindings,
  GameObjectInstanceDefinition,
  GameObjectInstanceRelations,
  GameObjectSceneOperation,
  LightSceneEntity,
  PlaceablePrefabAsset,
  PropSceneEntity,
  SceneDefinition,
  SceneEntityDefinition,
  SceneOperation,
} from './scene.ts';
import {
  BaseGameObjectPrefabAsset,
  ForkGameObjectPrefabAsset,
  GameObjectComponentDefinition,
  GameObjectPrefabReference,
  PrefabComponentOverride,
  PrefabPatch,
  RenderableModelBinding,
  VariantGameObjectPrefabAsset,
} from './prefab.ts';
import {
  ProtectionApproval,
  RepositoryApplyExpected,
  RepositoryApplyRequest,
  RepositoryDocumentTarget,
} from './repository-apply.ts';

export interface ValidationIssue {
  path: string;
  message: string;
  keyword: string;
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
}

/**
 * Registry of every schema that can be validated by name. UI, API, tests and
 * the Unity exporter all resolve through this map so there is exactly one
 * definition of "valid" in the system.
 */
export const SCHEMA_REGISTRY = {
  ProjectDefinition,
  ReplayDefinition,
  TerrainPreset,
  LicenseManifest,
  CandidateAsset,
  AnimationGraphDefinition,
  AnimationClipDefinition,
  TransitionDefinition,
  HapticProfile,
  InputMapDefinition,
  MovementProfile,
  RootMotionProfile,
  CameraProfile,
  TerrainInteractionProfile,
  AnimationBehaviorAsset,
  AnimationMotionSetAsset,
  AnimationClipAsset,
  HumanoidRigProfileAsset,
  AnimationTuningProfileAsset,
  AssetReference,
  CharacterAnimationAssignment,
  SaveAnimationChangesRequest,
  WorldDefinition,
  RuntimeInstanceDefinition,
  IntentTrackDefinition,
  SceneDefinition,
  SceneEntityDefinition,
  CharacterSceneEntity,
  PropSceneEntity,
  LightSceneEntity,
  CameraSceneEntity,
  CharacterControllerBindingDefinition,
  SceneOperation,
  RepositoryDocumentTarget,
  RepositoryApplyExpected,
  ProtectionApproval,
  RepositoryApplyRequest,
  GameObjectPrefabReference,
  RenderableModelBinding,
  GameObjectComponentDefinition,
  PrefabComponentOverride,
  PrefabPatch,
  // The three stored Prefab shapes are registered individually rather than as
  // their union: each embeds the recursive `PrefabNodeDefinition`, whose `$id`
  // is the target of a `$ref`, and one compiled schema cannot carry that `$id`
  // twice. `derivation.mode` selects which name to validate against.
  BaseGameObjectPrefabAsset,
  ForkGameObjectPrefabAsset,
  VariantGameObjectPrefabAsset,
  GameObjectInstanceDefinition,
  GameObjectInstanceBindings,
  GameObjectInstanceRelations,
  PlaceablePrefabAsset,
  GameObjectSceneOperation,
} as const satisfies Record<string, TSchema>;

export type SchemaName = keyof typeof SCHEMA_REGISTRY;

// allowUnionTypes is required because TerrainFeature is a discriminated union.
const ajv = new Ajv({ allErrors: true, strict: false, allowUnionTypes: true });

const compiled = new Map<string, ValidateFunction>();

/** Every `$ref` target named anywhere inside a schema. */
function referencedIds(schema: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(schema)) {
    for (const entry of schema) referencedIds(entry, into);
    return into;
  }
  if (schema && typeof schema === 'object') {
    for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
      if (key === '$ref' && typeof value === 'string') into.add(value);
      else referencedIds(value, into);
    }
  }
  return into;
}

/**
 * TypeBox inlines shared sub-schemas rather than emitting $refs, so a building
 * block like ProtectionMetadata appears many times inside one document, each
 * copy carrying the same $id. Ajv rejects that as an ambiguous reference. The
 * $id values are useful when emitting standalone JSON Schema files, so they stay
 * in the definitions and are stripped here instead.
 *
 * One kind of `$id` must survive: the one a `$ref` inside the same schema
 * resolves against. `PrefabNodeDefinition` is recursive — a node's children may
 * be nodes — and recursion is expressible only as a reference, so stripping its
 * `$id` would leave a dangling `$ref` and Ajv would refuse to compile at all.
 * Referenced ids are kept; every other id still goes.
 */
export function stripSchemaIds<T>(schema: T): T {
  return stripUnreferencedIds(schema, referencedIds(schema));
}

function stripUnreferencedIds<T>(schema: T, keep: Set<string>): T {
  if (Array.isArray(schema)) {
    return schema.map((entry) => stripUnreferencedIds(entry, keep)) as unknown as T;
  }
  if (schema && typeof schema === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
      if (key === '$id' && !(typeof value === 'string' && keep.has(value))) continue;
      out[key] = stripUnreferencedIds(value, keep);
    }
    return out as T;
  }
  return schema;
}

function compile(name: SchemaName): ValidateFunction {
  const existing = compiled.get(name);
  if (existing) return existing;
  const fn = ajv.compile(stripSchemaIds(SCHEMA_REGISTRY[name]) as object);
  compiled.set(name, fn);
  return fn;
}

function toIssues(errors: ErrorObject[] | null | undefined): ValidationIssue[] {
  if (!errors) return [];
  return errors.map((error) => ({
    path: error.instancePath === '' ? '/' : error.instancePath,
    message: error.message ?? 'invalid',
    keyword: error.keyword,
  }));
}

export function validateAgainst(name: SchemaName, data: unknown): ValidationResult {
  const fn = compile(name);
  const valid = fn(data) as boolean;
  return { valid, issues: valid ? [] : toIssues(fn.errors) };
}

export function validateProject(data: unknown): ValidationResult {
  return validateAgainst('ProjectDefinition', data);
}

/**
 * Schema validation of a resolved document.
 *
 * A resolved project is not a `ProjectDefinition` — it carries a graph and a
 * clip list the canonical schema deliberately no longer has — so it is checked
 * in three parts against the schemas that actually own each piece. Passing the
 * whole thing to `validateProject` would report the graph as an unknown extra
 * property, which is true and useless.
 */
export function validateResolvedProject(data: unknown): ValidationResult {
  const resolved = data as {
    graph?: unknown;
    clips?: unknown[];
    character?: unknown;
    motionBindings?: unknown;
    contextualMotionBindings?: unknown;
    motionContextKeys?: unknown;
    resolution?: unknown;
    clipAssetSources?: unknown;
  };
  // The resolved-only members are destructured out so `canonical` is exactly
  // the shape ProjectDefinition describes; only `graph` and `clips` are then
  // validated separately, against the schemas that own them.
  const {
    graph,
    clips,
    character: _character,
    motionBindings: _motionBindings,
    contextualMotionBindings: _contextualMotionBindings,
    motionContextKeys: _motionContextKeys,
    resolution: _resolution,
    clipAssetSources: _clipAssetSources,
    ...canonical
  } = resolved;

  const issues: ValidationIssue[] = [...validateAgainst('ProjectDefinition', canonical).issues];
  issues.push(
    ...validateAgainst('AnimationGraphDefinition', graph).issues.map((issue) => ({
      ...issue,
      path: `/graph${issue.path === '/' ? '' : issue.path}`,
    })),
  );
  for (const clip of (clips ?? []) as { id?: string }[]) {
    issues.push(
      ...validateAgainst('AnimationClipDefinition', clip).issues.map((issue) => ({
        ...issue,
        path: `/clips/${clip.id ?? '?'}${issue.path === '/' ? '' : issue.path}`,
      })),
    );
  }
  return { valid: issues.length === 0, issues };
}

/**
 * Structural checks on the canonical project (schema v2). The graph and clips
 * no longer live here, so this is about characters and their asset references;
 * everything graph-shaped moved to `validateResolvedProjectReferences`.
 */
export function validateProjectReferences(project: unknown): ValidationResult {
  const issues: ValidationIssue[] = [];
  const p = project as {
    characters?: {
      id: string;
      animation?: {
        behavior?: { assetId?: string };
        motionSet?: { assetId?: string };
        rig?: { assetId?: string };
      };
    }[];
    activeCharacterId?: string;
    equipment?: { id: string; parameter: string }[];
  };

  const characters = p.characters ?? [];
  const seenCharacters = new Set<string>();
  for (const character of characters) {
    if (seenCharacters.has(character.id)) {
      issues.push({
        path: `/characters/${character.id}`,
        message: 'duplicate character id',
        keyword: 'unique',
      });
    }
    seenCharacters.add(character.id);
    for (const slot of ['behavior', 'motionSet', 'rig'] as const) {
      if (!character.animation?.[slot]?.assetId) {
        issues.push({
          path: `/characters/${character.id}/animation/${slot}`,
          message: `character "${character.id}" has no ${slot} asset reference`,
          keyword: 'reference',
        });
      }
    }
  }

  if (p.activeCharacterId && !seenCharacters.has(p.activeCharacterId)) {
    issues.push({
      path: '/activeCharacterId',
      message: `references unknown character "${p.activeCharacterId}"`,
      keyword: 'reference',
    });
  }

  issues.push(...equipmentIssues(p.equipment ?? [], null));
  issues.push(...worldIssues(project, seenCharacters));
  issues.push(...scenesIssues(project, seenCharacters));
  return { valid: issues.length === 0, issues };
}

/**
 * Structural checks across a project's Scenes.
 *
 * Scene ids are unique *project-wide* rather than merely non-empty, because a
 * route parameter is the authoritative target identity: two Scenes sharing an
 * id would make `/edit/scene/x` name two documents, and whichever one the
 * resolver reached first would be the one that got written.
 */
function scenesIssues(project: unknown, characterIds: ReadonlySet<string>): ValidationIssue[] {
  const p = project as { scenes?: unknown[]; activeSceneId?: string };
  if (!Array.isArray(p.scenes)) return [];

  const issues: ValidationIssue[] = [];
  const sceneIds = new Set<string>();
  for (const scene of p.scenes) {
    const id = (scene as { id?: string }).id ?? '';
    if (sceneIds.has(id)) {
      issues.push({
        path: `/scenes/${id}`,
        message: `duplicate scene id "${id}"`,
        keyword: 'unique',
      });
    }
    sceneIds.add(id);
    issues.push(...sceneIssues(scene, characterIds, `/scenes/${id}`));
  }

  if (p.activeSceneId !== undefined && !sceneIds.has(p.activeSceneId)) {
    issues.push({
      path: '/activeSceneId',
      message: `references unknown scene "${p.activeSceneId}"`,
      keyword: 'reference',
    });
  }
  return issues;
}

/**
 * Structural checks on one Scene.
 *
 * Exported so a *staged* Scene can be checked before it is ever attached to a
 * project — the command surface refuses a bad entity at the command, not at
 * publication, and a refusal that arrives that late is one a caller has already
 * built a UI on top of.
 */
export function validateSceneReferences(
  scene: unknown,
  knownCharacterIds: ReadonlySet<string>,
): ValidationResult {
  const issues = sceneIssues(scene, knownCharacterIds, '/scene');
  return { valid: issues.length === 0, issues };
}

interface RawSceneEntity {
  id?: string;
  kind?: string;
  enabled?: boolean;
  characterId?: string;
  controller?: { kind?: string; trackId?: string };
  targetEntityId?: string;
  asset?: { kind?: string; assetPath?: string };
  transform?: {
    position?: Record<string, number>;
    rotation?: Record<string, number>;
    scale?: Record<string, number>;
  };
}

function sceneIssues(
  scene: unknown,
  characterIds: ReadonlySet<string>,
  base: string,
): ValidationIssue[] {
  const s = scene as {
    entities?: RawSceneEntity[];
    intentTracks?: { id: string; durationTicks: number; keyframes: { tick: number }[] }[];
    activeCameraEntityId?: string;
  };
  if (!s || typeof s !== 'object') return [];

  const issues: ValidationIssue[] = [];
  const entities = s.entities ?? [];

  const trackIds = new Set<string>();
  for (const track of s.intentTracks ?? []) {
    if (trackIds.has(track.id)) {
      issues.push({
        path: `${base}/intentTracks/${track.id}`,
        message: `duplicate intent track id "${track.id}"`,
        keyword: 'unique',
      });
    }
    trackIds.add(track.id);

    /*
     * Keyframes must be strictly ascending. Out-of-order keyframes are not a
     * schema error and would still sample *something*, which is worse than
     * failing: the track would play a different shape than the one the author
     * can see written down.
     */
    let previous = -1;
    for (const keyframe of track.keyframes ?? []) {
      if (keyframe.tick <= previous) {
        issues.push({
          path: `${base}/intentTracks/${track.id}/keyframes`,
          message: `keyframe ticks must strictly ascend (saw ${keyframe.tick} after ${previous})`,
          keyword: 'order',
        });
      }
      previous = keyframe.tick;
      if (keyframe.tick >= track.durationTicks) {
        issues.push({
          path: `${base}/intentTracks/${track.id}/keyframes`,
          message: `keyframe at tick ${keyframe.tick} is outside durationTicks ${track.durationTicks}`,
          keyword: 'range',
        });
      }
    }
  }

  const enabled = new Map<string, boolean>();
  for (const entity of entities) {
    const id = entity.id ?? '';
    const path = `${base}/entities/${id}`;
    if (enabled.has(id)) {
      issues.push({ path, message: `duplicate entity id "${id}"`, keyword: 'unique' });
    }
    enabled.set(id, entity.enabled ?? false);

    if (entity.kind === 'character') {
      if (!characterIds.has(entity.characterId ?? '')) {
        issues.push({
          path: `${path}/characterId`,
          message: `entity "${id}" references unknown character "${entity.characterId ?? ''}"`,
          keyword: 'reference',
        });
      }
      if (entity.controller?.kind === 'script' && !trackIds.has(entity.controller.trackId ?? '')) {
        issues.push({
          path: `${path}/controller/trackId`,
          message: `entity "${id}" references unknown intent track "${entity.controller.trackId ?? ''}"`,
          keyword: 'reference',
        });
      }
    }

    /*
     * A prop whose asset is a `blob:` or `data:` URL resolves exactly once, in
     * the tab that minted it. Such a scene looks correct to the person who
     * authored it and is broken for everyone who opens the file afterwards,
     * which is the failure worth refusing by name rather than discovering as a
     * missing mesh.
     */
    if (entity.kind === 'prop' && entity.asset?.kind === 'model') {
      const assetPath = entity.asset.assetPath ?? '';
      if (/^(blob:|data:|https?:)/i.test(assetPath)) {
        issues.push({
          path: `${path}/asset/assetPath`,
          message: `entity "${id}" stores a non-repository asset URL "${assetPath.slice(0, 32)}…"`,
          keyword: 'reference',
        });
      }
    }

    issues.push(...transformIssues(entity.transform, path));
  }

  /*
   * A camera target — and the scene's active camera — must name an entity that
   * exists and is enabled. A camera aimed at a disabled entity opens the scene
   * looking at nothing, which reads as a broken build rather than a broken
   * document.
   */
  for (const entity of entities) {
    if (entity.kind !== 'camera' || entity.targetEntityId === undefined) continue;
    if (!enabled.has(entity.targetEntityId)) {
      issues.push({
        path: `${base}/entities/${entity.id ?? ''}/targetEntityId`,
        message: `camera targets unknown entity "${entity.targetEntityId}"`,
        keyword: 'reference',
      });
    }
  }

  const activeCameraId = s.activeCameraEntityId;
  if (activeCameraId !== undefined) {
    const camera = entities.find((entity) => entity.id === activeCameraId);
    if (!camera) {
      issues.push({
        path: `${base}/activeCameraEntityId`,
        message: `references unknown entity "${activeCameraId}"`,
        keyword: 'reference',
      });
    } else if (camera.kind !== 'camera') {
      issues.push({
        path: `${base}/activeCameraEntityId`,
        message: `entity "${activeCameraId}" is a ${camera.kind}, not a camera`,
        keyword: 'reference',
      });
    } else if (!camera.enabled) {
      issues.push({
        path: `${base}/activeCameraEntityId`,
        message: `references disabled camera "${activeCameraId}"`,
        keyword: 'enabled',
      });
    }
  }

  return issues;
}

function transformIssues(
  transform: RawSceneEntity['transform'],
  base: string,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const field of ['position', 'rotation', 'scale'] as const) {
    for (const [axis, value] of Object.entries(transform?.[field] ?? {})) {
      if (!Number.isFinite(value)) {
        issues.push({
          path: `${base}/transform/${field}/${axis}`,
          message: `transform ${field} ${axis} must be finite`,
          keyword: 'finite',
        });
      }
    }
  }

  /*
   * The schema bounds each quaternion component to [-1, 1], which no JSON
   * Schema can strengthen into "unit length". An un-normalized rotation is not
   * garbage — it is a plausible-looking rotation that also scales everything it
   * is applied to, and it would be discovered as a character that grows.
   */
  const rotation = transform?.rotation;
  if (rotation && ['x', 'y', 'z', 'w'].every((axis) => Number.isFinite(rotation[axis]))) {
    const magnitude = Math.hypot(rotation.x!, rotation.y!, rotation.z!, rotation.w!);
    if (Math.abs(magnitude - 1) > 1e-3) {
      issues.push({
        path: `${base}/transform/rotation`,
        message: `rotation quaternion must be unit length (magnitude ${magnitude.toFixed(4)})`,
        keyword: 'normalized',
      });
    }
  }
  return issues;
}

/**
 * Structural checks on the optional world.
 *
 * Exported so a staged world can be checked before it is ever attached to a
 * project — the command surface refuses a bad instance at the command, not at
 * publication, and a refusal that arrives that late is one a caller has already
 * built a UI on top of.
 */
export function validateWorldReferences(
  world: unknown,
  knownCharacterIds: ReadonlySet<string>,
): ValidationResult {
  const issues = worldIssues({ world }, knownCharacterIds);
  return { valid: issues.length === 0, issues };
}

function worldIssues(project: unknown, characterIds: ReadonlySet<string>): ValidationIssue[] {
  const world = (project as { world?: unknown }).world as
    | {
        instances?: {
          id: string;
          enabled: boolean;
          source?: { kind: string; characterId?: string };
          intentSource?: { kind: string; trackId?: string };
          transform?: { position?: Record<string, number>; yawRad?: number };
        }[];
        intentTracks?: { id: string; durationTicks: number; keyframes: { tick: number }[] }[];
        focusedInstanceId?: string;
        cameraTargetInstanceId?: string;
      }
    | undefined;
  if (!world) return [];

  const issues: ValidationIssue[] = [];
  const instances = world.instances ?? [];
  const enabled = new Map<string, boolean>();

  const trackIds = new Set<string>();
  for (const track of world.intentTracks ?? []) {
    if (trackIds.has(track.id)) {
      issues.push({
        path: `/world/intentTracks/${track.id}`,
        message: `duplicate intent track id "${track.id}"`,
        keyword: 'unique',
      });
    }
    trackIds.add(track.id);

    /*
     * Keyframes must be strictly ascending. Out-of-order keyframes are not a
     * schema error and would still sample *something*, which is worse than
     * failing: the track would play a different shape than the one the author
     * can see written down.
     */
    let previous = -1;
    for (const keyframe of track.keyframes ?? []) {
      if (keyframe.tick <= previous) {
        issues.push({
          path: `/world/intentTracks/${track.id}/keyframes`,
          message: `keyframe ticks must strictly ascend (saw ${keyframe.tick} after ${previous})`,
          keyword: 'order',
        });
      }
      previous = keyframe.tick;
      if (keyframe.tick >= track.durationTicks) {
        issues.push({
          path: `/world/intentTracks/${track.id}/keyframes`,
          message: `keyframe at tick ${keyframe.tick} is outside durationTicks ${track.durationTicks}`,
          keyword: 'range',
        });
      }
    }
  }

  for (const instance of instances) {
    if (enabled.has(instance.id)) {
      issues.push({
        path: `/world/instances/${instance.id}`,
        message: `duplicate instance id "${instance.id}"`,
        keyword: 'unique',
      });
    }
    enabled.set(instance.id, instance.enabled);

    if (instance.source?.kind === 'character') {
      const characterId = instance.source.characterId ?? '';
      if (!characterIds.has(characterId)) {
        issues.push({
          path: `/world/instances/${instance.id}/source/characterId`,
          message: `instance "${instance.id}" references unknown character "${characterId}"`,
          keyword: 'reference',
        });
      }
    }

    if (instance.intentSource?.kind === 'scripted-track') {
      const trackId = instance.intentSource.trackId ?? '';
      if (!trackIds.has(trackId)) {
        issues.push({
          path: `/world/instances/${instance.id}/intentSource/trackId`,
          message: `instance "${instance.id}" references unknown intent track "${trackId}"`,
          keyword: 'reference',
        });
      }
    }

    for (const [axis, value] of Object.entries(instance.transform?.position ?? {})) {
      if (!Number.isFinite(value)) {
        issues.push({
          path: `/world/instances/${instance.id}/transform/position/${axis}`,
          message: `transform position ${axis} must be finite`,
          keyword: 'finite',
        });
      }
    }
    if (!Number.isFinite(instance.transform?.yawRad ?? 0)) {
      issues.push({
        path: `/world/instances/${instance.id}/transform/yawRad`,
        message: 'transform yaw must be finite',
        keyword: 'finite',
      });
    }
  }

  /*
   * Focus and camera must point at an instance that actually ticks. A focused
   * id naming a disabled instance opens the chamber on a character that will
   * never move, which reads as a broken build rather than a broken document.
   */
  for (const [field, id] of [
    ['focusedInstanceId', world.focusedInstanceId],
    ['cameraTargetInstanceId', world.cameraTargetInstanceId],
  ] as const) {
    if (id === undefined) continue;
    if (!enabled.has(id)) {
      issues.push({
        path: `/world/${field}`,
        message: `${field} references unknown instance "${id}"`,
        keyword: 'reference',
      });
    } else if (!enabled.get(id)) {
      issues.push({
        path: `/world/${field}`,
        message: `${field} references disabled instance "${id}"`,
        keyword: 'enabled',
      });
    }
  }

  return issues;
}

/**
 * Equipment consistency. Split out because half of it is answerable from the
 * canonical project alone (duplicate slots, the `equipped*` convention) and
 * half needs a graph to read the transitions that branch on the parameter.
 */
function equipmentIssues(
  equipment: { id: string; parameter: string }[],
  transitions: { id: string; conditions?: { parameter: string }[] }[] | null,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const seenSlots = new Set<string>();
  const seenParameters = new Set<string>();

  for (const slot of equipment) {
    for (const [value, seen, field] of [
      [slot.id, seenSlots, 'id'],
      [slot.parameter, seenParameters, 'parameter'],
    ] as const) {
      if (seen.has(value)) {
        issues.push({
          path: `/equipment/${slot.id}/${field}`,
          message: `duplicate equipment ${field} "${value}"`,
          keyword: 'unique',
        });
      }
      seen.add(value);
    }
    /*
     * An undeclared parameter is not a schema error — it just reads false
     * forever, so the branch never fires and the animation is silently dead.
     * That is the failure worth catching by name, and the `equipped*`
     * convention is what makes it catchable.
     */
    if (!slot.parameter.startsWith('equipped')) {
      issues.push({
        path: `/equipment/${slot.id}/parameter`,
        message: `equipment parameter "${slot.parameter}" must start with "equipped"`,
        keyword: 'convention',
      });
    }
  }

  if (transitions === null) return issues;

  const readParameters = new Set<string>();
  for (const transition of transitions) {
    for (const condition of transition.conditions ?? []) {
      readParameters.add(condition.parameter);
      if (
        condition.parameter.startsWith('equipped') &&
        !seenParameters.has(condition.parameter)
      ) {
        issues.push({
          path: `/graph/transitions/${transition.id}/conditions`,
          message: `condition reads "${condition.parameter}", which no equipment slot declares`,
          keyword: 'reference',
        });
      }
    }
  }
  for (const slot of equipment) {
    if (!readParameters.has(slot.parameter)) {
      issues.push({
        path: `/equipment/${slot.id}`,
        message: `equipment "${slot.id}" is declared but no transition branches on "${slot.parameter}"`,
        keyword: 'reference',
      });
    }
  }
  return issues;
}

/**
 * Structural checks on a *resolved* project: dangling references, unreachable
 * states, duplicate ids, and — new in schema v2 — that every state's motion
 * slot actually resolved to a clip. A missing binding used to be impossible to
 * express; now it is the most likely way a new character breaks, so it is
 * caught here rather than as an undefined clip at tick time.
 */
export function validateResolvedProjectReferences(project: unknown): ValidationResult {
  const issues: ValidationIssue[] = [];
  const p = project as {
    clips?: { id: string }[];
    equipment?: { id: string; parameter: string }[];
    motionBindings?: Record<string, string>;
    graph?: {
      states?: {
        id: string;
        motionSlot: string;
        contextualMotionSlots?: Record<string, string>;
        layer: string;
        fallbackState?: string;
      }[];
      transitions?: {
        id: string;
        from: string;
        to: string;
        conditions?: { parameter: string }[];
      }[];
      layers?: { id: string; defaultState: string }[];
    };
    defaultTerrainPresetId?: string;
  };

  const clipIds = new Set((p.clips ?? []).map((c) => c.id));
  const bindings = p.motionBindings ?? {};
  const states = p.graph?.states ?? [];
  const stateIds = new Set(states.map((s) => s.id));
  const transitions = p.graph?.transitions ?? [];

  const seenStates = new Set<string>();
  for (const state of states) {
    if (seenStates.has(state.id)) {
      issues.push({
        path: `/graph/states/${state.id}`,
        message: 'duplicate state id',
        keyword: 'unique',
      });
    }
    seenStates.add(state.id);
    for (const slot of [state.motionSlot, ...Object.values(state.contextualMotionSlots ?? {})]) {
      const clipId = bindings[slot];
      if (clipId === undefined) {
        issues.push({
          path: `/graph/states/${state.id}/motionSlot`,
          message: `motion slot "${slot}" is not bound by the motion set`,
          keyword: 'reference',
        });
      } else if (!clipIds.has(clipId)) {
        issues.push({
          path: `/graph/states/${state.id}/motionSlot`,
          message: `motion slot "${slot}" resolves to unknown clip "${clipId}"`,
          keyword: 'reference',
        });
      }
    }
    if (state.fallbackState && !stateIds.has(state.fallbackState)) {
      issues.push({
        path: `/graph/states/${state.id}/fallbackState`,
        message: `references unknown state "${state.fallbackState}"`,
        keyword: 'reference',
      });
    }
  }

  const seenTransitions = new Set<string>();
  for (const transition of transitions) {
    if (seenTransitions.has(transition.id)) {
      issues.push({
        path: `/graph/transitions/${transition.id}`,
        message: 'duplicate transition id',
        keyword: 'unique',
      });
    }
    seenTransitions.add(transition.id);
    if (transition.from !== '*' && !stateIds.has(transition.from)) {
      issues.push({
        path: `/graph/transitions/${transition.id}/from`,
        message: `references unknown state "${transition.from}"`,
        keyword: 'reference',
      });
    }
    if (!stateIds.has(transition.to)) {
      issues.push({
        path: `/graph/transitions/${transition.id}/to`,
        message: `references unknown state "${transition.to}"`,
        keyword: 'reference',
      });
    }
  }

  for (const layer of p.graph?.layers ?? []) {
    if (!stateIds.has(layer.defaultState)) {
      issues.push({
        path: `/graph/layers/${layer.id}/defaultState`,
        message: `references unknown state "${layer.defaultState}"`,
        keyword: 'reference',
      });
    }
  }

  // Reachability, per layer, from that layer's default state.
  for (const layer of p.graph?.layers ?? []) {
    const layerStates = states.filter((s) => s.layer === layer.id);
    const reachable = new Set<string>([layer.defaultState]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const transition of transitions) {
        const toState = states.find((s) => s.id === transition.to);
        if (!toState || toState.layer !== layer.id) continue;
        const fromReachable = transition.from === '*' || reachable.has(transition.from);
        if (fromReachable && !reachable.has(transition.to)) {
          reachable.add(transition.to);
          grew = true;
        }
      }
    }
    for (const state of layerStates) {
      if (!reachable.has(state.id)) {
        issues.push({
          path: `/graph/states/${state.id}`,
          message: `state is unreachable from layer default "${layer.defaultState}"`,
          keyword: 'reachability',
        });
      }
    }
  }

  issues.push(...equipmentIssues(p.equipment ?? [], transitions));

  return { valid: issues.length === 0, issues };
}
