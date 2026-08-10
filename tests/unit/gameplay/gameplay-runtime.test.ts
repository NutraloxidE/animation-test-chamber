import { describe, expect, it } from 'vitest';
import type { ScriptComponent } from '@atc/schema';
import { GameplayScriptRegistry, defineGameplayScript, numberProp } from '@atc/gameplay-sdk';
import { GameplayScriptRuntime, type GameObjectRuntimeServices } from '@atc/game-object-runtime';

const hash = 'a'.repeat(64);
const definition = defineGameplayScript({
  id: 'counter', version: '1.0.0', displayName: 'Counter',
  properties: { rate: numberProp({ min: 0 }) },
  state: () => ({ value: 0 }),
  events: { add: { amount: numberProp({ min: 0 }) } },
  fixedUpdate(ctx, self) { self.state.value += self.props.rate * ctx.deltaSeconds; },
  onEvent(_ctx, self, event) { self.state.value += event.payload.amount as number; },
});
const registry = new GameplayScriptRegistry([{ reference: { assetType: 'gameplay-script', assetId: 'counter', version: '1.0.0', contentHash: hash }, definition }]);
const component: ScriptComponent = { schemaVersion: 2, componentId: 'counter-script', componentType: 'script', enabled: true, script: { assetType: 'gameplay-script', assetId: 'counter', version: '1.0.0', contentHash: hash }, properties: { rate: 2 } };

function runtime(): GameplayScriptRuntime {
  return new GameplayScriptRuntime(component, { gameObjectId: 'hero', displayName: 'Hero', nodeId: 'root', nodePath: 'root', project: {} as never, services: { clock: { fixedDeltaSeconds: 0.5 }, gameplayRegistry: registry } as GameObjectRuntimeServices });
}

describe('GameplayScriptRuntime', () => {
  it('owns state per instance and advances from fixed delta', () => {
    const a = runtime(); const b = runtime();
    a.step({ tick: 0, deltaSeconds: 0.5, cameraYawRad: 0 });
    expect(a.snapshot()).toEqual({ value: 1 });
    expect(b.snapshot()).toEqual({ value: 0 });
  });
  it('validates and delivers declared events', () => {
    const value = runtime();
    value.event({ tick: 0, deltaSeconds: 0.5, cameraYawRad: 0 }, { type: 'add', payload: { amount: 4 } });
    expect(value.snapshot()).toEqual({ value: 4 });
  });
  it('disables a stale exact reference', () => {
    const value = new GameplayScriptRuntime({ ...component, script: { ...component.script, contentHash: 'b'.repeat(64) } }, { gameObjectId: 'hero', displayName: 'Hero', nodeId: 'root', nodePath: 'root', project: {} as never, services: { clock: { fixedDeltaSeconds: 0.5 }, gameplayRegistry: registry } as GameObjectRuntimeServices });
    expect(value.enabled).toBe(false);
    expect(value.issues[0]?.code).toBe('gameplay-script-hash-mismatch');
  });
  it('scopes cross-object APIs to the calling script identity', () => {
    const origins: string[] = [];
    const value = new GameplayScriptRuntime(component, { gameObjectId: 'hero', displayName: 'Hero', nodeId: 'root', nodePath: 'root', project: {} as never, services: { animationRegistry: {} as never, prefabRegistry: {} as never, clock: { fixedDeltaSeconds: 0.5 }, gameplayRegistry: registry, gameplayWorld: { get: () => undefined, findByTag: () => [], emit: () => {}, spawn: () => {}, despawn: () => {} }, gameplayObject: (id, origin) => { origins.push(`${id}:${origin}`); return { id, tags: [], worldTransform: () => ({ position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 } }), transform: {} as never }; } } });
    value.step({ tick: 0, deltaSeconds: 0.5, cameraYawRad: 0 });
    expect(origins).toContain('hero:standalone/hero/hero/counter-script/counter@1.0.0');
  });
});
