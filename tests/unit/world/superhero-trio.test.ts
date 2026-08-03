/**
 * The shipped Superhero trio scene, checked as data.
 *
 * A world file is canonical content nobody compiles, so the things that can
 * quietly break it — a character id that no longer exists, a track whose legs
 * stop cancelling and walk the skirmisher off the map — are exactly the things
 * only a simulation notices.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { WorldDefinition } from '@atc/schema';
import { validateAgainst } from '@atc/schema';
import { resolveWorld, simulateWorld } from '@atc/world-runtime';
import { demoRegistry, loadDemoProject } from '../../fixtures/project.ts';

const WORLD_PATH = resolve(__dirname, '../../../projects/demo-character/worlds/superhero-trio.json');
const world = JSON.parse(readFileSync(WORLD_PATH, 'utf8')) as WorldDefinition;

/**
 * The leash is open-loop: the track's outbound and return legs cancel, they are
 * not corrected against a measured position. This bound is the drift that
 * cancellation leaves behind over ten cycles (~80s), and it is a real ceiling —
 * a scene that ran for an hour would need a position-aware intent source.
 */
const LEASH_RADIUS_M = 4;

describe('superhero-trio world', () => {
  const project = loadDemoProject();
  const registry = demoRegistry();

  it('validates and resolves every instance without asset issues', () => {
    expect(validateAgainst('WorldDefinition', world).valid).toBe(true);
    const resolution = resolveWorld({ registry, project, world });
    expect(resolution.instances).toHaveLength(3);
    expect(resolution.instances.flatMap((instance) => instance.issues)).toEqual([]);
  });

  it('gives the three heroes three different intent sources', () => {
    expect(world.instances.map((instance) => instance.intentSource.kind)).toEqual([
      'local-input',
      'none',
      'scripted-track',
    ]);
  });

  it('keeps the skirmisher near its start point across ten cycles', () => {
    const start = world.instances.find((instance) => instance.id === 'hero-skirmisher')!.transform
      .position;
    const track = world.intentTracks[0]!;
    const after = simulateWorld({
      registry,
      project,
      world,
      ticks: track.durationTicks * 10,
    });
    const skirmisher = after.observation.instances.find(
      (instance) => instance.instanceId === 'hero-skirmisher',
    )!;
    const dx = skirmisher.transform.position.x - start.x;
    const dz = skirmisher.transform.position.z - start.z;
    expect(Math.hypot(dx, dz)).toBeLessThan(LEASH_RADIUS_M);
  });

  it('simulates deterministically', () => {
    const args = { registry, project, world, ticks: 240 } as const;
    expect(simulateWorld(args).worldHash).toBe(simulateWorld(args).worldHash);
  });
});
