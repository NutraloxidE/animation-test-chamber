import type { JsonObject, GameplayScriptReference, GameObjectPrefabReference, TransformDefinition, Vec3 } from '@atc/schema';
import type { PropertiesOf, PropertyMap } from './property.ts';

export interface GameplayEvent { type: string; payload: JsonObject; sourceGameObjectId?: string }
export interface GameplayWorld {
  get(gameObjectId: string): GameplayObjectView | undefined;
  findByTag(tag: string): GameplayObjectView[];
  emit(targetGameObjectId: string, event: GameplayEvent): void;
  spawn(request: { id: string; prefab: GameObjectPrefabReference; transform: TransformDefinition }): void;
  despawn(gameObjectId: string): void;
}
export type GameplayCommandResult = { ok: true } | { ok: false; code: 'not-a-character' | 'simulation-owned-transform' | 'invalid-command' | 'invalid-parameter-name' | 'operation-budget-exceeded' | 'target-not-found'; message: string };
export type CharacterMotionCommand =
  | { type: 'impulse'; deltaVelocity: Vec3; space: 'world' | 'facing' | 'camera' }
  | { type: 'motion-override'; key: string; velocity: Vec3; space: 'world' | 'facing' | 'camera'; durationTicks: number; priority?: number; horizontal: 'replace' | 'add'; vertical: 'preserve' | 'replace' | 'add'; facing?: 'preserve' | 'velocity' | { yawRad: number } }
  | { type: 'movement-scale'; key: string; speedScale: number; accelerationScale?: number; turnScale?: number; durationTicks: number; priority?: number }
  | { type: 'teleport'; position: Vec3; yawRad?: number; velocity: 'preserve' | 'clear' };
export interface GameplayCharacterSnapshot { tick: number; worldTransform: TransformDefinition; velocity: Vec3; grounded: boolean; locomotionStateId: string; actionStateId: string; intentSourceKind: string; gameplayParameters: Readonly<Record<string, boolean | number | string>>; activeMotionOverrides: readonly { key: string; sourceComponentId: string; remainingTicks: number; priority: number }[]; activeMovementScales: readonly { key: string; sourceComponentId: string; remainingTicks: number; priority: number }[] }
export interface GameplayCharacterApi { snapshot(): GameplayCharacterSnapshot; command(command: CharacterMotionCommand): GameplayCommandResult; setGameplayParameter(name: string, value: boolean | number | string, durationTicks?: number): GameplayCommandResult; clearGameplayParameter(name: string): GameplayCommandResult }
export interface GameplayTransformApi { world(): TransformDefinition; local(): TransformDefinition; setLocal(transform: TransformDefinition): GameplayCommandResult; translateLocal(delta: Vec3): GameplayCommandResult }
export interface GameplayObjectApi { readonly id: string; readonly tags: readonly string[]; worldTransform(): TransformDefinition; readonly transform: GameplayTransformApi; readonly character?: GameplayCharacterApi }
export interface GameplayObjectView extends GameplayObjectApi {}
export interface GameplayContext { tick: number; deltaSeconds: number; random(): number; self: GameplayObjectApi; world: GameplayWorld }
export interface GameplaySelf<Props extends JsonObject = JsonObject, State extends JsonObject = JsonObject> {
  readonly gameObjectId: string;
  readonly props: Props;
  readonly state: State;
}

export interface GameplayScriptDefinition<P extends PropertyMap = PropertyMap, S extends JsonObject = JsonObject> {
  id: string;
  version: string;
  displayName: string;
  properties: P;
  state: (input: { props: PropertiesOf<P> }) => S;
  events?: Record<string, PropertyMap>;
  start?(ctx: GameplayContext, self: GameplaySelf<PropertiesOf<P> & JsonObject, S>): void;
  fixedUpdate?(ctx: GameplayContext, self: GameplaySelf<PropertiesOf<P> & JsonObject, S>): void;
  onEvent?(ctx: GameplayContext, self: GameplaySelf<PropertiesOf<P> & JsonObject, S>, event: GameplayEvent): void;
  dispose?(self: GameplaySelf<PropertiesOf<P> & JsonObject, S>): void;
}

export function defineGameplayScript<P extends PropertyMap, S extends JsonObject>(definition: GameplayScriptDefinition<P, S>): GameplayScriptDefinition { return definition as unknown as GameplayScriptDefinition; }

export interface RegisteredGameplayScript {
  reference: GameplayScriptReference;
  definition: GameplayScriptDefinition;
}
