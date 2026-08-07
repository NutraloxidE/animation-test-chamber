import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ProjectDefinition, WorldDefinition } from '@atc/schema';
import { WorldRuntime } from '@atc/world-runtime';
import { demoRegistry, loadDemoProject } from './project.ts';

const REPO_ROOT = resolve(__dirname, '../..');
const FIXTURE_PATH = resolve(REPO_ROOT, 'tests/fixtures/world/two-humanoids-shared-animation.json');

/**
 * The acceptance world, read from the same file the capability manifest names.
 *
 * Reading the real fixture rather than building one inline is the point: the
 * manifest declares this path, the harness checks it exists, and the tests
 * assert against its contents. A hand-built copy here would let all three drift
 * apart while every one of them kept passing.
 */
export function loadWorldFixture(): WorldDefinition {
  return JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as WorldDefinition;
}

/** The demo project with the acceptance world attached. */
export function projectWithWorldFixture(): ProjectDefinition {
  return { ...loadDemoProject(), world: loadWorldFixture() };
}

export function createWorldRuntime(world?: WorldDefinition): WorldRuntime {
  return new WorldRuntime({
    registry: demoRegistry(),
    project: loadDemoProject(),
    world: world ?? loadWorldFixture(),
  });
}

/**
 * The demo project as it was before it composed anything.
 *
 * The demo project ships the acceptance composition — as a Scene since the
 * migration, as a World before it — so a human opening the chamber sees two
 * instances. Legacy compatibility is therefore not the default path, which is
 * exactly why it needs a fixture of its own rather than being assumed. Both
 * `world` and `scenes` are stripped: leaving `scenes` would reach `worldOf`
 * through the Scene adapter and produce the composed world this fixture exists
 * to be the absence of.
 */
export function legacyDemoProject(): ProjectDefinition {
  const { world: _world, ...rest } = loadDemoProject();
  return { ...rest, scenes: [] } as ProjectDefinition;
}

export const CONTROLLED = 'controlled-humanoid';
export const SCRIPTED = 'scripted-humanoid';
