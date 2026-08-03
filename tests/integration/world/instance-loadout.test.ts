/**
 * Loadout isolation: two instances of one character, disagreeing.
 *
 * This is the property that makes moving Weapon Mode and Shield into the
 * Instance Inspector meaningful rather than cosmetic. The controls they
 * replaced were global engine setters with no instance in their signature, so
 * "which instance did that change?" had no answer — and in a world holding two
 * instances of the same character definition, the honest answer would have
 * been "both, or the wrong one".
 *
 * The commands are asserted here rather than the React panel because the panel
 * is one caller of them. The API and the AI are the others, and all three must
 * be unable to express a loadout edit that is not instance-qualified.
 */
import { describe, expect, it } from 'vitest';
import type { WorldDefinition } from '@atc/schema';
import { createDefaultRegistry } from '@atc/capability-runtime';
import { loadDemoProject } from '../../fixtures/project.ts';
import { loadWorldFixture } from '../../fixtures/world.ts';

const CONTROLLED = 'controlled-humanoid';
const SCRIPTED = 'scripted-humanoid';

function run(world: WorldDefinition, commandId: string, input: unknown) {
  return createDefaultRegistry().execute(commandId, input, {
    project: loadDemoProject(),
    world,
    actor: 'human',
  });
}

function instance(world: WorldDefinition, id: string) {
  return world.instances.find((entry) => entry.id === id)!;
}

/** The first declared equipment slot, whatever the project happens to call it. */
function firstSlotId(): string {
  return loadDemoProject().equipment[0]!.id;
}

describe('instance-qualified loadout commands', () => {
  it('the acceptance world holds two instances of one character definition', () => {
    // Everything below is only interesting because this is true: if the two
    // instances referenced different characters, "the shared default is
    // unchanged" would be trivially satisfied.
    const world = loadWorldFixture();
    expect(instance(world, CONTROLLED).source.characterId).toBe(
      instance(world, SCRIPTED).source.characterId,
    );
  });

  describe('shield', () => {
    it('disabling equipment on one instance leaves its sibling and the definition alone', () => {
      const slotId = firstSlotId();
      const before = loadDemoProject().equipment.find((slot) => slot.id === slotId)!;

      const result = run(loadWorldFixture(), 'world.set_instance_equipment', {
        instanceId: CONTROLLED,
        slotId,
        equipped: false,
      });
      expect(result.ok).toBe(true);
      const staged = result.stagedWorld!;

      expect(instance(staged, CONTROLLED).overrides?.equipped?.[slotId]).toBe(false);
      // The sibling has no override at all — not an override that happens to
      // agree, which would silently stop following the definition later.
      expect(instance(staged, SCRIPTED).overrides?.equipped?.[slotId]).toBeUndefined();
      // And the shared definition is untouched.
      expect(loadDemoProject().equipment.find((slot) => slot.id === slotId)).toEqual(before);
    });

    it('clearing the override removes it rather than writing the default back', () => {
      const slotId = firstSlotId();
      const overridden = run(loadWorldFixture(), 'world.set_instance_equipment', {
        instanceId: CONTROLLED,
        slotId,
        equipped: false,
      }).stagedWorld!;

      const cleared = run(overridden, 'world.set_instance_equipment', {
        instanceId: CONTROLLED,
        slotId,
      }).stagedWorld!;

      // Absent, not `true`. An override recorded as the current default would
      // stop tracking the definition the moment somebody changed it.
      expect(instance(cleared, CONTROLLED).overrides?.equipped?.[slotId]).toBeUndefined();
      expect(instance(cleared, CONTROLLED).overrides?.equipped).toBeUndefined();
    });

    it('refuses an equipment slot the project does not declare', () => {
      const result = run(loadWorldFixture(), 'world.set_instance_equipment', {
        instanceId: CONTROLLED,
        slotId: 'not-a-slot',
        equipped: true,
      });
      expect(result.ok).toBe(false);
      expect(result.issues[0]!.path).toBe('/slotId');
    });
  });

  describe('weapon mode', () => {
    it('changes one instance and not its sibling', () => {
      const result = run(loadWorldFixture(), 'world.set_instance_weapon_mode', {
        instanceId: SCRIPTED,
        weaponModeId: 'sword',
      });
      expect(result.ok).toBe(true);
      const staged = result.stagedWorld!;

      expect(instance(staged, SCRIPTED).overrides?.weaponModeId).toBe('sword');
      expect(instance(staged, CONTROLLED).overrides?.weaponModeId).toBeUndefined();
    });

    it('resets to the character default by removing the override', () => {
      const overridden = run(loadWorldFixture(), 'world.set_instance_weapon_mode', {
        instanceId: SCRIPTED,
        weaponModeId: 'sword',
      }).stagedWorld!;

      const cleared = run(overridden, 'world.set_instance_weapon_mode', {
        instanceId: SCRIPTED,
      }).stagedWorld!;

      expect(instance(cleared, SCRIPTED).overrides?.weaponModeId).toBeUndefined();
    });

    it('refuses an unknown instance rather than editing nothing quietly', () => {
      const result = run(loadWorldFixture(), 'world.set_instance_weapon_mode', {
        instanceId: 'nobody',
        weaponModeId: 'sword',
      });
      expect(result.ok).toBe(false);
      expect(result.issues[0]!.path).toBe('/instanceId');
    });
  });

  it('preserves declaration order, and therefore tick order, across a loadout edit', () => {
    const before = loadWorldFixture().instances.map((entry) => entry.id);
    const staged = run(loadWorldFixture(), 'world.set_instance_weapon_mode', {
      instanceId: CONTROLLED,
      weaponModeId: 'sword',
    }).stagedWorld!;
    expect(staged.instances.map((entry) => entry.id)).toEqual(before);
  });

  it('both commands stage rather than write, like every other mutating command', () => {
    const world = loadWorldFixture();
    const result = run(world, 'world.set_instance_equipment', {
      instanceId: CONTROLLED,
      slotId: firstSlotId(),
      equipped: false,
    });
    // The input document is not mutated; publishing stays on the validated
    // save path, which is what keeps the human and machine paths identical.
    expect(world).toEqual(loadWorldFixture());
    expect(result.changedPaths?.[0]).toContain(`/world/instances/${CONTROLLED}/overrides`);
  });
});
