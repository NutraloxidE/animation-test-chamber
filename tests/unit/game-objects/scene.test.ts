/**
 * Scene composition without entity kinds (§18.5).
 *
 * Every assertion here answers a question that used to be answered by reading
 * `entity.kind`. None of them read a kind, and the animated-prop case is the
 * proof that mattered: an object with a model and an animator and no
 * `CharacterMotor` is a legitimate, runnable thing, and under the old union
 * there was no branch it could be.
 */
import { describe, expect, it } from 'vitest';
import { componentOfType, isCharacterComposition, type SceneDefinition } from '@atc/schema';
import { resolvedComponents } from '@atc/prefab-runtime';
import { isCharacterGameObject, resolveSceneGameObjects } from '@atc/game-object-runtime';
import { loadCanonicalProject } from '../../../harness/animation-assets.ts';
import { loadPrefabRegistry } from '../../../harness/prefabs.ts';
import { registryOf } from '../prefabs/fixtures.ts';
import { animatorComponent, basePrefab, modelComponent, node } from '../prefabs/fixtures.ts';
import { referenceTo } from '../prefabs/fixtures.ts';

const project = loadCanonicalProject();
const prefabRegistry = loadPrefabRegistry();
const scene = project.scenes[0]!;

describe('the migrated Scene', () => {
  const resolved = resolveSceneGameObjects({ prefabRegistry, scene });

  it('resolves every GameObject without error', () => {
    expect(resolved.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
    expect(resolved.definitions).toHaveLength(scene.gameObjects?.length ?? 0);
  });

  it('names an exact Prefab version for every object', () => {
    for (const definition of resolved.definitions) {
      expect(definition.prefabReference.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(definition.prefabReference.contentHash).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it('detects a character by its Components', () => {
    const controlled = resolved.definitions.find(
      (definition) => definition.gameObjectId === 'controlled-humanoid',
    );
    expect(controlled).toBeDefined();
    expect(isCharacterGameObject(controlled!)).toBe(true);
    const components = resolvedComponents(controlled!.root);
    expect(componentOfType(components, 'animator')).toBeDefined();
    expect(componentOfType(components, 'character-motor')).toBeDefined();
  });

  it('detects a camera by its Camera Component', () => {
    const camera = resolved.definitions.find(
      (definition) => definition.gameObjectId === 'scene-camera',
    );
    expect(componentOfType(resolvedComponents(camera!.root), 'camera')).toBeDefined();
    expect(isCharacterGameObject(camera!)).toBe(false);
  });

  it('points the active camera at a GameObject id that exists', () => {
    expect(scene.activeCameraGameObjectId).toBe('scene-camera');
    expect(
      resolved.definitions.some(
        (definition) => definition.gameObjectId === scene.activeCameraGameObjectId,
      ),
    ).toBe(true);
  });

  it('expresses the camera relation as an id, not an index', () => {
    const camera = resolved.definitions.find(
      (definition) => definition.gameObjectId === 'scene-camera',
    );
    const target = camera!.relations.cameraTargetGameObjectId;
    expect(target).toBe('controlled-humanoid');
    expect(
      resolved.definitions.some((definition) => definition.gameObjectId === target),
    ).toBe(true);
  });

  it('keeps declaration order', () => {
    expect(resolved.definitions.map((definition) => definition.gameObjectId)).toEqual(
      (scene.gameObjects ?? []).map((gameObject) => gameObject.id),
    );
  });
});

describe('compositions the entity union could not express', () => {
  /** A model plus an animator and no motor: an animated prop. */
  const animatedProp = basePrefab(
    'animated-banner',
    node('root', [modelComponent('relay'), animatorComponent()]),
  );
  /** A character that also casts light: one object, four components. */
  const lampBearer = basePrefab(
    'lamp-bearer',
    node('root', [
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
      {
        schemaVersion: 1,
        componentId: 'lantern',
        componentType: 'light',
        enabled: true,
        lightType: 'point',
        intensity: 3,
        color: '#ffddaa',
        range: 8,
      },
    ]),
  );

  const registry = registryOf(animatedProp, lampBearer);

  function sceneWith(id: string, prefabId: 'animated-banner' | 'lamp-bearer'): SceneDefinition {
    return {
      schemaVersion: 2,
      id: 'test-scene',
      displayName: 'test',
      entities: [],
      intentTracks: [],
      gameObjects: [
        {
          schemaVersion: 2,
          id,
          displayName: id,
          enabled: true,
          prefab: referenceTo(prefabId === 'animated-banner' ? animatedProp : lampBearer),
          transform: {
            position: { x: 0, y: 0, z: 0 },
            rotation: { x: 0, y: 0, z: 0, w: 1 },
            scale: { x: 1, y: 1, z: 1 },
          },
          componentOverrides: [],
          bindings: {},
          relations: {},
        },
      ],
    };
  }

  it('runs an animated prop with no Character kind anywhere', () => {
    const resolved = resolveSceneGameObjects({
      prefabRegistry: registry,
      scene: sceneWith('banner', 'animated-banner'),
    });
    expect(resolved.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
    const components = resolvedComponents(resolved.definitions[0]!.root);
    expect(componentOfType(components, 'animator')).toBeDefined();
    expect(isCharacterComposition(components)).toBe(false);
  });

  it('lets one object be a character and a light at once', () => {
    const resolved = resolveSceneGameObjects({
      prefabRegistry: registry,
      scene: sceneWith('bearer', 'lamp-bearer'),
    });
    const components = resolvedComponents(resolved.definitions[0]!.root);
    expect(isCharacterComposition(components)).toBe(true);
    expect(componentOfType(components, 'light')?.color).toBe('#ffddaa');
  });
});

describe('instance rules', () => {
  const abstractPrefab = basePrefab('abstract-thing', node('root', [modelComponent('relay')]), {
    abstract: true,
  });
  const registry = registryOf(abstractPrefab);

  it('refuses to place an abstract Prefab', () => {
    const resolved = resolveSceneGameObjects({
      prefabRegistry: registry,
      scene: {
        schemaVersion: 2,
        id: 'test-scene',
        displayName: 'test',
        entities: [],
        intentTracks: [],
        gameObjects: [
          {
            schemaVersion: 2,
            id: 'placed',
            displayName: 'placed',
            enabled: true,
            prefab: referenceTo(abstractPrefab),
            transform: {
              position: { x: 0, y: 0, z: 0 },
              rotation: { x: 0, y: 0, z: 0, w: 1 },
              scale: { x: 1, y: 1, z: 1 },
            },
            componentOverrides: [],
            bindings: {},
            relations: {},
          },
        ],
      },
    });
    expect(resolved.issues.map((issue) => issue.code)).toContain('abstract-prefab-placed');
    expect(resolved.definitions).toEqual([]);
  });

  it('refuses a character binding on a Prefab with no motor', () => {
    const resolved = resolveSceneGameObjects({
      prefabRegistry: registryOf(basePrefab('inert', node('root', [modelComponent('relay')]))),
      scene: {
        schemaVersion: 2,
        id: 'test-scene',
        displayName: 'test',
        entities: [],
        intentTracks: [],
        gameObjects: [
          {
            schemaVersion: 2,
            id: 'driven',
            displayName: 'driven',
            enabled: true,
            prefab: referenceTo(basePrefab('inert', node('root', [modelComponent('relay')]))),
            transform: {
              position: { x: 0, y: 0, z: 0 },
              rotation: { x: 0, y: 0, z: 0, w: 1 },
              scale: { x: 1, y: 1, z: 1 },
            },
            componentOverrides: [],
            bindings: { characterIntent: { kind: 'human', playerIndex: 0 } },
            relations: {},
          },
        ],
      },
    });
    expect(resolved.issues.map((issue) => issue.code)).toContain('invalid-instance-binding');
  });
});
