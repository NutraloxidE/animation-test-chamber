/**
 * One-shot scene simulation.
 *
 * This exists because of a specific dishonesty in the first version of the
 * command surface. `scene.preview` advanced a runtime and returned a hash;
 * `scene.read_observations` read "the" runtime. In-process that worked, because
 * one `CommandContext` held one runtime. Over HTTP it could not: each request
 * built its own runtime, advanced it, and threw it away, so a caller following
 * the advertised `preview → read` sequence read a runtime at tick zero and was
 * told nothing had happened.
 *
 * The fix is not a session store. A session would make the API require sticky
 * routing and server affinity to answer a question that is *already* a pure
 * function of (project, world, ticks). `simulateScene` is that function: build,
 * advance, observe, discard, and return everything the caller needs in one
 * response.
 */
import type { ProjectDefinition, SceneDefinition } from '@atc/schema';
import type { AnimationAssetRegistry } from '@atc/animation-asset-runtime';
import { SceneRuntime, type SceneRuntimeOptions } from './scene.ts';
import {
  flattenObservations,
  observeScene,
  type Observation,
  type SceneObservation,
} from './observation.ts';
import { hashSceneTrace, recordSceneTrace, type SceneTrace } from './trace.ts';

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

export interface SimulateSceneRequest {
  registry: AnimationAssetRegistry;
  project: ProjectDefinition;
  /** The scene to run — canonical or staged. Never mutated. */
  scene: SceneDefinition;
  ticks: number;
  includeFlatObservations?: boolean;
  includeTrace?: boolean;
  cameraYawRad?: number;
}

export interface SceneSimulationResult {
  tick: number;
  sceneHash: string;
  entityOrder: string[];
  observation: SceneObservation;
  flatObservations?: Observation[];
  trace?: SceneTrace;
}

/**
 * Runs a scene for `ticks` and returns what happened.
 *
 * The same implementation backs the capability command, the API route and the
 * tests. Two implementations — one in Hono, one in the capability package —
 * would be two answers to "what does 120 ticks do", and the API's would be the
 * one nobody tested.
 */
export function simulateScene(request: SimulateSceneRequest): SceneSimulationResult {
  const options: SceneRuntimeOptions = {
    registry: request.registry,
    project: request.project,
    scene: request.scene,
    ...(request.cameraYawRad === undefined ? {} : { cameraYawRad: request.cameraYawRad }),
  };
  const runtime = new SceneRuntime(options);
  const trace = recordSceneTrace(runtime, request.ticks);
  const observation = observeScene(runtime);

  return {
    tick: runtime.tick,
    sceneHash: hashSceneTrace(trace),
    entityOrder: [...trace.entityOrder],
    observation,
    ...(request.includeFlatObservations
      ? { flatObservations: flattenObservations(observation) }
      : {}),
    ...(request.includeTrace ? { trace } : {}),
  };
}
