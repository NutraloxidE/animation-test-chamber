/**
 * Scene traces, their projection back to legacy traces, and scene hashing.
 *
 * A scene trace is versioned and keyed by entity id (DECISION 0010). The legacy
 * single-character `ReplayTrace` is *not* changed: existing fixtures still mean
 * what they meant, and a one-entity scene projects onto that shape exactly,
 * which is the property the compatibility tests assert. Regenerating the old
 * baselines into a new format would have been much less work and would have
 * thrown away the only evidence that the new runtime behaves like the old one.
 */
import type { SemanticEventKind } from '@atc/schema';
import { FIXED_TIMESTEP_VERSION } from '@atc/schema';
import { computeMetrics, type ReplayTrace, type TickRecord } from '@atc/replay-runtime';
import { quantize } from '@atc/runtime-core';
import type { SceneRuntime, SceneTickRecord } from './scene.ts';

/** Bumped when the scene trace shape changes. Independent of the legacy one. */
export const SCENE_TRACE_VERSION = 1;

export interface SceneEntityTrace {
  entityId: string;
  /** Which character definition produced it, so a trace explains its own source. */
  characterId: string;
  controllerKind: string;
  ticks: TickRecord[];
}

export interface SceneTrace {
  sceneTraceVersion: number;
  fixedTimestepVersion: number;
  sceneId: string;
  revisionId: string;
  tickCount: number;
  /** Entity id -> trace. Declaration order is preserved in `entityOrder`. */
  entities: Record<string, SceneEntityTrace>;
  entityOrder: string[];
}

/**
 * Runs `ticks` steps and collects a scene trace.
 *
 * Takes the runtime rather than a record list because the trace has to record
 * *which* entity produced each tick, and only the runtime knows the declaration
 * order that made it so.
 */
export function recordSceneTrace(runtime: SceneRuntime, ticks: number): SceneTrace {
  const entities: Record<string, SceneEntityTrace> = {};
  const order: string[] = [];

  for (const id of runtime.entityIds) {
    const resolved = runtime.resolvedCharacter(id)!;
    order.push(id);
    entities[id] = {
      entityId: id,
      characterId: resolved.definition.characterId,
      controllerKind: resolved.definition.controller.kind,
      ticks: [],
    };
  }

  const records: SceneTickRecord[] = runtime.run(ticks);
  for (const record of records) {
    for (const [entityId, tickRecord] of Object.entries(record.entities)) {
      entities[entityId]?.ticks.push(tickRecord);
    }
  }

  return {
    sceneTraceVersion: SCENE_TRACE_VERSION,
    fixedTimestepVersion: FIXED_TIMESTEP_VERSION,
    sceneId: runtime.scene.id,
    revisionId: revisionIdOf(runtime),
    tickCount: ticks,
    entities,
    entityOrder: order,
  };
}

function revisionIdOf(runtime: SceneRuntime): string {
  const first = runtime.entityIds[0];
  return first ? (runtime.resolvedCharacter(first)?.resolved.revisionId ?? '') : '';
}

/**
 * Projects one entity's trace onto the legacy `ReplayTrace` shape.
 *
 * The metrics come from `computeMetrics` in `replay-runtime`, the same function
 * `runReplay` uses — see the comment there for why it is exported rather than
 * copied.
 */
export function projectEntityTrace(
  runtime: SceneRuntime,
  sceneTrace: SceneTrace,
  entityId: string,
  replayId: string,
  revisionId: string,
): ReplayTrace | undefined {
  const entity = sceneTrace.entities[entityId];
  const character = runtime.character(entityId);
  if (!entity || !character) return undefined;
  return {
    replayId,
    revisionId,
    fixedTimestepVersion: sceneTrace.fixedTimestepVersion,
    ticks: entity.ticks,
    metrics: computeMetrics(entity.ticks, character.simulation),
  };
}

/**
 * A stable content hash of the whole scene at the end of a run.
 *
 * Quantized before hashing, and built by walking `entityOrder` rather than the
 * record object: a hash whose value depended on key enumeration would be a
 * determinism test that passes for a reason unrelated to determinism.
 */
export function hashSceneTrace(trace: SceneTrace): string {
  const parts: string[] = [`v${trace.sceneTraceVersion}`, `t${trace.tickCount}`];
  for (const entityId of trace.entityOrder) {
    const entity = trace.entities[entityId];
    if (!entity) continue;
    parts.push(`#${entityId}`);
    for (const record of entity.ticks) {
      parts.push(
        [
          record.tick,
          quantize(record.position.x, 4),
          quantize(record.position.y, 4),
          quantize(record.position.z, 4),
          quantize(record.yawRad, 4),
          record.locomotionState,
          record.actionState,
          quantize(record.locomotionNormalizedTime, 4),
          quantize(record.actionNormalizedTime, 4),
          record.grounded ? 1 : 0,
          record.events.join('+'),
        ].join(','),
      );
    }
  }
  return fnv1a(parts.join(';'));
}

/** Entity-qualified event timeline, for asserting on edges by tick. */
export function eventTimelineOf(
  trace: SceneTrace,
  entityId: string,
): { tick: number; event: SemanticEventKind }[] {
  const out: { tick: number; event: SemanticEventKind }[] = [];
  for (const record of trace.entities[entityId]?.ticks ?? []) {
    for (const event of record.events) out.push({ tick: record.tick, event });
  }
  return out;
}

/** 32-bit FNV-1a as 8 hex characters. Not cryptographic; it is a change detector. */
function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
