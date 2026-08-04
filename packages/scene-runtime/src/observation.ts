/**
 * Entity-qualified scene observation.
 *
 * Observability is an output of the scene, not a debugging afterthought: an AI
 * that can command an entity but cannot read one back has no way to tell
 * whether it worked. Every path names an entity by *id*, never by index —
 * `/scenes/x/entities/0/...` would silently mean a different entity the moment
 * someone reordered the array, and a path that quietly changes meaning is worse
 * than no path.
 */
import { ACTION_LAYER, LOCOMOTION_LAYER } from '@atc/animation-runtime';
import { BUTTON_ACTIONS } from '@atc/schema';
import { bindingLabel } from '@atc/character-control-runtime';
import type { SceneRuntime } from './scene.ts';

/** One readable value, at a stable path. */
export interface Observation {
  path: string;
  value: unknown;
}

export interface SceneEntityObservation {
  entityId: string;
  displayName: string;
  enabled: boolean;
  kind: string;
  characterId: string;
  controllerKind: string;
  /** Track id / replay id / player index / channel, whichever the binding names. */
  controllerBinding: string;
  /** Identity of the shared animation bundle, so two entities can be seen to share one. */
  animationResolutionKey: string;
  transform: { position: { x: number; y: number; z: number }; yawRad: number };
  layers: Record<string, { stateId: string; normalizedTime: number; clipId: string | undefined }>;
  intent: Record<string, number | boolean>;
  events: string[];
  grounded: boolean;
}

export interface SceneObservation {
  tick: number;
  sceneId: string;
  activeCameraEntityId: string;
  entities: SceneEntityObservation[];
  /** Entities that named a character the project does not have. */
  unresolved: { entityId: string; characterId: string; reason: string }[];
}

export const OBSERVATION_ROOT = '/scenes';

/** The path prefix every observation of one entity shares. */
export function entityPath(sceneId: string, entityId: string): string {
  return `${OBSERVATION_ROOT}/${sceneId}/entities/${entityId}`;
}

export function observeScene(runtime: SceneRuntime): SceneObservation {
  return {
    tick: runtime.tick,
    sceneId: runtime.scene.id,
    activeCameraEntityId: runtime.scene.activeCameraEntityId ?? '',
    entities: runtime.entityIds.map((id) => observeEntity(runtime, id)!),
    unresolved: runtime.unresolved.map((entry) => ({ ...entry })),
  };
}

export function observeEntity(
  runtime: SceneRuntime,
  entityId: string,
): SceneEntityObservation | undefined {
  const character = runtime.character(entityId);
  const resolved = runtime.resolvedCharacter(entityId);
  if (!character || !resolved) return undefined;
  const definition = resolved.definition;
  const observation = character.observe();
  const record = character.lastRecord;

  const layers: SceneEntityObservation['layers'] = {};
  for (const layer of [LOCOMOTION_LAYER, ACTION_LAYER]) {
    layers[layer] = {
      stateId: runtime.layerState(entityId, layer)?.stateId ?? '',
      normalizedTime:
        layer === LOCOMOTION_LAYER
          ? (record?.locomotionNormalizedTime ?? 0)
          : (record?.actionNormalizedTime ?? 0),
      clipId: runtime.clipIdFor(entityId, layer),
    };
  }

  const intent: Record<string, number | boolean> = {
    Move: Math.hypot(observation.lastIntent.moveX, observation.lastIntent.moveY),
    MoveX: observation.lastIntent.moveX,
    MoveY: observation.lastIntent.moveY,
    LookX: observation.lastIntent.lookX,
    LookY: observation.lastIntent.lookY,
  };
  for (const action of BUTTON_ACTIONS) intent[action] = observation.lastIntent.buttons[action];

  return {
    entityId,
    displayName: definition.displayName,
    enabled: character.enabled,
    kind: definition.kind,
    characterId: definition.characterId,
    controllerKind: definition.controller.kind,
    controllerBinding: bindingLabel(definition.controller),
    animationResolutionKey: resolved.animationResolutionKey,
    transform: {
      position: record ? { ...record.position } : { ...definition.transform.position },
      yawRad: record ? record.yawRad : 0,
    },
    layers,
    intent,
    events: observation.events ?? [],
    grounded: observation.grounded,
  };
}

/**
 * The observation flattened to `path -> value`.
 *
 * Two shapes for the same data on purpose: a UI wants the object, and a command
 * caller comparing two runs wants a flat list it can diff without walking a
 * tree it has to know the shape of.
 */
export function flattenObservations(observation: SceneObservation): Observation[] {
  const root = `${OBSERVATION_ROOT}/${observation.sceneId}`;
  const out: Observation[] = [
    { path: `${root}/tick`, value: observation.tick },
    { path: `${root}/activeCameraEntityId`, value: observation.activeCameraEntityId },
  ];

  for (const entity of observation.entities) {
    const base = entityPath(observation.sceneId, entity.entityId);
    out.push(
      { path: `${base}/enabled`, value: entity.enabled },
      { path: `${base}/kind`, value: entity.kind },
      { path: `${base}/characterId`, value: entity.characterId },
      { path: `${base}/controller/kind`, value: entity.controllerKind },
      { path: `${base}/controller/binding`, value: entity.controllerBinding },
      { path: `${base}/transform/position/x`, value: entity.transform.position.x },
      { path: `${base}/transform/position/y`, value: entity.transform.position.y },
      { path: `${base}/transform/position/z`, value: entity.transform.position.z },
      { path: `${base}/transform/yawRad`, value: entity.transform.yawRad },
      { path: `${base}/grounded`, value: entity.grounded },
      { path: `${base}/events`, value: entity.events },
    );
    for (const [layer, value] of Object.entries(entity.layers)) {
      out.push(
        { path: `${base}/animation/layers/${layer}/stateId`, value: value.stateId },
        { path: `${base}/animation/layers/${layer}/normalizedTime`, value: value.normalizedTime },
        { path: `${base}/animation/layers/${layer}/clipId`, value: value.clipId },
      );
    }
    for (const [action, value] of Object.entries(entity.intent)) {
      out.push({ path: `${base}/intent/${action}`, value });
    }
  }

  return out;
}

/** Every observation path a capability may declare. Used by the harness. */
export const SCENE_OBSERVATION_IDS = [
  'scene.tick',
  'scene.entity.enabled',
  'scene.entity.characterId',
  'scene.entity.controller',
  'scene.entity.transform',
  'scene.entity.animation.layers',
  'scene.entity.intent',
  'scene.entity.events',
] as const;
export type SceneObservationId = (typeof SCENE_OBSERVATION_IDS)[number];
