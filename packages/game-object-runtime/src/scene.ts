/**
 * A whole Scene of GameObjects (§15.2, §15.3).
 *
 * The game-facing entry point. A host loads a Scene, instantiates it, and steps
 * it; nothing in this file knows about the editor, a route, React, Three.js or
 * a Character.
 *
 * Spawn and despawn are *runtime* operations (§15.3). They do not touch the
 * canonical Scene: a game that spawned a projectile must not thereby author a
 * document change, or every session would end with a diff nobody made.
 */
import type {
  GameObjectInstanceDefinition,
  ProjectDefinition,
  ReplayDefinition,
  SceneDefinition,
  TerrainPreset,
  TransformDefinition,
} from '@atc/schema';
import type { PrefabIssue } from '@atc/prefab-runtime';
import { resolveGameObjectInstance, resolveSceneGameObjects } from './definition.ts';
import { ComponentRuntimeRegistry } from './components.ts';
import { RuntimeGameObject, instantiateGameObject, type GameObjectStepContext } from './runtime.ts';
import type { GameObjectRuntimeServices } from './services.ts';

export interface InstantiateSceneOptions {
  scene: SceneDefinition;
  project: ProjectDefinition;
  services: GameObjectRuntimeServices;
  terrain?: TerrainPreset;
  replays?: readonly ReplayDefinition[];
  componentRuntimes?: ComponentRuntimeRegistry;
}

export interface RuntimeSpawnRequest {
  id: string;
  prefab: GameObjectInstanceDefinition['prefab'];
  transform: TransformDefinition;
  displayName?: string;
  bindings?: GameObjectInstanceDefinition['bindings'];
  relations?: GameObjectInstanceDefinition['relations'];
  componentOverrides?: GameObjectInstanceDefinition['componentOverrides'];
}

export class RuntimeScene {
  readonly id: string;
  readonly issues: PrefabIssue[] = [];
  private readonly objectsById = new Map<string, RuntimeGameObject>();
  /** Declaration order is tick order; a Map preserves insertion order. */
  private tick = 0;

  constructor(private readonly options: InstantiateSceneOptions) {
    this.id = options.scene.id;
    const resolved = resolveSceneGameObjects({
      prefabRegistry: options.services.prefabRegistry,
      scene: options.scene,
    });
    this.issues.push(...resolved.issues);
    for (const definition of resolved.definitions) {
      this.objectsById.set(
        definition.gameObjectId,
        instantiateGameObject({
          definition,
          services: options.services,
          project: options.project,
          ...(options.terrain ? { terrain: options.terrain } : {}),
          tracks: options.scene.intentTracks,
          replays: options.replays ?? [],
          ...(options.componentRuntimes ? { componentRuntimes: options.componentRuntimes } : {}),
        }),
      );
    }
  }

  get gameObjects(): RuntimeGameObject[] {
    return [...this.objectsById.values()];
  }

  get(gameObjectId: string): RuntimeGameObject | undefined {
    return this.objectsById.get(gameObjectId);
  }

  /** The camera the Scene plays through, by GameObject id. */
  get activeCamera(): RuntimeGameObject | undefined {
    const id = this.options.scene.activeCameraGameObjectId;
    return id === undefined ? undefined : this.objectsById.get(id);
  }

  step(context: Omit<GameObjectStepContext, 'tick'> & { tick?: number }): void {
    const tick = context.tick ?? this.tick;
    for (const gameObject of this.objectsById.values()) {
      gameObject.step({ tick, cameraYawRad: context.cameraYawRad });
    }
    this.tick = tick + 1;
  }

  /**
   * Spawns one object at runtime.
   *
   * Refuses a duplicate id rather than replacing: an id collision means two
   * systems believe they own the same object, and silently letting the second
   * win is how the first one's handle becomes a reference to something that no
   * longer ticks.
   */
  instantiate(request: RuntimeSpawnRequest): RuntimeGameObject {
    if (this.objectsById.has(request.id)) {
      throw new Error(`a GameObject "${request.id}" is already in scene "${this.id}"`);
    }
    const instance: GameObjectInstanceDefinition = {
      schemaVersion: 2,
      id: request.id,
      displayName: request.displayName ?? request.id,
      enabled: true,
      prefab: request.prefab,
      transform: request.transform,
      componentOverrides: request.componentOverrides ?? [],
      bindings: request.bindings ?? {},
      relations: request.relations ?? {},
    };
    const resolved = resolveGameObjectInstance({
      prefabRegistry: this.options.services.prefabRegistry,
      instance,
    });
    const errors = resolved.issues.filter((issue) => issue.severity === 'error');
    if (errors.length > 0) {
      throw new Error(
        `cannot instantiate "${request.id}":\n${errors.map((issue) => `  - [${issue.code}] ${issue.message}`).join('\n')}`,
      );
    }
    const runtime = instantiateGameObject({
      definition: resolved.definition,
      services: this.options.services,
      project: this.options.project,
      ...(this.options.terrain ? { terrain: this.options.terrain } : {}),
      tracks: this.options.scene.intentTracks,
      replays: this.options.replays ?? [],
      ...(this.options.componentRuntimes
        ? { componentRuntimes: this.options.componentRuntimes }
        : {}),
    });
    this.objectsById.set(request.id, runtime);
    return runtime;
  }

  /** Removes and disposes one object. The canonical Scene is untouched. */
  despawn(gameObjectId: string): boolean {
    const runtime = this.objectsById.get(gameObjectId);
    if (!runtime) return false;
    runtime.dispose();
    return this.objectsById.delete(gameObjectId);
  }

  dispose(): void {
    for (const runtime of this.objectsById.values()) runtime.dispose();
    this.objectsById.clear();
  }
}

export function instantiateScene(options: InstantiateSceneOptions): RuntimeScene {
  return new RuntimeScene(options);
}
