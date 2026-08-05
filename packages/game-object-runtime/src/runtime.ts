/**
 * `RuntimeGameObject` — the mutable layer, and the only one (§9.3, §9.6).
 *
 * Everything that changes on a tick lives here and nowhere else. The Prefab
 * asset, the Scene instance and the resolved definition are all the same
 * documents after a million ticks; a transform that has moved, a simulation
 * that has advanced and a socket that is holding something are all fields on
 * this object.
 *
 * Two instances of one Prefab share the immutable side — the Prefab document,
 * the resolved animation bundle, the source clips before cloning — and share
 * nothing mutable: separate `ControllableCharacter`, separate `Simulation`,
 * separate component runtimes, separate transform, separate attachments.
 * `tests/unit/game-objects/isolation.test.ts` asserts each of those by moving
 * one and checking the other did not follow.
 */
import type {
  IntentTrackDefinition,
  ProjectDefinition,
  ReplayDefinition,
  TerrainPreset,
  TransformDefinition,
} from '@atc/schema';
import { componentOfType, quaternionToYaw } from '@atc/schema';
import { materializeResolvedProject, resolveCharacterAnimationBundle } from '@atc/animation-asset-runtime';
import type { AssetIssue } from '@atc/schema';
import {
  ControllableCharacter,
  buildCharacterIntentSource,
  neutralSource,
  seedOf,
  type CharacterIntentSource,
} from '@atc/character-control-runtime';
import type { ResolvedPrefabNode } from '@atc/prefab-runtime';
import { characterViewOfGameObject, projectForGameObjectResolution } from './character-adapter.ts';
import {
  ComponentRuntimeRegistry,
  defaultComponentRuntimeRegistry,
  type RuntimeComponent,
} from './components.ts';
import type { ResolvedGameObjectDefinition } from './definition.ts';
import type { GameObjectRuntimeServices } from './services.ts';

/** The live transform. Starts at the authored one and is never written back. */
export interface RuntimeTransformState {
  position: { x: number; y: number; z: number };
  yawRad: number;
  scale: { x: number; y: number; z: number };
}

export interface GameObjectStepContext {
  tick: number;
  cameraYawRad: number;
}

export interface InstantiateGameObjectOptions {
  definition: ResolvedGameObjectDefinition;
  services: GameObjectRuntimeServices;
  /** Project-level policy the character half still reads (§7.3). */
  project: ProjectDefinition;
  terrain?: TerrainPreset;
  tracks?: readonly IntentTrackDefinition[];
  replays?: readonly ReplayDefinition[];
  componentRuntimes?: ComponentRuntimeRegistry;
}

export class RuntimeGameObject {
  readonly id: string;
  readonly definition: ResolvedGameObjectDefinition;
  readonly transformState: RuntimeTransformState;
  readonly components: RuntimeComponent[] = [];
  readonly children: RuntimeGameObject[] = [];
  /** Present only when the object composes Animator + CharacterMotor (§9.5). */
  readonly character: ControllableCharacter | undefined;
  readonly intentSource: CharacterIntentSource | undefined;
  /** Animation-resolution problems, surfaced rather than thrown. */
  readonly issues: AssetIssue[] = [];

  private disposed = false;

  constructor(options: InstantiateGameObjectOptions) {
    const { definition, services } = options;
    this.id = definition.gameObjectId;
    this.definition = definition;
    this.transformState = {
      position: { ...definition.transform.position },
      yawRad: quaternionToYaw(definition.transform.rotation),
      scale: { ...definition.transform.scale },
    };

    const registry = options.componentRuntimes ?? defaultComponentRuntimeRegistry();
    this.buildComponents(definition.root, registry, services);
    for (const child of definition.root.children) {
      this.children.push(
        new RuntimeGameObject({
          ...options,
          definition: {
            ...definition,
            gameObjectId: `${definition.gameObjectId}/${child.nodeId}`,
            root: child,
            // A child node is part of this object, not a separate placement, so
            // it carries no binding and no relation of its own.
            bindings: {},
            relations: {},
          },
        }),
      );
    }

    /*
     * The node's *own* components, not the subtree's.
     *
     * Each child node becomes its own `RuntimeGameObject` above, so asking the
     * whole subtree here would build two characters for one motor: once on the
     * child that declares it, and again on every ancestor that can see it.
     * `isCharacterGameObject` deliberately still asks the tree-wide question —
     * "does this Prefab contain a character?" is what the Prefab list filters
     * on, and it is a different question from "does this node drive one?".
     */
    const ownComponents = definition.root.components;
    const motor = componentOfType(ownComponents, 'character-motor');
    const view = motor
      ? characterViewOfGameObject({
          gameObjectId: definition.gameObjectId,
          displayName: definition.displayName,
          components: ownComponents,
        })
      : undefined;

    if (!view) {
      this.character = undefined;
      this.intentSource = undefined;
      return;
    }

    const project = projectForGameObjectResolution(options.project);
    const resolvedBundle = resolveCharacterAnimationBundle({
      registry: services.animationRegistry,
      project,
      character: view.character,
    });
    this.issues.push(...resolvedBundle.issues);

    const binding = definition.bindings.characterIntent;
    this.intentSource = binding
      ? (options.services.inputSourceFactory?.create(binding, {
          tracks: options.tracks ?? [],
          replays: options.replays ?? [],
        }) ??
        buildCharacterIntentSource(
          binding,
          byId(options.tracks ?? []),
          byId(options.replays ?? []),
        ))
      : neutralSource();

    const terrain = options.terrain ?? services.terrain;
    this.character = terrain
      ? new ControllableCharacter({
          instanceId: definition.gameObjectId,
          // A fresh resolved document per object, around a bundle that may be
          // shared. The bundle carries no identity; this wrapper carries all of it.
          resolvedProject: materializeResolvedProject({
            project: options.project,
            character: view.character,
            bundle: resolvedBundle.bundle,
          }),
          initialTransform: definition.transform,
          terrain,
          intentSource: this.intentSource,
          seed: seedOf(definition.gameObjectId),
          ...(view.defaultContextKey
            ? { overrides: { weaponModeId: view.defaultContextKey } }
            : {}),
        })
      : undefined;
  }

  private buildComponents(
    node: ResolvedPrefabNode,
    registry: ComponentRuntimeRegistry,
    services: GameObjectRuntimeServices,
  ): void {
    for (const component of node.components) {
      const runtime = registry.create(component, {
        gameObjectId: this.id,
        nodeId: node.nodeId,
        nodePath: node.nodePath,
        services,
      });
      // `tags` has no factory by design; a component type nobody registered a
      // runtime for contributes nothing rather than failing instantiation.
      if (runtime) this.components.push(runtime);
    }
  }

  /**
   * Advances exactly one fixed step.
   *
   * A disabled object does not tick — the same rule the entity contract had,
   * and the reason it stays inspectable: `enabled: false` is a statement about
   * simulation, not about existence.
   */
  step(context: GameObjectStepContext): void {
    if (this.disposed || !this.definition.enabled) return;
    if (this.character) {
      this.character.step(context.tick, { cameraYawRad: context.cameraYawRad });
      const observed = this.character.observe();
      this.transformState.position = { ...observed.transform.position };
      this.transformState.yawRad = quaternionToYaw(observed.transform.rotation);
    }
    for (const component of this.components) component.step?.(context.tick);
    for (const child of this.children) child.step(context);
  }

  /** Live transform, in the shape the rest of the system reads transforms in. */
  observeTransform(): TransformDefinition {
    const half = this.transformState.yawRad / 2;
    return {
      position: { ...this.transformState.position },
      rotation: { x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) },
      scale: { ...this.transformState.scale },
    };
  }

  componentRuntime(componentId: string): RuntimeComponent | undefined {
    return this.components.find((component) => component.componentId === componentId);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const child of this.children) child.dispose();
    for (const component of this.components) component.dispose?.();
  }
}

export function instantiateGameObject(options: InstantiateGameObjectOptions): RuntimeGameObject {
  return new RuntimeGameObject(options);
}

/** Id-keyed view of a declaration-ordered list, as the intent builder wants it. */
function byId<T extends { id: string }>(items: readonly T[]): ReadonlyMap<string, T> {
  return new Map(items.map((item) => [item.id, item]));
}
