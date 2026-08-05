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
  CameraComponent,
  CapsuleColliderComponent,
  CharacterMotorComponent,
  EquipmentSocketsComponent,
  GameObjectComponentDefinition,
  LightComponent,
  ModelRendererComponent,
  RenderableModelBinding,
} from '@atc/schema';
import type { GameObjectRuntimeServices } from './services.ts';

/** The context a factory is handed. Never the Scene, never the document. */
export interface ComponentRuntimeContext {
  gameObjectId: string;
  nodeId: string;
  nodePath: string;
  services: GameObjectRuntimeServices;
}

export interface RuntimeComponent {
  componentId: string;
  componentType: string;
  enabled: boolean;
  step?(deltaSeconds: number): void;
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
 * The Animator's *authored* half.
 *
 * The actual animation engine is not duplicated here (§9.5): when the object
 * also carries a `character-motor`, `CharacterGameObjectRuntime` composes the
 * existing `ControllableCharacter` and this runtime just carries the assignment
 * the renderer and the Inspector need to name what is playing.
 */
export class AnimatorRuntime implements RuntimeComponent {
  readonly componentType = 'animator';
  readonly componentId: string;
  readonly assignment: AnimatorComponent['assignment'];
  readonly defaultContextKey: string | undefined;
  enabled: boolean;

  constructor(definition: AnimatorComponent) {
    this.componentId = definition.componentId;
    this.assignment = definition.assignment;
    this.defaultContextKey = definition.defaultContextKey;
    this.enabled = definition.enabled;
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
      create: (definition) => new AnimatorRuntime(definition as AnimatorComponent),
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
