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
  JsonObject,
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
import type { GameplayEvent, GameplayObjectView, GameplayWorld } from '@atc/gameplay-sdk';
import { GameplayScriptRuntime } from './gameplay-script-runtime.ts';

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
  private queuedEvents: Array<{ target: string; event: GameplayEvent }> = [];
  private pendingEvents: Array<{ target: string; event: GameplayEvent }> = [];
  private pendingSpawns: RuntimeSpawnRequest[] = [];
  private pendingDespawns: string[] = [];
  private readonly maxOperationsPerTick = 1024;
  private readonly gameplayWorld: GameplayWorld;

  constructor(private readonly options: InstantiateSceneOptions) {
    this.id = options.scene.id;
    this.gameplayWorld = {
      get: (id) => this.objectView(id),
      findByTag: (tag) => this.gameObjects.flatMap((root) => root.walk()).filter((object) => object.definition.root.components.some((component) => component.componentType === 'tags' && component.tags.includes(tag))).map((object) => ({ id: object.id, tags: this.tagsOf(object), transform: object.worldTransform })),
      emit: (target, event) => { this.guardBudget(this.pendingEvents.length, 'event'); this.pendingEvents.push({ target, event: structuredClone(event) }); },
      spawn: (request) => { this.guardBudget(this.pendingSpawns.length, 'spawn'); this.pendingSpawns.push(request); },
      despawn: (id) => { this.guardBudget(this.pendingDespawns.length, 'despawn'); this.pendingDespawns.push(id); },
    };
    this.build();
  }

  private runtimeServices(): GameObjectRuntimeServices { return { ...this.options.services, gameplayWorld: this.gameplayWorld }; }
  private guardBudget(count: number, operation: string): void { if (count >= this.maxOperationsPerTick) throw new Error(`gameplay ${operation} budget exceeded in scene "${this.id}"`); }
  private tagsOf(object: RuntimeGameObject): string[] { return object.definition.root.components.flatMap((component) => component.componentType === 'tags' ? component.tags : []); }
  private objectView(id: string): GameplayObjectView | undefined { const object = this.get(id) ?? this.gameObjects.flatMap((root) => root.walk()).find((entry) => entry.id === id); return object ? { id: object.id, tags: this.tagsOf(object), transform: object.worldTransform } : undefined; }

  private build(): void {
    const resolved = resolveSceneGameObjects({
      prefabRegistry: this.options.services.prefabRegistry,
      scene: this.options.scene,
    });
    this.issues.push(...resolved.issues);
    for (const definition of resolved.definitions) {
      this.objectsById.set(
        definition.gameObjectId,
        instantiateGameObject({
          definition,
          services: this.runtimeServices(),
          project: this.options.project,
          ...(this.options.terrain ? { terrain: this.options.terrain } : {}),
          tracks: this.options.scene.intentTracks,
          replays: this.options.replays ?? [],
          ...(this.options.componentRuntimes
            ? { componentRuntimes: this.options.componentRuntimes }
            : {}),
        }),
      );
    }
    for (const gameObject of this.objectsById.values()) gameObject.start({ tick: 0, cameraYawRad: 0 });
  }

  /**
   * Rebuilds every object at tick 0 from the same canonical Scene.
   *
   * A full rebuild rather than a pass that walks the tree setting fields back to
   * zero. Runtime state lives in enough places — a `Simulation`'s private
   * integrator, an intent source's cursor, an Animator's elapsed seconds — that
   * a hand-written reset would be a second, quietly divergent constructor, and
   * the first field somebody forgot would make "Reset" leave the scene subtly
   * ahead of where it started.
   *
   * The canonical Scene is untouched, exactly as `despawn` leaves it: resetting
   * a preview must not author a document change.
   */
  reset(): void {
    this.dispose();
    this.issues.length = 0;
    this.tick = 0;
    this.build();
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
    for (const queued of this.queuedEvents) this.objectsById.get(queued.target)?.dispatchGameplayEvent({ tick, cameraYawRad: context.cameraYawRad }, queued.event);
    this.queuedEvents = [];
    for (const gameObject of this.objectsById.values()) {
      gameObject.step({ tick, cameraYawRad: context.cameraYawRad });
    }
    for (const id of this.pendingDespawns) this.despawn(id);
    for (const request of this.pendingSpawns) this.instantiate(request);
    this.pendingDespawns = [];
    this.pendingSpawns = [];
    this.queuedEvents = this.pendingEvents;
    this.pendingEvents = [];
    this.tick = tick + 1;
  }

  emit(targetGameObjectId: string, event: GameplayEvent): void { this.gameplayWorld.emit(targetGameObjectId, event); }
  gameplaySnapshot(): Record<string, Record<string, JsonObject>> {
    const snapshot: Record<string, Record<string, JsonObject>> = {};
    for (const root of this.objectsById.values()) for (const object of root.walk()) for (const component of object.components) if (component instanceof GameplayScriptRuntime) (snapshot[object.id] ??= {})[component.componentId] = component.snapshot();
    return snapshot;
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
      services: this.runtimeServices(),
      project: this.options.project,
      ...(this.options.terrain ? { terrain: this.options.terrain } : {}),
      tracks: this.options.scene.intentTracks,
      replays: this.options.replays ?? [],
      ...(this.options.componentRuntimes
        ? { componentRuntimes: this.options.componentRuntimes }
        : {}),
    });
    this.objectsById.set(request.id, runtime);
    runtime.start({ tick: this.tick, cameraYawRad: 0 });
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
    this.queuedEvents = [];
    this.pendingEvents = [];
    this.pendingSpawns = [];
    this.pendingDespawns = [];
  }
}

export function instantiateScene(options: InstantiateSceneOptions): RuntimeScene {
  return new RuntimeScene(options);
}
