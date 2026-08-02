/**
 * World traces, their projection back to legacy traces, and world hashing.
 *
 * A world trace is versioned and keyed by instance id (DECISION 0010). The
 * legacy single-character `ReplayTrace` is *not* changed: existing fixtures
 * still mean what they meant, and a one-instance world projects onto that shape
 * exactly, which is the property the compatibility test asserts. Regenerating
 * the old baselines into a new format would have been much less work and would
 * have thrown away the only evidence that the new runtime behaves like the old
 * one.
 */
import type { SemanticEventKind } from '@atc/schema';
import { FIXED_TIMESTEP_VERSION } from '@atc/schema';
import { computeMetrics, type ReplayTrace, type TickRecord } from '@atc/replay-runtime';
import { quantize } from '@atc/runtime-core';
import type { WorldRuntime, WorldTickRecord } from './world.ts';

/** Bumped when the world trace shape changes. Independent of the legacy one. */
export const WORLD_TRACE_VERSION = 1;

export interface InstanceTrace {
  instanceId: string;
  /** Which character definition produced it, so a trace explains its own source. */
  characterId: string;
  intentSourceKind: string;
  ticks: TickRecord[];
}

export interface WorldTrace {
  worldTraceVersion: number;
  fixedTimestepVersion: number;
  worldId: string;
  revisionId: string;
  tickCount: number;
  /** Instance id -> trace. Declaration order is preserved in `instanceOrder`. */
  instances: Record<string, InstanceTrace>;
  instanceOrder: string[];
}

/**
 * Runs `ticks` steps and collects a world trace.
 *
 * Takes the runtime rather than a record list because the trace has to record
 * *which* instance produced each tick, and only the runtime knows the
 * declaration order that made it so.
 */
export function recordWorldTrace(runtime: WorldRuntime, ticks: number): WorldTrace {
  const instances: Record<string, InstanceTrace> = {};
  const order: string[] = [];

  for (const id of runtime.instanceIds) {
    const state = runtime.instance(id)!;
    order.push(id);
    instances[id] = {
      instanceId: id,
      characterId: state.definition.source.characterId,
      intentSourceKind: state.definition.intentSource.kind,
      ticks: [],
    };
  }

  const records: WorldTickRecord[] = runtime.run(ticks);
  for (const record of records) {
    for (const [instanceId, tickRecord] of Object.entries(record.instances)) {
      instances[instanceId]?.ticks.push(tickRecord);
    }
  }

  return {
    worldTraceVersion: WORLD_TRACE_VERSION,
    fixedTimestepVersion: FIXED_TIMESTEP_VERSION,
    worldId: runtime.world.id,
    revisionId: revisionIdOf(runtime),
    tickCount: ticks,
    instances,
    instanceOrder: order,
  };
}

function revisionIdOf(runtime: WorldRuntime): string {
  const first = runtime.instanceIds[0];
  return first ? (runtime.instance(first)?.resolved.revisionId ?? '') : '';
}

/**
 * Projects one instance's trace onto the legacy `ReplayTrace` shape.
 *
 * The metrics come from `computeMetrics` in `replay-runtime`, the same function
 * `runReplay` uses — see the comment there for why it is exported rather than
 * copied.
 */
export function projectInstanceTrace(
  runtime: WorldRuntime,
  worldTrace: WorldTrace,
  instanceId: string,
  replayId: string,
  revisionId: string,
): ReplayTrace | undefined {
  const instance = worldTrace.instances[instanceId];
  const state = runtime.instance(instanceId);
  if (!instance || !state) return undefined;
  return {
    replayId,
    revisionId,
    fixedTimestepVersion: worldTrace.fixedTimestepVersion,
    ticks: instance.ticks,
    metrics: computeMetrics(instance.ticks, state.simulation),
  };
}

/**
 * A stable content hash of the whole world at the end of a run.
 *
 * Quantized before hashing, and built by walking `instanceOrder` rather than
 * the record object: a hash whose value depended on key enumeration would be a
 * determinism test that passes for a reason unrelated to determinism.
 */
export function hashWorldTrace(trace: WorldTrace): string {
  const parts: string[] = [`v${trace.worldTraceVersion}`, `t${trace.tickCount}`];
  for (const instanceId of trace.instanceOrder) {
    const instance = trace.instances[instanceId];
    if (!instance) continue;
    parts.push(`#${instanceId}`);
    for (const record of instance.ticks) {
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

/** Instance-qualified event timeline, for asserting on edges by tick. */
export function eventTimelineOf(
  trace: WorldTrace,
  instanceId: string,
): { tick: number; event: SemanticEventKind }[] {
  const out: { tick: number; event: SemanticEventKind }[] = [];
  for (const record of trace.instances[instanceId]?.ticks ?? []) {
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
