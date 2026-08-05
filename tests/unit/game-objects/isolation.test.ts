/**
 * Runtime isolation (§18.6).
 *
 * The claim is that two instances of one Prefab share the immutable side and
 * nothing else. Object identity alone would be a weak test — two runtimes can
 * hold distinct wrappers and still share a `Simulation` through a captured
 * reference — so the load-bearing assertions here *move* one instance and check
 * the other did not follow.
 */
import { describe, expect, it } from 'vitest';
import { TERRAIN_PRESETS } from '@atc/terrain-runtime';
import {
  RuntimeScene,
  instantiateGameObject,
  instantiateScene,
  resolveGameObjectInstance,
  type GameObjectRuntimeServices,
} from '@atc/game-object-runtime';
import {
  animatorComponent,
  basePrefab,
  modelComponent,
  node,
  referenceTo,
  registryOf,
} from '../prefabs/fixtures.ts';
import { loadAssetRegistry, loadCanonicalProject } from '../../../harness/animation-assets.ts';
import { loadPrefabRegistry } from '../../../harness/prefabs.ts';

const project = loadCanonicalProject();
const terrain =
  TERRAIN_PRESETS.find((preset) => preset.id === project.defaultTerrainPresetId) ??
  TERRAIN_PRESETS[0]!;

function services(): GameObjectRuntimeServices {
  return {
    animationRegistry: loadAssetRegistry(),
    prefabRegistry: loadPrefabRegistry(),
    clock: { fixedDeltaSeconds: 1 / 60 },
  };
}

function runtimeScene(): RuntimeScene {
  return instantiateScene({
    scene: project.scenes[0]!,
    project,
    terrain,
    services: services(),
  });
}

describe('two instances of one Prefab', () => {
  it('are two objects standing on the same Prefab version', () => {
    const scene = runtimeScene();
    const first = scene.get('controlled-humanoid')!;
    const second = scene.get('scripted-humanoid')!;
    expect(first.definition.prefabReference).toEqual(second.definition.prefabReference);
    expect(first).not.toBe(second);
    scene.dispose();
  });

  it('hold independent simulations', () => {
    const scene = runtimeScene();
    const first = scene.get('controlled-humanoid')!;
    const second = scene.get('scripted-humanoid')!;
    expect(first.character).toBeDefined();
    expect(second.character).toBeDefined();
    expect(first.character).not.toBe(second.character);
    expect(first.character!.resolvedProject).not.toBe(second.character!.resolvedProject);
    scene.dispose();
  });

  it('do not move each other', () => {
    const scene = runtimeScene();
    const first = scene.get('controlled-humanoid')!;
    const second = scene.get('scripted-humanoid')!;
    const before = JSON.stringify(second.transformState);

    for (let tick = 0; tick < 60; tick += 1) {
      first.step({ tick, cameraYawRad: 0 });
    }

    expect(JSON.stringify(second.transformState)).toBe(before);
    scene.dispose();
  });

  it('hold independent component runtimes and attachment state', () => {
    const scene = runtimeScene();
    const first = scene.get('controlled-humanoid')!;
    const second = scene.get('scripted-humanoid')!;
    for (const component of first.components) {
      const twin = second.componentRuntime(component.componentId);
      expect(twin, `no twin for "${component.componentId}"`).toBeDefined();
      expect(twin).not.toBe(component);
    }
    scene.dispose();
  });

  it('hold independent controller state', () => {
    const scene = runtimeScene();
    expect(scene.get('controlled-humanoid')!.intentSource).not.toBe(
      scene.get('scripted-humanoid')!.intentSource,
    );
    scene.dispose();
  });
});

describe('two Prefabs sharing Animator assets', () => {
  it('resolve to the same animation references and still tick independently', () => {
    const scene = runtimeScene();
    const first = scene.get('controlled-humanoid')!;

    // `sentinel` shares the Navigator Motion Set and the shared Behavior, so
    // this is the cross-Prefab version of the same question.
    const prefabRegistry = loadPrefabRegistry();
    const sentinel = prefabRegistry.referenceTo(
      'sentinel',
      prefabRegistry.latestVersion('sentinel')!,
    );
    const spawned = scene.instantiate({
      id: 'spawned-sentinel',
      prefab: sentinel,
      transform: {
        position: { x: 4, y: 2, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        scale: { x: 1, y: 1, z: 1 },
      },
      bindings: { characterIntent: { kind: 'none' } },
    });

    expect(spawned.character).toBeDefined();
    // The shared half: same Motion Set, so the same clips bound to the same
    // slots. The graphs are deliberately *not* compared — Navigator carries
    // per-character instance overrides on two state speeds, which is the whole
    // point of instance overrides and would make an equality assertion here a
    // test of the wrong thing.
    expect(spawned.character!.resolvedProject.motionBindings).toEqual(
      first.character!.resolvedProject.motionBindings,
    );
    expect(spawned.character!.resolvedProject.clips).toEqual(first.character!.resolvedProject.clips);
    expect(spawned.character).not.toBe(first.character);

    const before = JSON.stringify(first.transformState);
    for (let tick = 0; tick < 30; tick += 1) spawned.step({ tick, cameraYawRad: 0 });
    expect(JSON.stringify(first.transformState)).toBe(before);

    scene.dispose();
  });
});

describe('runtime spawn and despawn', () => {
  it('does not touch the canonical Scene', () => {
    const canonical = JSON.stringify(project.scenes[0]);
    const scene = runtimeScene();
    const prefabRegistry = loadPrefabRegistry();
    scene.instantiate({
      id: 'transient',
      prefab: prefabRegistry.referenceTo('relay', prefabRegistry.latestVersion('relay')!),
      transform: {
        position: { x: 9, y: 2, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        scale: { x: 1, y: 1, z: 1 },
      },
    });
    expect(scene.get('transient')).toBeDefined();
    expect(scene.despawn('transient')).toBe(true);
    expect(scene.get('transient')).toBeUndefined();
    expect(JSON.stringify(project.scenes[0])).toBe(canonical);
    scene.dispose();
  });

  it('refuses to spawn onto an id that is already taken', () => {
    const scene = runtimeScene();
    const prefabRegistry = loadPrefabRegistry();
    expect(() =>
      scene.instantiate({
        id: 'controlled-humanoid',
        prefab: prefabRegistry.referenceTo('relay', prefabRegistry.latestVersion('relay')!),
        transform: {
          position: { x: 0, y: 0, z: 0 },
          rotation: { x: 0, y: 0, z: 0, w: 1 },
          scale: { x: 1, y: 1, z: 1 },
        },
      }),
    ).toThrow(/already in scene/);
    scene.dispose();
  });

  it('refuses to spawn an abstract Prefab', () => {
    const scene = runtimeScene();
    const prefabRegistry = loadPrefabRegistry();
    expect(() =>
      scene.instantiate({
        id: 'abstract-spawn',
        prefab: prefabRegistry.referenceTo(
          'humanoid-character-base',
          prefabRegistry.latestVersion('humanoid-character-base')!,
        ),
        transform: {
          position: { x: 0, y: 0, z: 0 },
          rotation: { x: 0, y: 0, z: 0, w: 1 },
          scale: { x: 1, y: 1, z: 1 },
        },
      }),
    ).toThrow(/abstract-prefab-placed/);
    scene.dispose();
  });
});

describe('a Prefab with a hierarchy', () => {
  /**
   * A root that is only a mount point, and a child that is the character.
   *
   * The runtime builds one `RuntimeGameObject` per node, so the character
   * decision has to be node-local: reading the whole subtree would build a
   * simulation on the child *and* another on the root that can see it, and the
   * two would then fight over the same authored motor.
   */
  const mount = basePrefab(
    'rider-mount',
    node('root', [modelComponent('relay')], [
      {
        kind: 'inline',
        node: node('rider', [
          modelComponent('navigator'),
          animatorComponent(),
          {
            schemaVersion: 1,
            componentId: 'character-motor',
            componentType: 'character-motor',
            enabled: true,
            intentChannel: 'primary',
            movementScale: 1,
            turnScale: 1,
          },
        ]),
      },
    ]),
  );

  it('builds exactly one character, on the node that declares the motor', () => {
    const runtime = instantiateGameObject({
      definition: resolveGameObjectInstance({
        prefabRegistry: registryOf(mount),
        instance: {
          schemaVersion: 2,
          id: 'mounted',
          displayName: 'mounted',
          enabled: true,
          prefab: referenceTo(mount),
          transform: {
            position: { x: 0, y: 0, z: 0 },
            rotation: { x: 0, y: 0, z: 0, w: 1 },
            scale: { x: 1, y: 1, z: 1 },
          },
          componentOverrides: [],
          bindings: {},
          relations: {},
        },
      }).definition,
      services: services(),
      project,
      terrain,
    });

    expect(runtime.character).toBeUndefined();
    expect(runtime.children).toHaveLength(1);
    expect(runtime.children[0]!.character).toBeDefined();
    runtime.dispose();
  });
});
