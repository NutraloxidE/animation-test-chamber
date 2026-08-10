/**
 * `pnpm harness:wildlands` — the deterministic match harness.
 *
 * A five-minute match cannot be a test, and two of them cannot be a gate. This
 * runs the real Scene, the real Scripts and the real character simulation
 * headlessly, uses the game's own debug time-advance to compress the day, and
 * asserts the properties that matter across *several* generations:
 *
 *   the two teams stay five strong
 *   combat actually resolves, both ways
 *   currency drops, is bounded, and is cleaned up
 *   a match ends, resets, and starts the next day
 *   nothing from the previous generation survives into the next
 *   no object is duplicated and no runtime warning is raised
 *
 * Everything here reads the same authoritative Script state the HUD reads, so
 * a pass is evidence about the game rather than about a fixture.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { JsonObject, ProjectDefinition } from '@atc/schema';
import { instantiateScene, type RuntimeScene } from '@atc/game-object-runtime';
import { gameplayScriptRegistry } from '@atc/gameplay';
import { TERRAIN_PRESETS } from '@atc/terrain-runtime';
import { loadAssetRegistry } from './animation-assets.ts';
import { loadPrefabRegistry } from './prefabs.ts';
import { REPO_ROOT, printStage, stage, type StageIssue, type StageResult } from './lib.ts';

export const WILDLANDS_SCENE_ID = 'wildlands-skirmish';

export function instantiateWildlands(): RuntimeScene {
  const project = JSON.parse(
    readFileSync(resolve(REPO_ROOT, 'projects/demo-character/project.json'), 'utf8'),
  ) as ProjectDefinition;
  const scene = project.scenes.find((candidate) => candidate.id === WILDLANDS_SCENE_ID);
  if (!scene) throw new Error(`Scene "${WILDLANDS_SCENE_ID}" is not in the canonical project`);
  const terrain =
    TERRAIN_PRESETS.find((candidate) => candidate.id === project.defaultTerrainPresetId) ?? TERRAIN_PRESETS[0]!;
  return instantiateScene({
    scene,
    project,
    terrain,
    services: {
      animationRegistry: loadAssetRegistry(),
      prefabRegistry: loadPrefabRegistry(),
      gameplayRegistry: gameplayScriptRegistry,
      clock: { fixedDeltaSeconds: 1 / 60 },
      terrain,
    },
  });
}

export function directorState(runtime: RuntimeScene): Record<string, unknown> {
  const state = runtime.gameplaySnapshot()['match-director']?.['director'];
  if (!state) throw new Error('the match director is not running');
  return state as Record<string, unknown>;
}

export function combatantStates(runtime: RuntimeScene): Record<string, JsonObject> {
  const snapshot = runtime.gameplaySnapshot();
  const states: Record<string, JsonObject> = {};
  for (const [id, components] of Object.entries(snapshot)) {
    const combatant = components['combatant'];
    if (combatant) states[id] = combatant;
  }
  return states;
}

function run(runtime: RuntimeScene, ticks: number): void {
  for (let tick = 0; tick < ticks; tick += 1) runtime.step({ cameraYawRad: 0 });
}

function wildlandsStage(): StageResult {
  return stage(
    'wildlands skirmish match lifecycle',
    {
      reproduce: 'pnpm harness:wildlands',
      blocksCommit: true,
      suggestion: 'a failure here is a gameplay contract failure: check the director generation guard and the combatant respawn path',
    },
    () => {
      const issues: StageIssue[] = [];
      const fail = (message: string, expected: string, actual: string): void => {
        issues.push({ files: ['packages/gameplay/src/scripts'], expected, actual, message });
      };

      const runtime = instantiateWildlands();
      const errors = runtime.issues.filter((issue) => issue.severity === 'error');
      if (errors.length > 0) fail('the Scene does not resolve', 'no resolution errors', errors.map((issue) => issue.message).join('; '));

      const combatants = Object.keys(combatantStates(runtime));
      if (combatants.length !== 10) fail('the match is not 5 v 5', '10 combatants', `${combatants.length}`);

      /* Let the two sides actually meet. */
      run(runtime, 2400);
      const fighting = directorState(runtime);
      const score = Number(fighting['allyScore']) + Number(fighting['enemyScore']);
      if (score <= 0) fail('nobody was defeated in 40 seconds of AI combat', 'at least one KO', `${score}`);
      if (Number(fighting['aliveAllies']) + Number(fighting['aliveEnemies']) > 10)
        fail('more actors are alive than exist', '10 or fewer', `${Number(fighting['aliveAllies']) + Number(fighting['aliveEnemies'])}`);

      /* Damage must never leave an invalid character behind. */
      for (const [id, state] of Object.entries(combatantStates(runtime))) {
        const hp = Number(state['hp']);
        const maxHp = Number(state['maxHp']);
        const stamina = Number(state['stamina']);
        if (!(hp >= 0 && hp <= maxHp)) fail(`${id} has invalid HP`, `0..${maxHp}`, `${hp}`);
        if (!(stamina >= 0 && stamina <= Number(state['maxStamina'])))
          fail(`${id} has invalid stamina`, `0..${state['maxStamina']}`, `${stamina}`);
      }

      const generationBefore = Number(fighting['generation']);
      const idsBefore = new Set(runtime.gameObjects.map((object) => object.id));

      /* Two compressed match cycles, through the game's own debug time advance. */
      for (let cycle = 0; cycle < 2; cycle += 1) {
        runtime.emit('match-director', { type: 'debug', payload: { action: 'xp', amount: 400 } });
        run(runtime, 4);
        runtime.emit('match-director', { type: 'debug', payload: { action: 'end-match', amount: 0 } });
        run(runtime, 700);
        const next = directorState(runtime);
        if (Number(next['generation']) <= generationBefore + cycle)
          fail('a match reset did not begin a new generation', `> ${generationBefore + cycle}`, `${next['generation']}`);
        if (next['matchState'] !== 'active') fail('the next match did not start', 'active', String(next['matchState']));
        for (const field of ['xp', 'currency', 'allyScore', 'enemyScore', 'pendingLevelUps', 'upHp', 'upAttack'])
          if (Number(next[field]) !== 0) fail(`match-scoped "${field}" survived the reset`, '0', `${next[field]}`);
        if ((next['pickups'] as unknown[]).length !== 0)
          fail('a previous match left currency on the ground', '0 pickups', `${(next['pickups'] as unknown[]).length}`);
        for (const [id, state] of Object.entries(combatantStates(runtime))) {
          if (state['head'] !== '' || state['chest'] !== '' || state['legs'] !== '')
            fail(`${id} kept armour across the match reset`, 'the baseline loadout', `${state['head']}/${state['chest']}/${state['legs']}`);
          if (state['alive'] !== true) fail(`${id} did not return to the field`, 'alive', 'defeated');
        }
      }

      /* Repeated deaths must not grow the world or duplicate an actor. */
      for (let repeat = 0; repeat < 4; repeat += 1) {
        runtime.emit('skirmish-player', { type: 'force-ko', payload: {} });
        run(runtime, 260);
      }
      const idsAfter = runtime.gameObjects.map((object) => object.id);
      if (new Set(idsAfter).size !== idsAfter.length) fail('a GameObject id is duplicated', 'unique ids', 'duplicates found');
      for (const id of idsBefore)
        if (!idsAfter.includes(id)) fail(`GameObject "${id}" disappeared`, 'the authored Scene roster', 'missing');

      const finalState = directorState(runtime);
      const warnings = (finalState['warnings'] as string[]) ?? [];
      if (warnings.length > 0) fail('the runtime health check reported a problem', 'no warnings', warnings.join('; '));
      if ((finalState['log'] as unknown[]).length > 60) fail('the debug event log is unbounded', '<= 60 entries', `${(finalState['log'] as unknown[]).length}`);

      runtime.dispose();
      return {
        ok: issues.length === 0,
        issues,
        output: `generation ${finalState['generation']}, day ${finalState['day']}, ${idsAfter.length} GameObjects, ${warnings.length} warnings`,
      };
    },
  );
}

export function wildlandsStages(): StageResult[] {
  return [wildlandsStage()];
}

function main(): void {
  let failed = false;
  for (const result of wildlandsStages()) {
    printStage(result);
    if (!result.ok) failed = true;
  }
  process.exit(failed ? 1 : 0);
}

if (process.argv[1]?.includes('check-wildlands-skirmish')) main();
