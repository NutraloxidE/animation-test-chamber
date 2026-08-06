import type {
  CameraSceneEntity,
  GameObjectInstanceDefinition,
  LegacyProjectDefinitionWithWorld,
  ProjectDefinition,
  SceneDefinition,
  TransformDefinition,
  WorldDefinition,
} from '@atc/schema';
import { migrateWorldDefinition } from '@atc/schema';
import { PrefabAssetRegistry } from '@atc/prefab-runtime';
import { loadStoredPrefabs } from '../../harness/prefabs.ts';
import { loadDemoProject } from './project.ts';
import { loadWorldFixture } from './world.ts';

/**
 * A legacy project carrying an explicit World.
 *
 * Built from the *real* acceptance world fixture rather than a hand-written
 * inline one, for the same reason `tests/fixtures/world.ts` reads it: a
 * hand-built copy would let the fixture, the manifest and the migration drift
 * apart while every test kept passing.
 */
export function legacyProjectWithWorld(
  world: WorldDefinition = loadWorldFixture(),
): LegacyProjectDefinitionWithWorld {
  const { scenes: _scenes, activeSceneId: _activeSceneId, ...rest } = loadDemoProject();
  return { ...rest, world };
}

/** A legacy project that never had a World — the character-only shape. */
export function legacyProjectWithoutWorld(): LegacyProjectDefinitionWithWorld {
  const { scenes: _scenes, activeSceneId: _activeSceneId, ...rest } = loadDemoProject();
  return rest;
}

/** The committed demo project, already in Scene form. */
export function currentProjectWithScenes(): ProjectDefinition {
  return loadDemoProject();
}

/** The acceptance world as a Scene, without going through a whole project. */
export function acceptanceScene(): SceneDefinition {
  return migrateWorldDefinition(loadWorldFixture());
}

export const CONTROLLED_ENTITY = 'controlled-humanoid';
export const SCRIPTED_ENTITY = 'scripted-humanoid';

/* -------------------------------------------------------------------------- */
/* The Scene cutover fixture                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A Prefab registry over the repository's published Prefabs.
 *
 * Read from disk rather than hand-built, for the same reason `acceptanceScene`
 * reads the real world fixture: a hand-built copy would let the fixture and the
 * published assets drift apart while every test kept passing.
 */
export function loadTestPrefabRegistry(): PrefabAssetRegistry {
  return new PrefabAssetRegistry(loadStoredPrefabs());
}

/**
 * A Scene whose two views **contradict each other** (§13.1).
 *
 * `gameObjects` holds the objects that ought to appear. `entities` holds three
 * completely different things with completely different ids. There is no reading
 * of this document under which both are right, and that is the point: while the
 * two views agree, a test cannot tell a Scene Editor running on GameObjects from
 * one still reading entities. Here a fallback produces the wrong answer loudly,
 * instead of the right answer by coincidence.
 *
 * Deliberately built rather than migrated. `migrateWorldDefinition` produces a
 * Scene whose views agree by construction, which is exactly what this fixture
 * must not be.
 */
export function contradictoryScene(
  registry: PrefabAssetRegistry = loadTestPrefabRegistry(),
): SceneDefinition {
  const identity: TransformDefinition = {
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    scale: { x: 1, y: 1, z: 1 },
  };

  const decoy: CameraSceneEntity = {
    schemaVersion: 2,
    id: 'ENTITY-ONLY-DECOY',
    displayName: 'Entity-only decoy',
    enabled: true,
    transform: identity,
    kind: 'camera',
    projection: 'perspective',
    fieldOfViewDeg: 60,
  };

  const instance = (
    id: string,
    prefabId: string,
    overrides: Partial<GameObjectInstanceDefinition> = {},
  ): GameObjectInstanceDefinition => ({
    schemaVersion: 2,
    id,
    displayName: id,
    enabled: true,
    prefab: registry.referenceTo(prefabId, '1.0.0'),
    transform: identity,
    componentOverrides: [],
    bindings: {},
    relations: {},
    ...overrides,
  });

  return {
    schemaVersion: 2,
    id: 'cutover-contradiction',
    displayName: 'Cutover contradiction',
    entities: [
      decoy,
      { ...decoy, id: 'ENTITY-ONLY-DECOY-2', displayName: 'Second decoy' },
      { ...decoy, id: 'ENTITY-ONLY-DECOY-3', displayName: 'Third decoy' },
    ],
    gameObjects: [
      instance('hero', 'quaternius-knight'),
      instance('watcher', 'default-scene-camera', {
        relations: { cameraTargetGameObjectId: 'hero' },
      }),
      instance('understudy', 'quaternius-knight'),
    ],
    intentTracks: [],
    activeCameraGameObjectId: 'watcher',
  };
}
