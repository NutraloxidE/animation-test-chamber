/**
 * Component runtimes (§9.4).
 *
 * A typed factory registry, one factory per component type. The registry is the
 * reason "everything is a GameObject" does not collapse into a switch statement
 * somewhere in the renderer: a component knows how to become a runtime, and the
 * host asks for one by type rather than by asking what kind of entity this is.
 *
 * `tags` deliberately has no factory. It is authoring metadata, and a runtime
 * for it would exist only so the table looked complete.
 */
import type {
  AnimatorComponent,
  AssetIssue,
  CameraComponent,
  CapsuleColliderComponent,
  CharacterMotorComponent,
  EquipmentSocketsComponent,
  GameObjectComponentDefinition,
  LightComponent,
  ModelRendererComponent,
  ProjectDefinition,
  RenderableModelBinding,
} from '@atc/schema';
import type { ResolvedAnimationBundle } from '@atc/animation-asset-runtime';
import {
  resolveAnimatorPlayback,
  type AnimatorPlaybackPlan,
} from './animator-playback.ts';
import type { GameObjectRuntimeServices } from './services.ts';

/**
 * The context a factory is handed. Never the Scene, never the document.
 *
 * `project` is the exception that proves the rule: it is project-level *policy*
 * — movement, root motion, terrain, camera, equipment — that the animation
 * resolver reads, and an Animator that could not see it would have to resolve
 * its clips against a project it invented. It is read, never written; a
 * component that mutated it would be a tick writing into a document.
 */
export interface ComponentRuntimeContext {
  gameObjectId: string;
  displayName: string;
  nodeId: string;
  nodePath: string;
  project: ProjectDefinition;
  services: GameObjectRuntimeServices;
}

/**
 * What a component runtime is told about the passage of time (§4.4).
 *
 * Both numbers, always, because they answer different questions and neither
 * can be derived from the other by a component that does not already know the
 * clock. `tick` is the simulation's integer step — what a replay indexes and
 * what a trace records. `deltaSeconds` is how much time that step represents,
 * and it comes from `GameObjectRuntimeServices.clock.fixedDeltaSeconds`.
 *
 * These used to be one number. Nothing broke, because no built-in component
 * integrates against time yet — which is precisely why it had to be fixed
 * before one does: the first Audio or Particle component would have advanced
 * sixty times too fast and looked like a tuning problem.
 */
export interface RuntimeComponentStepContext {
  tick: number;
  deltaSeconds: number;
}

export interface RuntimeComponent {
  componentId: string;
  componentType: string;
  enabled: boolean;
  step?(context: RuntimeComponentStepContext): void;
  dispose?(): void;
}

export interface ComponentRuntimeFactory<
  TDefinition extends GameObjectComponentDefinition = GameObjectComponentDefinition,
  TRuntime extends RuntimeComponent = RuntimeComponent,
> {
  componentType: TDefinition['componentType'];
  create(definition: TDefinition, context: ComponentRuntimeContext): TRuntime;
}

/* -------------------------------------------------------------------------- */
/* The built-in runtimes                                                      */
/* -------------------------------------------------------------------------- */

/**
 * What the renderer needs and nothing more.
 *
 * The binding is carried through verbatim. The renderer does *not* look up a
 * Character id or a Prefab id in a model catalog (§10.2): the preset id or the
 * asset path arrived here from canonical Prefab data, so `/edit/prefab/<id>`
 * and the Viewport cannot disagree about who is on screen.
 */
export class ModelRendererRuntime implements RuntimeComponent {
  readonly componentType = 'model-renderer';
  readonly componentId: string;
  readonly model: RenderableModelBinding;
  readonly castShadow: boolean;
  readonly receiveShadow: boolean;
  /** Whatever the host's `ModelLoader` returned, if there was one. */
  readonly handle: unknown;
  enabled: boolean;

  constructor(definition: ModelRendererComponent, context: ComponentRuntimeContext) {
    this.componentId = definition.componentId;
    this.model = definition.model;
    this.castShadow = definition.castShadow;
    this.receiveShadow = definition.receiveShadow;
    this.enabled = definition.enabled;
    this.handle =
      definition.model.kind === 'repository-model'
        ? context.services.modelLoader?.load(definition.model.assetPath)
        : undefined;
  }
}

/**
 * The Animator.
 *
 * The animation *engine* is still not duplicated here (§9.5). When the object
 * also carries a `character-motor`, the existing `ControllableCharacter` owns
 * the state machine and this runtime contributes the resolved playback plan the
 * renderer binds clips through. When it does not — an animated prop, a windmill,
 * a looping banner — nothing else is driving the graph, so this runtime holds
 * the one piece of state such an object needs: how far into its clip it is.
 *
 * That time advances from `deltaSeconds`, which arrives from
 * `GameObjectRuntimeServices.clock.fixedDeltaSeconds` (§4.4). It is deliberately
 * *not* read from a wall clock: the rest of the simulation is fixed-step, and an
 * animation that advanced by real elapsed time would make two runs of the same
 * replay show different poses at the same tick.
 */
export class AnimatorRuntime implements RuntimeComponent {
  readonly componentType = 'animator';
  readonly componentId: string;
  readonly assignment: AnimatorComponent['assignment'];
  readonly defaultContextKey: string | undefined;
  /** What this Animator plays, per graph state (§10.4). Resolved once. */
  readonly playback: AnimatorPlaybackPlan;
  /** The shared half of the resolution, so the object beside it resolves once. */
  readonly bundle: ResolvedAnimationBundle;
  /** Resolution problems, surfaced rather than thrown. */
  readonly issues: AssetIssue[];
  enabled: boolean;

  /** Seconds of animation this Animator has advanced. Per instance, never shared. */
  private elapsed = 0;

  constructor(definition: AnimatorComponent, context: ComponentRuntimeContext) {
    this.componentId = definition.componentId;
    this.assignment = definition.assignment;
    this.defaultContextKey = definition.defaultContextKey;
    this.enabled = definition.enabled;

    const resolved = resolveAnimatorPlayback({
      registry: context.services.animationRegistry,
      project: context.project,
      assignment: definition.assignment,
      defaultContextKey: definition.defaultContextKey,
      identity: {
        gameObjectId: context.gameObjectId,
        displayName: context.displayName,
        componentId: definition.componentId,
      },
    });
    this.playback = resolved.plan;
    this.bundle = resolved.bundle;
    this.issues = resolved.issues;
  }

  /** Seconds of animation elapsed. Zero at instantiation and after a reset. */
  get animationSeconds(): number {
    return this.elapsed;
  }

  /**
   * Where in its clip an Animator-only object currently is, in [0, 1).
   *
   * Undefined when the plan binds no clip to the state, which is the honest
   * answer: there is nothing to be part-way through. The renderer surfaces that
   * as an issue rather than playing something else (§10.5).
   */
  normalizedTimeFor(stateId: string): number | undefined {
    const duration = this.playback.durationByStateId[stateId];
    if (duration === undefined || duration <= 0) return undefined;
    const looping = this.playback.loopByStateId[stateId] ?? true;
    const raw = this.elapsed / duration;
    return looping ? raw - Math.floor(raw) : Math.min(raw, 1);
  }

  step(context: RuntimeComponentStepContext): void {
    this.elapsed += context.deltaSeconds;
  }
}

export class CharacterMotorRuntime implements RuntimeComponent {
  readonly componentType = 'character-motor';
  readonly componentId: string;
  readonly intentChannel: string;
  readonly movementScale: number;
  readonly turnScale: number;
  enabled: boolean;

  constructor(definition: CharacterMotorComponent) {
    this.componentId = definition.componentId;
    this.intentChannel = definition.intentChannel;
    this.movementScale = definition.movementScale;
    this.turnScale = definition.turnScale;
    this.enabled = definition.enabled;
  }
}

export class CapsuleColliderRuntime implements RuntimeComponent {
  readonly componentType = 'capsule-collider';
  readonly componentId: string;
  readonly radius: number;
  readonly height: number;
  readonly center: CapsuleColliderComponent['center'];
  enabled: boolean;

  constructor(definition: CapsuleColliderComponent) {
    this.componentId = definition.componentId;
    this.radius = definition.radius;
    this.height = definition.height;
    this.center = definition.center;
    this.enabled = definition.enabled;
  }
}

/**
 * Sockets, and what is currently in them.
 *
 * `attachments` is the one mutable member, and it is mutable *here* rather than
 * in the Prefab for exactly the reason §3.6 gives: what a character is holding
 * right now changes on a tick, and a Prefab that recorded it would be a
 * document that differed after a million ticks.
 */
export class EquipmentSocketsRuntime implements RuntimeComponent {
  readonly componentType = 'equipment-sockets';
  readonly componentId: string;
  readonly sockets: EquipmentSocketsComponent['sockets'];
  /** socketId -> whatever the host attached. Per instance, never shared. */
  readonly attachments = new Map<string, unknown>();
  enabled: boolean;

  constructor(definition: EquipmentSocketsComponent) {
    this.componentId = definition.componentId;
    this.sockets = definition.sockets;
    this.enabled = definition.enabled;
  }

  attach(socketId: string, item: unknown): void {
    this.attachments.set(socketId, item);
  }

  dispose(): void {
    this.attachments.clear();
  }
}

export class CameraRuntime implements RuntimeComponent {
  readonly componentType = 'camera';
  readonly componentId: string;
  readonly projection: CameraComponent['projection'];
  readonly fieldOfViewDeg: number | undefined;
  readonly orthographicSize: number | undefined;
  enabled: boolean;

  constructor(definition: CameraComponent) {
    this.componentId = definition.componentId;
    this.projection = definition.projection;
    this.fieldOfViewDeg = definition.fieldOfViewDeg;
    this.orthographicSize = definition.orthographicSize;
    this.enabled = definition.enabled;
  }
}

export class LightRuntime implements RuntimeComponent {
  readonly componentType = 'light';
  readonly componentId: string;
  readonly lightType: LightComponent['lightType'];
  readonly intensity: number;
  readonly color: string;
  readonly range: number | undefined;
  readonly spotAngleRad: number | undefined;
  enabled: boolean;

  constructor(definition: LightComponent) {
    this.componentId = definition.componentId;
    this.lightType = definition.lightType;
    this.intensity = definition.intensity;
    this.color = definition.color;
    this.range = definition.range;
    this.spotAngleRad = definition.spotAngleRad;
    this.enabled = definition.enabled;
  }
}

/* -------------------------------------------------------------------------- */
/* The registry                                                               */
/* -------------------------------------------------------------------------- */

export class ComponentRuntimeRegistry {
  private readonly factories = new Map<string, ComponentRuntimeFactory>();

  constructor(factories: readonly ComponentRuntimeFactory[] = []) {
    for (const factory of factories) this.register(factory);
  }

  register(factory: ComponentRuntimeFactory): void {
    if (this.factories.has(factory.componentType)) {
      throw new Error(`component runtime for "${factory.componentType}" is already registered`);
    }
    this.factories.set(factory.componentType, factory);
  }

  /** Undefined means "no runtime for this type", which is legal for `tags`. */
  create(
    definition: GameObjectComponentDefinition,
    context: ComponentRuntimeContext,
  ): RuntimeComponent | undefined {
    return this.factories.get(definition.componentType)?.create(definition, context);
  }
}

/**
 * A registry with the built-ins.
 *
 * A *function* rather than a shared constant: two runtimes sharing one registry
 * object would share whatever a host later registered into it, and the whole
 * point of this layer is that two instantiations share nothing mutable.
 */
export function defaultComponentRuntimeRegistry(): ComponentRuntimeRegistry {
  return new ComponentRuntimeRegistry([
    {
      componentType: 'model-renderer',
      create: (definition, context) =>
        new ModelRendererRuntime(definition as ModelRendererComponent, context),
    },
    {
      componentType: 'animator',
      create: (definition, context) =>
        new AnimatorRuntime(definition as AnimatorComponent, context),
    },
    {
      componentType: 'character-motor',
      create: (definition) => new CharacterMotorRuntime(definition as CharacterMotorComponent),
    },
    {
      componentType: 'capsule-collider',
      create: (definition) => new CapsuleColliderRuntime(definition as CapsuleColliderComponent),
    },
    {
      componentType: 'equipment-sockets',
      create: (definition) => new EquipmentSocketsRuntime(definition as EquipmentSocketsComponent),
    },
    {
      componentType: 'camera',
      create: (definition) => new CameraRuntime(definition as CameraComponent),
    },
    {
      componentType: 'light',
      create: (definition) => new LightRuntime(definition as LightComponent),
    },
  ] as ComponentRuntimeFactory[]);
}
