import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  completionPolicyForState,
  migrateProjectToAssets,
  motionSlotForState,
  movementPolicyForState,
  type LegacyProject,
  type LegacyState,
} from '@atc/animation-asset-runtime';
import { validateProject, validateProjectReferences } from '@atc/schema';

const legacy = JSON.parse(
  readFileSync(
    resolve(__dirname, '../../fixtures/animation-assets/legacy-demo-project.v1.json'),
    'utf8',
  ),
) as LegacyProject;

const state = (id: string): LegacyState =>
  legacy.graph.states.find((entry) => entry.id === id)!;

describe('motion slot generation', () => {
  it.each([
    ['idle', 'locomotion.idle'],
    ['walk', 'locomotion.walk'],
    ['run', 'locomotion.run'],
    ['jump', 'airborne.jump'],
    ['fall', 'airborne.fall'],
    ['land', 'airborne.land'],
    ['dodge', 'mobility.dodge'],
    ['attack-01', 'action.primary.01'],
    ['attack-02', 'action.primary.02'],
  ])('maps %s to %s', (stateId, slot) => {
    expect(motionSlotForState(stateId)).toBe(slot);
  });

  it('falls back to a namespaced slot for an unrecognised state', () => {
    expect(motionSlotForState('guard-shield')).toBe('state.guard-shield');
  });
});

describe('name-based rules become policy fields', () => {
  /*
   * Each of these reproduces exactly what the old runtime inferred from the
   * state's spelling. The shadow comparison in the harness proves the whole
   * translation; these assert the individual rules so a failure says which one.
   */
  it('an attack holds its final frame', () => {
    expect(completionPolicyForState(state('attack-01')).mode).toBe('hold-final-frame');
    expect(completionPolicyForState(state('attack-01-recovery')).mode).toBe('hold-final-frame');
  });

  it('a looping state loops, and everything else falls through', () => {
    expect(completionPolicyForState(state('idle')).mode).toBe('loop');
    expect(completionPolicyForState(state('land')).mode).toBe('immediate-fallback');
  });

  it('attacks lock movement until recovery', () => {
    expect(movementPolicyForState(state('attack-01')).locksMovementUntilRecovery).toBe(true);
    expect(movementPolicyForState(state('dodge')).locksMovementUntilRecovery).toBe(false);
  });

  it('dodge and recovery states hand authority back', () => {
    expect(movementPolicyForState(state('dodge')).returnsAuthorityOnRecovery).toBe(true);
    expect(movementPolicyForState(state('attack-01-recovery')).returnsAuthorityOnRecovery).toBe(
      true,
    );
    expect(movementPolicyForState(state('attack-01')).returnsAuthorityOnRecovery).toBe(false);
  });

  it('only walk and run provide locomotion authority', () => {
    expect(movementPolicyForState(state('walk')).providesLocomotionAuthority).toBe(true);
    expect(movementPolicyForState(state('run')).providesLocomotionAuthority).toBe(true);
    expect(movementPolicyForState(state('idle')).providesLocomotionAuthority).toBe(false);
  });

  it('records which authored speed a locomotion clip was made at', () => {
    expect(movementPolicyForState(state('walk')).locomotionSpeedReference).toBe('walk');
    expect(movementPolicyForState(state('run')).locomotionSpeedReference).toBe('run');
    expect(movementPolicyForState(state('jump')).locomotionSpeedReference).toBe('none');
  });

  it('a dedicated recovery state returns authority from its first frame', () => {
    const result = migrateProjectToAssets(legacy);
    const behavior = result.assets.find((asset) => asset.assetType === 'animation-behavior')!;
    const states = (behavior.document as { graph: { states: { id: string; recoveryPolicy?: { authorityReturnAtNormalized: number } }[] } })
      .graph.states;
    expect(
      states.find((entry) => entry.id === 'attack-01-recovery')!.recoveryPolicy!
        .authorityReturnAtNormalized,
    ).toBe(0);
    expect(
      states.find((entry) => entry.id === 'dodge')!.recoveryPolicy!.authorityReturnAtNormalized,
    ).toBe(0.78);
  });
});

describe('migration output', () => {
  const result = migrateProjectToAssets(legacy);

  it('produces the assets the plan names', () => {
    const ids = new Set(result.assets.map((asset) => asset.id));
    for (const expected of [
      'humanoid-third-person-base',
      'demo-humanoid-motion-set',
      'demo-humanoid-rig',
      'demo-default-tuning',
      'alternate-humanoid-motion-set',
    ]) {
      expect(ids.has(expected)).toBe(true);
    }
  });

  it('produces one clip asset per legacy clip, twice over for two characters', () => {
    const clips = result.assets.filter((asset) => asset.assetType === 'animation-clip');
    expect(clips.length).toBe(legacy.clips.length * 2);
  });

  it('leaves the project holding references rather than a graph', () => {
    expect('graph' in result.project).toBe(false);
    expect('clips' in result.project).toBe(false);
    expect(result.project.characters).toHaveLength(2);
    for (const character of result.project.characters) {
      expect(character.animation.behavior.assetId).toBe('humanoid-third-person-base');
      expect(character.animation.behavior.contentHash).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it('gives the two characters different motion sets', () => {
    const [first, second] = result.project.characters;
    expect(first!.animation.motionSet.assetId).not.toBe(second!.animation.motionSet.assetId);
  });

  it('turns weapon clips into contextual bindings', () => {
    const motionSet = result.assets.find((asset) => asset.id === 'demo-humanoid-motion-set')!;
    const bindings = (motionSet.document as { bindings: { motionSlot: string; contextualKey?: string }[] })
      .bindings;
    const contextual = bindings.filter(
      (binding) => binding.motionSlot === 'action.primary.01' && binding.contextualKey,
    );
    expect(contextual.map((binding) => binding.contextualKey).sort()).toEqual([
      'magic',
      'pistol',
      'shield',
      'sword',
      'throw',
      'unarmed',
    ]);
  });

  it('no state references a clip id', () => {
    const behavior = result.assets.find((asset) => asset.assetType === 'animation-behavior')!;
    const states = (behavior.document as { graph: { states: Record<string, unknown>[] } }).graph
      .states;
    for (const state of states) {
      expect('clipId' in state).toBe(false);
      expect('weaponClips' in state).toBe(false);
      expect(typeof state.motionSlot).toBe('string');
    }
  });

  it('produces a schema-valid project', () => {
    expect(validateProject(result.project).issues).toEqual([]);
    expect(validateProjectReferences(result.project).issues).toEqual([]);
  });

  it('is deterministic', () => {
    // A wall-clock timestamp anywhere would move every content hash on every
    // run, invalidating every reference the migration had just written.
    expect(JSON.stringify(migrateProjectToAssets(legacy))).toBe(JSON.stringify(result));
  });
});
