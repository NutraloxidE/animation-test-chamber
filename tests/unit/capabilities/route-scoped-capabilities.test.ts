/**
 * The three route-scoped capability groups, executed rather than described.
 *
 * A manifest that is only *checked for completeness* is still a document. What
 * makes it a contract is that the declared commands run, refuse what they
 * should refuse, and reach canonical data through the same typed operations the
 * UI does — so a change that breaks the human path breaks the machine path too,
 * instead of leaving one of them quietly wrong.
 */
import { describe, expect, it } from 'vitest';
import type { CommandContext } from '@atc/capability-runtime';
import { createDefaultRegistry } from '@atc/capability-runtime';
import { worldOf } from '@atc/world-runtime';
import { demoRegistry, loadDemoProject } from '../../fixtures/project.ts';
import { acceptanceScene, CONTROLLED_ENTITY, SCRIPTED_ENTITY } from '../../fixtures/scene.ts';

const registry = createDefaultRegistry();
const project = loadDemoProject();

function context(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    project,
    world: worldOf(project),
    scene: acceptanceScene(),
    registry: demoRegistry(),
    actor: 'ai',
    ...overrides,
  };
}

describe('the three groups are registered', () => {
  it.each(['rig.edit', 'scene.edit', 'character.control'])('declares %s', (id) => {
    expect(registry.list().map((entry) => entry.id)).toContain(id);
  });
});

describe('scene.edit', () => {
  it('places a character through the same operation the UI dispatches', () => {
    const result = registry.execute(
      'scene.place_asset',
      {
        entityId: 'placed-by-machine',
        displayName: 'Placed by machine',
        asset: { kind: 'character', characterId: 'demo-humanoid' },
      },
      context(),
    );

    expect(result.ok).toBe(true);
    expect(result.changedPaths).toEqual(['/entities/placed-by-machine']);
    const placed = result.stagedScene!.entities.find((e) => e.id === 'placed-by-machine')!;
    // The same default the human path gets: unbound, so a machine placement
    // cannot steal the human controller either.
    expect((placed as { controller: { kind: string } }).controller).toEqual({ kind: 'none' });
  });

  /*
   * A mutating command returns a document. If it could write, the apply path's
   * revision check and atomic write would be optional, and the first agent to
   * skip them would be indistinguishable from one that used them.
   */
  it('returns a staged scene rather than writing one', () => {
    const before = JSON.stringify(acceptanceScene());
    const result = registry.execute(
      'scene.set_enabled',
      { entityId: CONTROLLED_ENTITY, enabled: false },
      context(),
    );
    expect(result.ok).toBe(true);
    expect(result.stagedScene).toBeDefined();
    expect(JSON.stringify(acceptanceScene())).toBe(before);
  });

  it('refuses an unknown character with a structured issue', () => {
    const result = registry.execute(
      'scene.place_asset',
      {
        entityId: 'ghost',
        displayName: 'Ghost',
        asset: { kind: 'character', characterId: 'no-such-character' },
      },
      context(),
    );
    expect(result.ok).toBe(false);
    expect(result.issues[0]!.keyword).toBe('reference');
  });

  it('refuses input the schema rejects before the command body runs', () => {
    const result = registry.execute('scene.set_enabled', { entityId: 42 }, context());
    expect(result.ok).toBe(false);
  });

  it('refuses to run without a target scene rather than picking one', () => {
    const result = registry.execute(
      'scene.set_enabled',
      { entityId: CONTROLLED_ENTITY, enabled: false },
      context({ scene: undefined }),
    );
    expect(result.ok).toBe(false);
    expect(result.issues[0]!.path).toBe('/scene');
  });

  it('observes the scene back by entity id', () => {
    const result = registry.execute('scene.observe', { entityId: SCRIPTED_ENTITY }, context());
    expect(result.ok).toBe(true);
    const output = result.output as { entities: { entityId: string; controllerKind?: string }[] };
    expect(output.entities).toHaveLength(1);
    expect(output.entities[0]!.entityId).toBe(SCRIPTED_ENTITY);
    expect(output.entities[0]!.controllerKind).toBe('script');
  });
});

describe('character.control', () => {
  /*
   * Statelessness is the property that lets this run over HTTP at all: the
   * answer is a pure function of project + scene + intent + tick count, so two
   * identical requests in two fresh processes agree.
   */
  it('simulates statelessly and repeatably', () => {
    const input = { entityId: CONTROLLED_ENTITY, ticks: 30, intent: { moveY: 1 } };
    const first = registry.execute('character-control.simulate', input, context());
    const second = registry.execute('character-control.simulate', input, context());

    expect(first.ok).toBe(true);
    expect(JSON.stringify(second.output)).toBe(JSON.stringify(first.output));
  });

  it('moves the character it was told to move', () => {
    const still = registry.execute(
      'character-control.simulate',
      { entityId: CONTROLLED_ENTITY, ticks: 30 },
      context(),
    ).output as { finalPosition: { z: number } };
    const moved = registry.execute(
      'character-control.simulate',
      { entityId: CONTROLLED_ENTITY, ticks: 30, intent: { moveY: 1 } },
      context(),
    ).output as { finalPosition: { z: number } };

    expect(Math.abs(moved.finalPosition.z - still.finalPosition.z)).toBeGreaterThan(0.5);
  });

  it('accepts per-tick frames as well as a held intent', () => {
    const result = registry.execute(
      'character-control.simulate',
      {
        entityId: CONTROLLED_ENTITY,
        ticks: 3,
        frames: [{ moveY: 1 }, { moveY: 1 }, { moveY: 0 }],
      },
      context(),
    );
    expect(result.ok).toBe(true);
  });

  it('refuses an unknown entity rather than simulating something else', () => {
    const result = registry.execute(
      'character-control.simulate',
      { entityId: 'no-such-entity', ticks: 5 },
      context(),
    );
    expect(result.ok).toBe(false);
    expect(result.issues[0]!.keyword).toBe('reference');
  });

  /*
   * Reported as a missing input rather than answered with zeroes: a caller
   * reading an all-zero observation cannot tell "nothing happened" from
   * "nothing ran".
   */
  it('refuses to run without an asset registry', () => {
    const result = registry.execute(
      'character-control.simulate',
      { entityId: CONTROLLED_ENTITY, ticks: 5 },
      context({ registry: undefined }),
    );
    expect(result.ok).toBe(false);
    expect(result.issues[0]!.path).toBe('/registry');
  });

  it('caps the tick count so one extra zero cannot hang a request', () => {
    const result = registry.execute(
      'character-control.simulate',
      { entityId: CONTROLLED_ENTITY, ticks: 999_999 },
      context(),
    );
    expect(result.ok).toBe(false);
  });

  it('observes a character without advancing it', () => {
    const result = registry.execute(
      'character-control.observe',
      { entityId: SCRIPTED_ENTITY },
      context(),
    );
    expect(result.ok).toBe(true);
    const output = result.output as { controllerKind: string; intentSourceKind: string };
    expect(output.controllerKind).toBe('script');
    expect(output.intentSourceKind).toBe('script');
  });

  /*
   * The commands this group deliberately does not have. An AI that could name a
   * clip would bypass every transition rule the character was tuned with.
   */
  it.each(['character-control.play_animation', 'character-control.force_state', 'scene.set_clip'])(
    'does not expose %s',
    (commandId) => {
      expect(registry.command(commandId)).toBeUndefined();
    },
  );
});

describe('rig.edit', () => {
  it('reads one character back by route target, not by active id', () => {
    const result = registry.execute('rig.observe', {}, context({ characterId: 'demo-humanoid' }));
    expect(result.ok).toBe(true);
    expect((result.output as { characterId: string }).characterId).toBe('demo-humanoid');
  });

  it('refuses an unknown character rather than falling back', () => {
    const result = registry.execute('rig.observe', {}, context({ characterId: 'nope' }));
    expect(result.ok).toBe(false);
    expect(result.issues[0]!.path).toBe('/characterId');
  });

  it('sets the capsule and reports the path it changed', () => {
    const result = registry.execute(
      'rig.set_capsule',
      { radius: 0.34 },
      context({ characterId: 'demo-humanoid' }),
    );
    expect(result.ok).toBe(true);
    expect(result.changedPaths).toEqual(['/characters/demo-humanoid/capsuleRadius']);
  });

  it('refuses a capsule outside the schema bounds', () => {
    const result = registry.execute(
      'rig.set_capsule',
      { radius: 99 },
      context({ characterId: 'demo-humanoid' }),
    );
    expect(result.ok).toBe(false);
  });

  it('sets the display name through an explicitly typed command', () => {
    const result = registry.execute(
      'rig.set_display_name',
      { displayName: 'Renamed by machine' },
      context({ characterId: 'demo-humanoid' }),
    );
    expect(result.ok).toBe(true);
    expect(result.changedPaths).toEqual(['/characters/demo-humanoid/displayName']);
  });

  /*
   * The generic setter shape §4.9 forbids. A command taking a field selector
   * and an untyped value has no schema describing a valid call, so validation
   * moves into the body where nobody can see it.
   */
  it('exposes no command anywhere that accepts path, patch or value', () => {
    for (const command of registry.commands()) {
      const properties = Object.keys(
        (command.inputSchema as { properties?: Record<string, unknown> }).properties ?? {},
      );
      expect(properties).not.toContain('path');
      expect(properties).not.toContain('patch');
      expect(properties).not.toContain('value');
    }
  });

  it('validates the project it belongs to', () => {
    const result = registry.execute('rig.validate', {}, context());
    expect(result.ok).toBe(true);
    expect((result.output as { valid: boolean }).valid).toBe(true);
  });

  /*
   * Animation graph and clip edits are absent by design: which asset a tuning
   * change lands in is a blast-radius question the destination flow already
   * answers, and a second answer here would be the one with no dialog in front
   * of it.
   */
  it.each(['rig.set_blend_duration', 'rig.set_clip', 'rig.edit_graph'])(
    'does not expose %s',
    (commandId) => {
      expect(registry.command(commandId)).toBeUndefined();
    },
  );
});
