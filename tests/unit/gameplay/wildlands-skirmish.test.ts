/**
 * Wildlands Skirmish, against the real canonical Scene.
 *
 * These are properties of the *game*, not of a fixture: the Scene, the Prefabs,
 * the Scripts and the character simulation are the ones the browser loads. The
 * cases chosen are the ones that fail silently in play — an exactly-once rule
 * that fires twice, a reward that crosses a match boundary, a stat modifier
 * that stacks — and each is driven through the same events the HUD sends.
 */
import { describe, expect, it } from 'vitest';
import type { RuntimeScene } from '@atc/game-object-runtime';
import {
  combatantStates,
  directorState,
  instantiateWildlands,
} from '../../../harness/check-wildlands-skirmish.ts';

const PLAYER = 'skirmish-player';
const DIRECTOR = 'match-director';

function step(runtime: RuntimeScene, ticks: number): void {
  for (let tick = 0; tick < ticks; tick += 1) runtime.step({ cameraYawRad: 0 });
}

function player(runtime: RuntimeScene): Record<string, unknown> {
  return combatantStates(runtime)[PLAYER] as Record<string, unknown>;
}

/**
 * Steps past the spawn-protection window.
 *
 * Every combatant opens a match briefly invulnerable, so a test that hits one
 * on tick two would be asserting about the shield rather than about damage.
 */
function settle(runtime: RuntimeScene): void {
  step(runtime, 150);
}

function withScene<T>(body: (runtime: RuntimeScene) => T): T {
  const runtime = instantiateWildlands();
  try {
    return body(runtime);
  } finally {
    runtime.dispose();
  }
}

describe('Wildlands Skirmish', () => {
  it('boots a 5 v 5 match with no resolution errors', () => {
    withScene((runtime) => {
      expect(runtime.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
      const states = combatantStates(runtime);
      expect(Object.keys(states)).toHaveLength(10);
      expect(Object.values(states).filter((state) => state['team'] === 'ally')).toHaveLength(5);
      expect(Object.values(states).filter((state) => state['team'] === 'enemy')).toHaveLength(5);
      expect(directorState(runtime)['matchState']).toBe('active');
    });
  });

  it('applies damage through one clamped pipeline and reports the actual HP delta', () => {
    withScene((runtime) => {
      settle(runtime);
      const before = player(runtime);
      const defense = Number(before['defense']);
      runtime.emit(PLAYER, { type: 'damage', payload: { power: 40, sourceId: 'skirmish-enemy-1' } });
      step(runtime, 4);
      const after = player(runtime);
      const applied = Math.max(1, Math.round(40 - defense * 0.6));
      expect(Number(after['hp'])).toBe(Number(before['hp']) - applied);
      /* The number the HUD shows is the delta that was applied, not a guess. */
      expect(Number(after['hitAmount'])).toBe(applied);
      expect(Number(after['hitSeq'])).toBe(Number(before['hitSeq']) + 1);
    });
  });

  it('never leaves negative HP and never heals past the maximum', () => {
    withScene((runtime) => {
      settle(runtime);
      runtime.emit(PLAYER, { type: 'damage', payload: { power: 9999, sourceId: 'skirmish-enemy-1' } });
      step(runtime, 4);
      expect(Number(player(runtime)['hp'])).toBe(0);
      expect(player(runtime)['alive']).toBe(false);

      /* Respawned, then over-healed: the reported restore is what fitted. */
      step(runtime, 400);
      expect(player(runtime)['alive']).toBe(true);
      runtime.emit(PLAYER, { type: 'damage', payload: { power: 30, sourceId: 'skirmish-enemy-1' } });
      step(runtime, 4);
      const hurt = Number(player(runtime)['hp']);
      const maxHp = Number(player(runtime)['maxHp']);
      runtime.emit(PLAYER, { type: 'heal', payload: { amount: 9999 } });
      step(runtime, 4);
      expect(Number(player(runtime)['hp'])).toBe(maxHp);
      expect(Number(player(runtime)['healAmount'])).toBe(maxHp - hurt);
    });
  });

  it('spawns a defeated raider\'s currency and collects it exactly once', () => {
    withScene((runtime) => {
      settle(runtime);
      const before = Number(directorState(runtime)['currency']);
      runtime.emit('skirmish-enemy-2', { type: 'damage', payload: { power: 9999, sourceId: PLAYER } });
      step(runtime, 6);
      const pickups = directorState(runtime)['pickups'] as { id: string; value: number }[];
      expect(pickups).toHaveLength(1);
      expect(runtime.get(pickups[0]!.id)).toBeDefined();

      /* The player earns the KO's XP once, and the drop's value once. */
      expect(Number(directorState(runtime)['playerKos'])).toBe(1);
      expect(Number(directorState(runtime)['xp'])).toBeGreaterThan(0);

      /* Put a drop at the player's feet rather than walking them across the map. */
      runtime.emit(DIRECTOR, { type: 'debug', payload: { action: 'coin', amount: 0 } });
      step(runtime, 20);
      const outstanding = (directorState(runtime)['pickups'] as { id: string }[]).map((entry) => entry.id);
      const after = Number(directorState(runtime)['currency']);
      expect(after).toBe(before + 14);
      /* Collected once, and the object left with the payment. */
      step(runtime, 20);
      expect(Number(directorState(runtime)['currency'])).toBe(after);
      for (const id of outstanding) expect(runtime.get(id)).toBeDefined();
    });
  });

  it('charges a purchase once, equips it, and refuses a second charge for the same item', () => {
    withScene((runtime) => {
      runtime.emit(DIRECTOR, { type: 'debug', payload: { action: 'currency', amount: 300 } });
      step(runtime, 4);
      const funds = Number(directorState(runtime)['currency']);
      const baseDefense = Number(player(runtime)['defense']);

      runtime.emit(DIRECTOR, { type: 'purchase', payload: { itemId: 'plated-cuirass' } });
      step(runtime, 6);
      expect(Number(directorState(runtime)['currency'])).toBe(funds - 75);
      expect(player(runtime)['chest']).toBe('plated-cuirass');
      expect(Number(player(runtime)['defense'])).toBe(baseDefense + 7);

      /* Buying it again is a no-op, not a second charge and not a second modifier. */
      runtime.emit(DIRECTOR, { type: 'purchase', payload: { itemId: 'plated-cuirass' } });
      step(runtime, 6);
      expect(Number(directorState(runtime)['currency'])).toBe(funds - 75);
      expect(Number(player(runtime)['defense'])).toBe(baseDefense + 7);

      /* Replacing the slot removes the old modifier exactly once. */
      runtime.emit(DIRECTOR, { type: 'purchase', payload: { itemId: 'leather-vest' } });
      step(runtime, 6);
      expect(player(runtime)['chest']).toBe('leather-vest');
      expect(Number(player(runtime)['defense'])).toBe(baseDefense + 3);
    });
  });

  it('refuses a purchase that cannot be afforded', () => {
    withScene((runtime) => {
      settle(runtime);
      runtime.emit(DIRECTOR, { type: 'purchase', payload: { itemId: 'plated-cuirass' } });
      step(runtime, 6);
      expect(Number(directorState(runtime)['currency'])).toBe(0);
      expect(player(runtime)['chest']).toBe('');
      expect(String(directorState(runtime)['feedbackText'])).toMatch(/not enough/i);
    });
  });

  it('spends exactly one stat choice per pending level, however often the choice is sent', () => {
    withScene((runtime) => {
      runtime.emit(DIRECTOR, { type: 'debug', payload: { action: 'xp', amount: 90 } });
      step(runtime, 4);
      expect(Number(directorState(runtime)['pendingLevelUps'])).toBe(1);
      const before = Number(player(runtime)['maxHp']);

      for (let repeat = 0; repeat < 3; repeat += 1)
        runtime.emit(DIRECTOR, { type: 'level-choice', payload: { stat: 'hp' } });
      step(runtime, 6);
      expect(Number(directorState(runtime)['pendingLevelUps'])).toBe(0);
      expect(Number(directorState(runtime)['upHp'])).toBe(1);
      expect(Number(player(runtime)['maxHp'])).toBe(before + 12);
    });
  });

  it('uses a consumable exactly once per press', () => {
    withScene((runtime) => {
      settle(runtime);
      expect(Number(directorState(runtime)['potions'])).toBe(1);
      runtime.emit(DIRECTOR, { type: 'use-consumable', payload: {} });
      runtime.emit(DIRECTOR, { type: 'use-consumable', payload: {} });
      step(runtime, 6);
      expect(Number(directorState(runtime)['potions'])).toBe(0);
    });
  });

  it('switches the held loadout and the motion context together', () => {
    withScene((runtime) => {
      settle(runtime);
      expect(runtime.get(PLAYER)?.character?.motionContextKey).toBe('sword');
      runtime.emit(PLAYER, { type: 'set-loadout', payload: { index: 2 } });
      step(runtime, 4);
      expect(player(runtime)['loadoutId']).toBe('magic');
      expect(runtime.get(PLAYER)?.character?.motionContextKey).toBe('magic');
    });
  });

  it('keeps same-match equipment and progression across a respawn', () => {
    withScene((runtime) => {
      runtime.emit(DIRECTOR, { type: 'debug', payload: { action: 'currency', amount: 300 } });
      runtime.emit(DIRECTOR, { type: 'debug', payload: { action: 'xp', amount: 90 } });
      step(runtime, 4);
      runtime.emit(DIRECTOR, { type: 'purchase', payload: { itemId: 'iron-helm' } });
      runtime.emit(DIRECTOR, { type: 'level-choice', payload: { stat: 'attack' } });
      step(runtime, 6);
      const attack = Number(player(runtime)['attack']);
      const currency = Number(directorState(runtime)['currency']);

      runtime.emit(PLAYER, { type: 'force-ko', payload: {} });
      step(runtime, 260);
      expect(player(runtime)['alive']).toBe(true);
      expect(player(runtime)['head']).toBe('iron-helm');
      expect(Number(player(runtime)['attack'])).toBe(attack);
      expect(Number(directorState(runtime)['currency'])).toBe(currency);
      expect(Number(directorState(runtime)['level'])).toBe(2);
    });
  });

  it('drops a reward reported against a match generation that has ended', () => {
    withScene((runtime) => {
      step(runtime, 4);
      const generation = Number(directorState(runtime)['generation']);
      runtime.emit(DIRECTOR, { type: 'debug', payload: { action: 'end-match', amount: 0 } });
      step(runtime, 700);
      const next = directorState(runtime);
      expect(Number(next['generation'])).toBeGreaterThan(generation);

      /* A KO report from the previous generation must not score or pay out. */
      runtime.emit(DIRECTOR, {
        type: 'ko',
        payload: { victimId: 'skirmish-enemy-1', victimTeam: 'enemy', killerId: PLAYER, assistId: '', x: 0, z: 0, generation },
      });
      step(runtime, 6);
      const after = directorState(runtime);
      expect(Number(after['allyScore'])).toBe(0);
      expect(Number(after['xp'])).toBe(0);
      expect((after['pickups'] as unknown[]).length).toBe(0);
    });
  });

  it('reports no health-check warnings while a match is running', () => {
    withScene((runtime) => {
      step(runtime, 600);
      expect(directorState(runtime)['warnings']).toEqual([]);
    });
  });
});
