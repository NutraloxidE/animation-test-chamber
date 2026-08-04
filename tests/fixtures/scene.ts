import type {
  LegacyProjectDefinitionWithWorld,
  ProjectDefinition,
  SceneDefinition,
  WorldDefinition,
} from '@atc/schema';
import { migrateWorldDefinition } from '@atc/schema';
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
