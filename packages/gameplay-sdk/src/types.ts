import type {
  ButtonAction,
  JsonObject,
  GameplayScriptReference,
  GameObjectPrefabReference,
  TransformDefinition,
  Vec3,
} from "@atc/schema";
import type { PropertiesOf, PropertyMap } from "./property.ts";

export interface GameplayEvent {
  type: string;
  payload: JsonObject;
  sourceGameObjectId?: string;
}
export interface GameplayWorld {
  get(gameObjectId: string): GameplayObjectView | undefined;
  findByTag(tag: string): GameplayObjectView[];
  emit(targetGameObjectId: string, event: GameplayEvent): void;
  spawn(request: {
    id: string;
    prefab: GameObjectPrefabReference;
    transform: TransformDefinition;
  }): void;
  despawn(gameObjectId: string): void;
}
export type GameplayCommandResult =
  | { ok: true }
  | {
      ok: false;
      code:
        | "not-a-character"
        | "simulation-owned-transform"
        | "invalid-command"
        | "invalid-parameter-name"
        | "operation-budget-exceeded"
        | "target-not-found"
        /**
         * The character's intent is owned by a device, a track or a replay, so
         * a Script may not also drive it. Refused rather than merged: two
         * authorities over one intent frame is exactly the ambiguity the single
         * `CharacterIntentSource` boundary exists to prevent.
         */
        | "intent-not-scriptable";
      message: string;
    };
/**
 * One frame of normalized intent, as a Script-driven AI produces it.
 *
 * Deliberately the same vocabulary a device sampler produces — sticks in
 * [-1, 1] and named button actions — so an AI decision and a human press reach
 * the state machine through one path. Omitted fields read as neutral, which is
 * what makes "walk forward without pressing anything" the default rather than
 * something a caller has to remember to clear.
 */
export interface GameplayIntentFrame {
  moveX?: number;
  moveY?: number;
  lookX?: number;
  lookY?: number;
  buttons?: Partial<Record<ButtonAction, boolean>>;
}
export type CharacterMotionCommand =
  | {
      type: "impulse";
      deltaVelocity: Vec3;
      space: "world" | "facing" | "camera";
    }
  | {
      type: "motion-override";
      key: string;
      velocity: Vec3;
      space: "world" | "facing" | "camera";
      durationTicks: number;
      priority?: number;
      horizontal: "replace" | "add";
      vertical: "preserve" | "replace" | "add";
      facing?: "preserve" | "velocity" | { yawRad: number };
    }
  | {
      type: "movement-scale";
      key: string;
      speedScale: number;
      accelerationScale?: number;
      turnScale?: number;
      durationTicks: number;
      priority?: number;
    }
  | {
      type: "teleport";
      position: Vec3;
      yawRad?: number;
      velocity: "preserve" | "clear";
    };
export interface GameplayCharacterSnapshot {
  tick: number;
  worldTransform: TransformDefinition;
  velocity: Vec3;
  grounded: boolean;
  locomotionStateId: string;
  actionStateId: string;
  intentSourceKind: string;
  /** The motion context the character is currently resolved for. */
  motionContextKey: string;
  gameplayParameters: Readonly<Record<string, boolean | number | string>>;
  activeMotionOverrides: readonly {
    key: string;
    sourceComponentId: string;
    remainingTicks: number;
    priority: number;
  }[];
  activeMovementScales: readonly {
    key: string;
    sourceComponentId: string;
    remainingTicks: number;
    priority: number;
  }[];
}
export interface GameplayCharacterApi {
  snapshot(): GameplayCharacterSnapshot;
  command(command: CharacterMotionCommand): GameplayCommandResult;
  /**
   * Drives one frame of normalized intent, for a character bound to an AI
   * channel.
   *
   * This is the *decision* half of "AI decisions belong in game code": the
   * Script decides what the character wants, and the same state machine, input
   * windows, recovery rules and root-motion policy a human drives then decide
   * what it does. A Script that reached for a clip instead would be
   * puppeteering an animation, which is the failure this boundary exists to
   * make unrepresentable.
   *
   * The frame is consumed by the character's next step, so the one-tick
   * latency is the same for every AI character and does not depend on
   * component order.
   */
  setIntent(intent: GameplayIntentFrame): GameplayCommandResult;
  /**
   * Switches the motion context (the demo's weapon mode) this character
   * resolves its clips in.
   *
   * Ordinary equipment is a game rule, but "which contextual take does this
   * state play" is animation resolution, and the resolver, the simulation and
   * the renderer must agree on it. So the Script names the context and the
   * existing contextual-binding machinery answers the rest.
   */
  setMotionContext(contextKey: string): GameplayCommandResult;
  setGameplayParameter(
    name: string,
    value: boolean | number | string,
    durationTicks?: number,
  ): GameplayCommandResult;
  clearGameplayParameter(name: string): GameplayCommandResult;
}
export interface GameplayTransformApi {
  world(): TransformDefinition;
  local(): TransformDefinition;
  setLocal(transform: TransformDefinition): GameplayCommandResult;
  translateLocal(delta: Vec3): GameplayCommandResult;
}
export interface GameplayObjectApi {
  readonly id: string;
  readonly tags: readonly string[];
  worldTransform(): TransformDefinition;
  readonly transform: GameplayTransformApi;
  readonly character?: GameplayCharacterApi;
}
export type GameplayObjectView = GameplayObjectApi;
export interface GameplayContext {
  tick: number;
  deltaSeconds: number;
  /** Camera yaw for this tick, in radians; the definition of "forward". */
  cameraYawRad: number;
  random(): number;
  self: GameplayObjectApi;
  world: GameplayWorld;
}
export interface GameplaySelf<
  Props extends JsonObject = JsonObject,
  State extends JsonObject = JsonObject,
> {
  readonly gameObjectId: string;
  readonly props: Props;
  readonly state: State;
}

export interface GameplayScriptDefinition<
  P extends PropertyMap = PropertyMap,
  S extends JsonObject = JsonObject,
> {
  id: string;
  version: string;
  displayName: string;
  properties: P;
  state: (input: { props: PropertiesOf<P> }) => S;
  events?: Record<string, PropertyMap>;
  start?(
    ctx: GameplayContext,
    self: GameplaySelf<PropertiesOf<P> & JsonObject, S>,
  ): void;
  fixedUpdate?(
    ctx: GameplayContext,
    self: GameplaySelf<PropertiesOf<P> & JsonObject, S>,
  ): void;
  onEvent?(
    ctx: GameplayContext,
    self: GameplaySelf<PropertiesOf<P> & JsonObject, S>,
    event: GameplayEvent,
  ): void;
  dispose?(self: GameplaySelf<PropertiesOf<P> & JsonObject, S>): void;
}

export function defineGameplayScript<
  P extends PropertyMap,
  S extends JsonObject,
>(definition: GameplayScriptDefinition<P, S>): GameplayScriptDefinition {
  return definition as unknown as GameplayScriptDefinition;
}

export interface RegisteredGameplayScript {
  reference: GameplayScriptReference;
  definition: GameplayScriptDefinition;
}
