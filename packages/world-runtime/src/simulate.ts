/**
 * One-shot world simulation.
 *
 * This exists because of a specific dishonesty in the first version of the
 * command surface. `world.preview` advanced a runtime and returned a hash;
 * `world.read_observations` read "the" runtime. In-process that worked, because
 * one `CommandContext` held one runtime. Over HTTP it could not: each request
 * built its own runtime, advanced it, and threw it away, so a caller following
 * the advertised `preview → read` sequence read a runtime at tick zero and was
 * told nothing had happened.
 *
 * The fix is not a session store. A session would make the API require sticky
 * routing and server affinity to answer a question that is *already* a pure
 * function of (project, world, ticks). `simulateWorld` is that function: build,
 * advance, observe, discard, and return everything the caller needs in one
 * response.
 */
import type { ProjectDefinition, WorldDefinition } from '@atc/schema';
import type { AnimationAssetRegistry } from '@atc/animation-asset-runtime';
import { WorldRuntime, type WorldRuntimeOptions } from './world.ts';
import {
  flattenObservations,
  observeWorld,
  type Observation,
  type WorldObservation,
} from './observation.ts';
import { hashWorldTrace, recordWorldTrace, type WorldTrace } from './trace.ts';

/**
 * The largest run a caller may ask to have traced.
 *
 * A trace is one record per instance per tick, so an unbounded `includeTrace`
 * is an unbounded response body that a caller can request by accident with one
 * extra zero. The hash and the final observation stay available at any tick
 * count; only the per-tick records are capped.
 */
export const MAX_TRACED_TICKS = 600;

/** The largest run at all, traced or not. */
export const MAX_SIMULATED_TICKS = 10_000;

export interface SimulateWorldRequest {
  registry: AnimationAssetRegistry;
  project: ProjectDefinition;
  /** The world to run — canonical or staged. Never mutated. */
  world: WorldDefinition;
  ticks: number;
  includeFlatObservations?: boolean;
  includeTrace?: boolean;
  cameraYawRad?: number;
}

export interface WorldSimulationResult {
  tick: number;
  worldHash: string;
  instanceOrder: string[];
  observation: WorldObservation;
  flatObservations?: Observation[];
  trace?: WorldTrace;
}

/**
 * Runs a world for `ticks` and returns what happened.
 *
 * The same implementation backs the capability command, the API route and the
 * tests. Two implementations — one in Hono, one in the capability package —
 * would be two answers to "what does 120 ticks do", and the API's would be the
 * one nobody tested.
 */
export function simulateWorld(request: SimulateWorldRequest): WorldSimulationResult {
  const options: WorldRuntimeOptions = {
    registry: request.registry,
    project: request.project,
    world: request.world,
    ...(request.cameraYawRad === undefined ? {} : { cameraYawRad: request.cameraYawRad }),
  };
  const runtime = new WorldRuntime(options);
  const trace = recordWorldTrace(runtime, request.ticks);
  const observation = observeWorld(runtime);

  return {
    tick: runtime.tick,
    worldHash: hashWorldTrace(trace),
    instanceOrder: [...trace.instanceOrder],
    observation,
    ...(request.includeFlatObservations
      ? { flatObservations: flattenObservations(observation) }
      : {}),
    ...(request.includeTrace ? { trace } : {}),
  };
}
