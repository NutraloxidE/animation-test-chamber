/**
 * Instance-qualified observation.
 *
 * Observability is an output of the world, not a debugging afterthought: an AI
 * that can command an instance but cannot read one back has no way to tell
 * whether it worked. Every path names an instance by *id*, never by index —
 * `/world/instances/0/...` would silently mean a different instance the moment
 * someone reordered the array, and a path that quietly changes meaning is worse
 * than no path.
 */
import { ACTION_LAYER, LOCOMOTION_LAYER } from '@atc/animation-runtime';
import { BUTTON_ACTIONS } from '@atc/schema';
import type { WorldRuntime } from './world.ts';

/** One readable value, at a stable path. */
export interface Observation {
  path: string;
  value: unknown;
}

export interface InstanceObservation {
  instanceId: string;
  displayName: string;
  enabled: boolean;
  sourceKind: string;
  characterId: string;
  intentSourceKind: string;
  /** Track id / replay id / player index, whichever the source binds. */
  intentSourceBinding: string;
  resolutionKey: string;
  transform: { position: { x: number; y: number; z: number }; yawRad: number };
  layers: Record<string, { stateId: string; normalizedTime: number; clipId: string | undefined }>;
  intent: Record<string, number | boolean>;
  events: string[];
  grounded: boolean;
}

export interface WorldObservation {
  tick: number;
  worldId: string;
  focusedInstanceId: string;
  cameraTargetInstanceId: string;
  instances: InstanceObservation[];
}

export const OBSERVATION_ROOT = '/world';

/** The path prefix every observation of `instanceId` shares. */
export function instancePath(instanceId: string): string {
  return `${OBSERVATION_ROOT}/instances/${instanceId}`;
}

export function observeWorld(runtime: WorldRuntime): WorldObservation {
  return {
    tick: runtime.tick,
    worldId: runtime.world.id,
    focusedInstanceId: runtime.world.focusedInstanceId,
    cameraTargetInstanceId: runtime.world.cameraTargetInstanceId,
    instances: runtime.instanceIds.map((id) => observeInstance(runtime, id)!),
  };
}

export function observeInstance(
  runtime: WorldRuntime,
  instanceId: string,
): InstanceObservation | undefined {
  const state = runtime.instance(instanceId);
  if (!state) return undefined;
  const record = state.lastRecord;
  const definition = state.definition;

  const layers: InstanceObservation['layers'] = {};
  for (const layer of [LOCOMOTION_LAYER, ACTION_LAYER]) {
    const layerState = runtime.layerState(instanceId, layer);
    layers[layer] = {
      stateId: layerState?.stateId ?? '',
      normalizedTime:
        layer === LOCOMOTION_LAYER
          ? (record?.locomotionNormalizedTime ?? 0)
          : (record?.actionNormalizedTime ?? 0),
      clipId: runtime.clipIdFor(instanceId, layer),
    };
  }

  const intent: Record<string, number | boolean> = {
    Move: Math.hypot(state.lastIntent.moveX, state.lastIntent.moveY),
    MoveX: state.lastIntent.moveX,
    MoveY: state.lastIntent.moveY,
    LookX: state.lastIntent.lookX,
    LookY: state.lastIntent.lookY,
  };
  for (const action of BUTTON_ACTIONS) intent[action] = state.lastIntent.buttons[action];

  return {
    instanceId,
    displayName: definition.displayName,
    enabled: state.enabled,
    sourceKind: definition.source.kind,
    characterId: definition.source.characterId,
    intentSourceKind: definition.intentSource.kind,
    intentSourceBinding: intentBindingOf(definition.intentSource),
    resolutionKey: state.resolutionKey,
    transform: {
      position: record ? { ...record.position } : { ...definition.transform.position },
      yawRad: record ? record.yawRad : definition.transform.yawRad,
    },
    layers,
    intent,
    events: record ? [...record.events] : [],
    grounded: record?.grounded ?? true,
  };
}

function intentBindingOf(source: InstanceDefinitionIntent): string {
  switch (source.kind) {
    case 'local-input':
      return `player:${source.playerIndex}`;
    case 'scripted-track':
      return source.trackId;
    case 'replay':
      return source.replayId;
    case 'none':
      return '';
  }
}

type InstanceDefinitionIntent = NonNullable<
  ReturnType<WorldRuntime['instance']>
>['definition']['intentSource'];

/**
 * The observation flattened to `path -> value`.
 *
 * Two shapes for the same data on purpose: a UI wants the object, and a command
 * caller comparing two runs wants a flat list it can diff without walking a
 * tree it has to know the shape of.
 */
export function flattenObservations(observation: WorldObservation): Observation[] {
  const out: Observation[] = [
    { path: `${OBSERVATION_ROOT}/tick`, value: observation.tick },
    { path: `${OBSERVATION_ROOT}/focusedInstanceId`, value: observation.focusedInstanceId },
    {
      path: `${OBSERVATION_ROOT}/cameraTargetInstanceId`,
      value: observation.cameraTargetInstanceId,
    },
  ];

  for (const instance of observation.instances) {
    const base = instancePath(instance.instanceId);
    out.push(
      { path: `${base}/enabled`, value: instance.enabled },
      { path: `${base}/source/characterId`, value: instance.characterId },
      { path: `${base}/intentSource/kind`, value: instance.intentSourceKind },
      { path: `${base}/intentSource/binding`, value: instance.intentSourceBinding },
      { path: `${base}/transform/position/x`, value: instance.transform.position.x },
      { path: `${base}/transform/position/y`, value: instance.transform.position.y },
      { path: `${base}/transform/position/z`, value: instance.transform.position.z },
      { path: `${base}/transform/yawRad`, value: instance.transform.yawRad },
      { path: `${base}/grounded`, value: instance.grounded },
      { path: `${base}/events`, value: instance.events },
    );
    for (const [layer, value] of Object.entries(instance.layers)) {
      out.push(
        { path: `${base}/animation/layers/${layer}/stateId`, value: value.stateId },
        {
          path: `${base}/animation/layers/${layer}/normalizedTime`,
          value: value.normalizedTime,
        },
        { path: `${base}/animation/layers/${layer}/clipId`, value: value.clipId },
      );
    }
    for (const [action, value] of Object.entries(instance.intent)) {
      out.push({ path: `${base}/intent/${action}`, value });
    }
  }

  return out;
}

/** Every observation path a capability may declare. Used by the harness. */
export const WORLD_OBSERVATION_IDS = [
  'world.tick',
  'world.instance.enabled',
  'world.instance.source',
  'world.instance.intentSource',
  'world.instance.transform',
  'world.instance.animation.layers',
  'world.instance.intent',
  'world.instance.events',
] as const;
export type WorldObservationId = (typeof WORLD_OBSERVATION_IDS)[number];
