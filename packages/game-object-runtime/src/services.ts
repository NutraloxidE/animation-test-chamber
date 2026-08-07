/**
 * What a component runtime is allowed to reach for (§15.1).
 *
 * Explicit services, not globals. No engine-agnostic package here reads
 * `window`, `document`, `navigator`, `performance` or the filesystem — which is
 * what lets the same instantiation run in a browser, in Node under Vitest, and
 * in a host that has never heard of a gamepad API.
 *
 * A missing optional service is a capability the host does not offer, and the
 * runtime that needed it says so rather than inventing a stub: a model loader
 * that silently returned nothing would make "the mesh never appeared" a bug
 * with no error attached to it.
 */
import type {
  CharacterControllerBindingDefinition,
  IntentTrackDefinition,
  ReplayDefinition,
  TerrainPreset,
} from '@atc/schema';
import type { AnimationAssetRegistry } from '@atc/animation-asset-runtime';
import type { CharacterIntentSource } from '@atc/character-control-runtime';
import type { PrefabAssetRegistry } from '@atc/prefab-runtime';
import type { GameplayScriptRegistry, GameplayWorld } from '@atc/gameplay-sdk';

/** Fixed-step clock. The runtime owns no wall clock; ticks arrive from outside. */
export interface RuntimeClock {
  fixedDeltaSeconds: number;
}

/** Whatever the host uses to turn a model binding into geometry. */
export interface ModelLoader {
  load(assetPath: string): unknown;
}

export interface RuntimeLogger {
  warn(message: string): void;
}

export interface InputSourceFactory {
  create(
    binding: CharacterControllerBindingDefinition,
    context: { tracks: readonly IntentTrackDefinition[]; replays: readonly ReplayDefinition[] },
  ): CharacterIntentSource;
}

export interface GameObjectRuntimeServices {
  animationRegistry: AnimationAssetRegistry;
  prefabRegistry: PrefabAssetRegistry;
  modelLoader?: ModelLoader;
  inputSourceFactory?: InputSourceFactory;
  clock: RuntimeClock;
  logger?: RuntimeLogger;
  /** Ground the character motor probes against. */
  terrain?: TerrainPreset;
  gameplayRegistry?: GameplayScriptRegistry;
  gameplayWorld?: GameplayWorld;
}
