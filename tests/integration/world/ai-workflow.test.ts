/**
 * The machine workflow, end to end, without a single file edit.
 *
 * This is the test that decides whether the command surface is real: discover
 * capabilities, inspect an instance, duplicate it, move the copy, bind it to a
 * track, preview fixed ticks, read instance-qualified observations, and end
 * holding a staged canonical world that the existing save path can publish.
 *
 * No model is involved. An AI-operable path that needed a model to be
 * exercised would be a path nobody could regression-test.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ProjectDefinition, WorldDefinition } from '@atc/schema';
import { validateProject, validateProjectReferences } from '@atc/schema';
import { WorldRuntime } from '@atc/world-runtime';
import { createDefaultRegistry, type CommandContext } from '@atc/capability-runtime';
import { demoRegistry, loadDemoProject } from '../../fixtures/project.ts';
import { CONTROLLED, SCRIPTED, loadWorldFixture } from '../../fixtures/world.ts';

function contextFor(project: ProjectDefinition, world: WorldDefinition): CommandContext {
  return {
    project,
    world,
    registry: demoRegistry(),
    runtime: new WorldRuntime({ registry: demoRegistry(), project, world }),
    actor: 'ai',
  };
}

describe('AI command workflow', () => {
  it('completes the full workflow through typed commands alone', () => {
    const registry = createDefaultRegistry();
    const project = loadDemoProject();
    let world = loadWorldFixture();

    // 1-2: discovery.
    const capabilities = registry.list();
    const worldCapability = capabilities.find((entry) => entry.id === 'world.multi-instance')!;
    expect(worldCapability.commands.length).toBeGreaterThan(0);
    expect(worldCapability.authoringSurfaces.length).toBeGreaterThan(0);

    // 3: list instances.
    const listed = registry.execute('world.list_instances', {}, contextFor(project, world));
    expect(listed.ok).toBe(true);
    expect(
      (listed.output as { instances: { id: string }[] }).instances.map((entry) => entry.id),
    ).toEqual([CONTROLLED, SCRIPTED]);

    // 4: inspect one, including the assets it shares rather than owns.
    const inspected = registry.execute(
      'world.inspect_instance',
      { instanceId: CONTROLLED },
      contextFor(project, world),
    );
    expect(inspected.ok).toBe(true);
    const shared = (inspected.output as { sharedAssets: { behavior: { assetId: string } } })
      .sharedAssets;
    expect(shared.behavior.assetId).toBeTruthy();

    // 5: duplicate.
    const duplicated = registry.execute(
      'world.duplicate_instance',
      { instanceId: CONTROLLED, newInstanceId: 'comparison-humanoid' },
      contextFor(project, world),
    );
    expect(duplicated.issues).toEqual([]);
    expect(duplicated.stagedWorld).toBeDefined();
    world = duplicated.stagedWorld!;
    expect(world.instances).toHaveLength(3);
    // The copy references the same character; it did not clone an asset.
    expect(world.instances[2]!.source.characterId).toBe(
      world.instances[0]!.source.characterId,
    );

    // 6: move the copy.
    const moved = registry.execute(
      'world.set_instance_transform',
      { instanceId: 'comparison-humanoid', position: { x: 4, y: 2, z: 0 }, yawRad: 0 },
      contextFor(project, world),
    );
    expect(moved.ok).toBe(true);
    const beforeMove = world;
    world = moved.stagedWorld!;
    expect(world.instances[2]!.transform.position.x).toBe(4);
    // Instance-scoped: the other two are untouched.
    expect(world.instances[0]!.transform).toEqual(beforeMove.instances[0]!.transform);
    expect(world.instances[1]!.transform).toEqual(beforeMove.instances[1]!.transform);

    // 7: bind the scripted track.
    const bound = registry.execute(
      'world.bind_intent_source',
      {
        instanceId: 'comparison-humanoid',
        intentSource: { kind: 'scripted-track', trackId: 'scripted-locomotion-cycle' },
      },
      contextFor(project, world),
    );
    expect(bound.ok).toBe(true);
    world = bound.stagedWorld!;

    // 8-9: simulate fixed ticks and read the instance-qualified observations
    // that same call returned. One command, one response — no second request
    // reading a runtime that no longer exists.
    const context = contextFor(project, world);
    const simulated = registry.execute(
      'world.simulate',
      { ticks: 120, includeFlatObservations: true },
      context,
    );
    expect(simulated.ok).toBe(true);
    const simulateOutput = simulated.output as {
      tick: number;
      worldHash: string;
      instanceOrder: string[];
      flatObservations: { path: string; value: unknown }[];
    };
    expect(simulateOutput.tick).toBe(120);
    expect(simulateOutput.instanceOrder).toEqual([CONTROLLED, SCRIPTED, 'comparison-humanoid']);

    const paths = simulateOutput.flatObservations
      .filter((entry) => entry.path.startsWith('/world/instances/comparison-humanoid/'))
      .map((entry) => entry.path);
    expect(paths).toContain('/world/instances/comparison-humanoid/transform/position/x');

    // 10: compare, from the same response. The duplicate follows the same track
    // as the scripted one and ends somewhere the idle controlled instance does
    // not.
    const all = simulateOutput.flatObservations;
    const positionOf = (id: string) =>
      all.find((entry) => entry.path === `/world/instances/${id}/transform/position/z`)!.value;
    expect(positionOf('comparison-humanoid')).not.toBe(positionOf(CONTROLLED));

    // 11-12: the staged canonical change is a valid project ready for the
    // existing save path. Nothing above wrote a file.
    const stagedProject: ProjectDefinition = { ...project, world };
    expect(validateProject(stagedProject).issues).toEqual([]);
    expect(validateProjectReferences(stagedProject).issues).toEqual([]);
  });

  it('returns structured refusals rather than throwing', () => {
    const registry = createDefaultRegistry();
    const context = contextFor(loadDemoProject(), loadWorldFixture());

    const unknownInstance = registry.execute(
      'world.inspect_instance',
      { instanceId: 'not-here' },
      context,
    );
    expect(unknownInstance.ok).toBe(false);
    expect(unknownInstance.issues[0]!.message).toContain('unknown instance');

    const badPayload = registry.execute('world.set_instance_enabled', { instanceId: 5 }, context);
    expect(badPayload.ok).toBe(false);
    expect(badPayload.issues.map((issue) => issue.path)).toContain('/instanceId');

    const unknownCommand = registry.execute('world.do_whatever', {}, context);
    expect(unknownCommand.ok).toBe(false);
    expect(unknownCommand.issues[0]!.message).toContain('unknown command');

    const unknownTrack = registry.execute(
      'world.bind_intent_source',
      { instanceId: CONTROLLED, intentSource: { kind: 'scripted-track', trackId: 'nope' } },
      context,
    );
    expect(unknownTrack.ok).toBe(false);
    expect(unknownTrack.issues[0]!.message).toContain('unknown intent track');
  });

  it('rebinds one instance to another character without touching its siblings', () => {
    const registry = createDefaultRegistry();
    const project = loadDemoProject();
    const world = loadWorldFixture();
    const other = project.characters.find(
      (character) => character.id !== world.instances[0]!.source.characterId,
    )!;

    const result = registry.execute(
      'world.set_instance_character',
      { instanceId: CONTROLLED, characterId: other.id },
      contextFor(project, world),
    );
    expect(result.ok).toBe(true);
    const staged = result.stagedWorld!;
    expect(staged.instances.find((entry) => entry.id === CONTROLLED)!.source.characterId).toBe(
      other.id,
    );
    // The sibling is the assertion: a character is a shared definition, and
    // choosing a different one must stay instance-scoped.
    expect(staged.instances.find((entry) => entry.id === SCRIPTED)!.source.characterId).toBe(
      world.instances.find((entry) => entry.id === SCRIPTED)!.source.characterId,
    );

    const unknown = registry.execute(
      'world.set_instance_character',
      { instanceId: CONTROLLED, characterId: 'no-such-character' },
      contextFor(project, world),
    );
    expect(unknown.ok).toBe(false);
    expect(unknown.issues[0]!.message).toContain('unknown character');
  });

  it('refuses a staged world that would leave focus pointing at a disabled instance', () => {
    const registry = createDefaultRegistry();
    const context = contextFor(loadDemoProject(), loadWorldFixture());
    const result = registry.execute(
      'world.set_instance_enabled',
      { instanceId: CONTROLLED, enabled: false },
      context,
    );
    expect(result.ok).toBe(false);
    expect(result.issues[0]!.message).toContain('disabled instance');
    expect(result.stagedWorld).toBeUndefined();
  });

  it('cannot bypass a locked instance', () => {
    const project = loadDemoProject();
    const world = loadWorldFixture();
    world.instances[0]!.protection = { level: 'locked', reason: 'pinned for the acceptance run' };

    const registry = createDefaultRegistry();
    const result = registry.execute(
      'world.set_instance_transform',
      { instanceId: CONTROLLED, position: { x: 9, y: 2, z: 0 }, yawRad: 0 },
      contextFor(project, world),
    );
    expect(result.ok).toBe(false);
    expect(result.stagedWorld).toBeUndefined();
    expect(result.issues[0]!.keyword).toBe('protected');
  });

  it('never writes to the repository', () => {
    // Read the canonical file, run every mutating command, read it again. A
    // command that quietly published would be caught here rather than by an
    // assertion about what it was handed.
    const projectPath = resolve(__dirname, '../../../projects/demo-character/project.json');
    const before = readFileSync(projectPath, 'utf8');

    const registry = createDefaultRegistry();
    const context = contextFor(loadDemoProject(), loadWorldFixture());
    const payloads: Record<string, unknown> = {
      'world.create_instance': {
        instanceId: 'made-up',
        displayName: 'Made up',
        characterId: 'demo-humanoid',
      },
      'world.duplicate_instance': { instanceId: CONTROLLED, newInstanceId: 'copy-humanoid' },
      'world.remove_instance': { instanceId: SCRIPTED },
      'world.set_instance_enabled': { instanceId: SCRIPTED, enabled: false },
      'world.set_instance_transform': {
        instanceId: CONTROLLED,
        position: { x: 1, y: 2, z: 3 },
        yawRad: 0,
      },
      'world.bind_intent_source': { instanceId: CONTROLLED, intentSource: { kind: 'none' } },
      'intentTrack.set_loop': { trackId: 'scripted-locomotion-cycle', loop: false },
    };

    for (const command of registry.commands().filter((entry) => entry.mutating)) {
      const result = registry.execute(command.id, payloads[command.id], context);
      // Whether it succeeds or refuses, the outcome is a document or a list of
      // issues — never a side effect.
      if (result.ok) {
        expect(result.stagedWorld).toBeDefined();
        expect(result.changedPaths?.length ?? 0).toBeGreaterThan(0);
      } else {
        expect(result.issues.length).toBeGreaterThan(0);
        expect(result.stagedWorld).toBeUndefined();
      }
    }

    expect(readFileSync(projectPath, 'utf8')).toBe(before);
  });
});
