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
 *
 * ## The transform convention
 *
 * Two transforms, and the distinction is load-bearing:
 *
 *   `localTransform`  where this object sits relative to its parent. For the
 *                     root of a Scene instance that is the instance's authored
 *                     placement; for a child node it is the node's authored
 *                     offset inside the Prefab.
 *   `worldTransform`  derived, never stored: `compose(parent.world, local)`.
 *
 * Derived rather than cached because a parent that moves must carry its
 * children with it (§4.2). Freezing a child at its initially composed position
 * would make a lantern stay where the character was standing when the Scene
 * loaded, which is the bug this convention exists to make unrepresentable.
 *
 * The one exception is a node whose `CharacterMotor` is driving it. A character
 * simulation is world-authoritative — it integrates velocity against terrain in
 * world space — so such a node reports the simulation's transform as its world
 * transform and is *not* carried by its parent. Its children still compose from
 * it, which is what makes "character carrying a lantern" work.
 */
import type {
  IntentTrackDefinition,
  ProjectDefinition,
  ReplayDefinition,
  TerrainPreset,
  TransformDefinition,
} from '@atc/schema';
import { componentOfType } from '@atc/schema';
import { materializeResolvedProject, resolveCharacterAnimationBundle } from '@atc/animation-asset-runtime';
import type { AssetIssue } from '@atc/schema';
import {
  ControllableCharacter,
  buildCharacterIntentSource,
  neutralSource,
  seedOf,
  type CharacterIntentSource,
} from '@atc/character-control-runtime';
import { composeTransforms, type ResolvedPrefabNode } from '@atc/prefab-runtime';
import { characterViewOfGameObject, projectForGameObjectResolution } from './character-adapter.ts';
import {
  ComponentRuntimeRegistry,
  defaultComponentRuntimeRegistry,
  type RuntimeComponent,
} from './components.ts';
import type { ResolvedGameObjectDefinition } from './definition.ts';
import type { GameObjectRuntimeServices } from './services.ts';

/** What the host supplies per tick. Seconds come from the clock, not from here. */
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
  /** Set by the parent when instantiating a child node. Never by a host. */
  parent?: RuntimeGameObject;
}

function cloneTransform(transform: TransformDefinition): TransformDefinition {
  return {
    position: { ...transform.position },
    rotation: { ...transform.rotation },
    scale: { ...transform.scale },
  };
}

export class RuntimeGameObject {
  readonly id: string;
  readonly definition: ResolvedGameObjectDefinition;
  readonly parent: RuntimeGameObject | undefined;
  /**
   * Placement relative to the parent, mutable.
   *
   * A host that moves a static object writes here. A host that moves a
   * character writes through the character's own controls instead — the
   * simulation owns that node's world placement.
   */
  readonly localTransform: TransformDefinition;
  readonly components: RuntimeComponent[] = [];
  readonly children: RuntimeGameObject[] = [];
  /** Present only when *this node* composes Animator + CharacterMotor (§9.5). */
  readonly character: ControllableCharacter | undefined;
  readonly intentSource: CharacterIntentSource | undefined;
  /** Animation-resolution problems, surfaced rather than thrown. */
  readonly issues: AssetIssue[] = [];

  private readonly services: GameObjectRuntimeServices;
  /** The simulation's world placement, while a character owns this node. */
  private simulatedWorld: TransformDefinition | undefined;
  private disposed = false;

  constructor(options: InstantiateGameObjectOptions) {
    const { definition, services } = options;
    this.id = definition.gameObjectId;
    this.definition = definition;
    this.parent = options.parent;
    this.services = services;
    /*
     * Every object's local transform is *its node's* transform. The root is the
     * one place two authored transforms meet: the Scene instance says where the
     * object stands, and the Prefab's root node says how the Prefab's contents
     * sit relative to that. Both are real authored placements (§4.3), so they
     * compose — using only the instance transform would silently discard a
     * Prefab root offset, and using only the node transform would put every
     * instance of a Prefab in the same place.
     */
    this.localTransform = options.parent
      ? cloneTransform(definition.root.transform)
      : composeTransforms(definition.transform, definition.root.transform);

    const registry = options.componentRuntimes ?? defaultComponentRuntimeRegistry();
    this.buildComponents(definition.root, registry, services);
    for (const child of definition.root.children) {
      this.children.push(
        new RuntimeGameObject({
          ...options,
          parent: this,
          definition: {
            ...definition,
            gameObjectId: `${definition.gameObjectId}/${child.nodeId}`,
            // The child's *local* transform. Composition happens on read, so a
            // parent that moves later carries the child with it.
            transform: child.transform,
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
    // A character spawns at its *world* placement, not its local one: the
    // simulation integrates against world-space terrain, and seeding it with a
    // local offset would drop a child character through the floor.
    const spawn = this.worldTransform;
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
          initialTransform: spawn,
          terrain,
          intentSource: this.intentSource,
          seed: seedOf(definition.gameObjectId),
          ...(view.defaultContextKey
            ? { overrides: { weaponModeId: view.defaultContextKey } }
            : {}),
        })
      : undefined;
    if (this.character) this.simulatedWorld = cloneTransform(spawn);
  }

  /**
   * Where this object actually is, in world space.
   *
   * Composed on read rather than cached. The cost is one composition per
   * ancestor per read; the alternative is an invalidation protocol, and a stale
   * cached world transform is exactly the failure that looks like "the lantern
   * did not follow" long after the code that moved the parent has been
   * forgotten.
   */
  get worldTransform(): TransformDefinition {
    if (this.simulatedWorld) return cloneTransform(this.simulatedWorld);
    if (!this.parent) return cloneTransform(this.localTransform);
    return composeTransforms(this.parent.worldTransform, this.localTransform);
  }

  /** Moves this object relative to its parent. Children follow on next read. */
  setLocalTransform(transform: TransformDefinition): void {
    this.localTransform.position = { ...transform.position };
    this.localTransform.rotation = { ...transform.rotation };
    this.localTransform.scale = { ...transform.scale };
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
   *
   * Components receive a *context*, not a bare number (§4.4). One number that
   * meant "tick" to the runtime and "seconds" to a component is the kind of
   * ambiguity that stays latent until the first component integrates against
   * it and drifts by a factor of sixty.
   */
  step(context: GameObjectStepContext): void {
    if (this.disposed || !this.definition.enabled) return;
    if (this.character) {
      this.character.step(context.tick, { cameraYawRad: context.cameraYawRad });
      this.simulatedWorld = cloneTransform(this.character.observe().transform);
    }
    const componentContext = {
      tick: context.tick,
      deltaSeconds: this.services.clock.fixedDeltaSeconds,
    };
    for (const component of this.components) component.step?.(componentContext);
    for (const child of this.children) child.step(context);
  }

  componentRuntime(componentId: string): RuntimeComponent | undefined {
    return this.components.find((component) => component.componentId === componentId);
  }

  /** This object and every descendant, in deterministic declaration order. */
  walk(): RuntimeGameObject[] {
    return [this, ...this.children.flatMap((child) => child.walk())];
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
