import type { JsonObject, GameplayScriptReference, GameObjectPrefabReference, TransformDefinition } from '@atc/schema';
import type { PropertiesOf, PropertyMap } from './property.ts';

export interface GameplayEvent { type: string; payload: JsonObject; sourceGameObjectId?: string }
export interface GameplayWorld {
  get(gameObjectId: string): GameplayObjectView | undefined;
  findByTag(tag: string): GameplayObjectView[];
  emit(targetGameObjectId: string, event: GameplayEvent): void;
  spawn(request: { id: string; prefab: GameObjectPrefabReference; transform: TransformDefinition }): void;
  despawn(gameObjectId: string): void;
}
export interface GameplayObjectView { id: string; tags: readonly string[]; transform: TransformDefinition }
export interface GameplayContext { tick: number; deltaSeconds: number; random(): number; world: GameplayWorld }
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
