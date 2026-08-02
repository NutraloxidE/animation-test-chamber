/**
 * `pnpm harness:world` — the world contract stage.
 *
 * Checks the things a unit test would only check for the fixture it happens to
 * load: that the acceptance world validates, that its instances genuinely share
 * one resolved document while sharing no mutable state, that the world is
 * deterministic across two runs, and that a legacy project still resolves to a
 * single synthesized instance.
 *
 * It runs before the test suites in `harness:one-shot` for the same reason the
 * asset stages do: a broken world contract makes every later failure a symptom.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { WorldDefinition } from '@atc/schema';
import { validateAgainst, validateProjectReferences } from '@atc/schema';
import {
  WorldRuntime,
  hashWorldTrace,
  neutralIntent,
  observeWorld,
  flattenObservations,
  recordWorldTrace,
  worldOf,
} from '@atc/world-runtime';
import { loadAssetRegistry, loadCanonicalProject } from './animation-assets.ts';
import { REPO_ROOT, printStage, stage, type StageIssue, type StageResult } from './lib.ts';

const FIXTURE_PATH = 'tests/fixtures/world/two-humanoids-shared-animation.json';

function loadFixture(): WorldDefinition {
  return JSON.parse(readFileSync(resolve(REPO_ROOT, FIXTURE_PATH), 'utf8')) as WorldDefinition;
}

function issue(message: string, expected: string, actual: string): StageIssue {
  return { files: [FIXTURE_PATH], expected, actual, message };
}

export function worldContractStage(): StageResult {
  return stage(
    'world contract',
    {
      reproduce: 'pnpm harness:world',
      blocksCommit: true,
      suggestion:
        'a world failure is a contract failure: check instance identity, shared resolution and tick order before touching the fixture',
    },
    () => {
      const issues: StageIssue[] = [];
      const world = loadFixture();
      const project = loadCanonicalProject();
      const registry = loadAssetRegistry();

      const schema = validateAgainst('WorldDefinition', world);
      for (const problem of schema.issues) {
        issues.push(issue(`fixture ${problem.path}: ${problem.message}`, 'a valid world', problem.message));
      }

      const references = validateProjectReferences({ ...project, world });
      for (const problem of references.issues) {
        issues.push(
          issue(`references ${problem.path}: ${problem.message}`, 'resolvable references', problem.message),
        );
      }

      const runtime = new WorldRuntime({ registry, project, world });

      // Shared definition, independent state — the whole contract in two checks.
      const [firstId, secondId] = runtime.instanceIds;
      if (firstId && secondId) {
        const first = runtime.instance(firstId)!;
        const second = runtime.instance(secondId)!;
        if (first.definition.source.characterId === second.definition.source.characterId) {
          if (first.resolved !== second.resolved) {
            issues.push(
              issue(
                'two instances of one character resolved to different documents',
                'one shared resolved document',
                'two documents',
              ),
            );
          }
          if (first.simulation === second.simulation) {
            issues.push(
              issue(
                'two instances share one simulation object',
                'independent mutable state per instance',
                'a shared Simulation',
              ),
            );
          }
        }
      }

      // Determinism: two independent runs from the same start state.
      const hashA = hashWorldTrace(
        recordWorldTrace(new WorldRuntime({ registry, project, world }), 120),
      );
      const hashB = hashWorldTrace(
        recordWorldTrace(new WorldRuntime({ registry, project, world }), 120),
      );
      if (hashA !== hashB) {
        issues.push(issue('repeated fixed-tick runs produced different worlds', hashA, hashB));
      }

      // Routing: an injected local frame must not reach the scripted instance.
      const routed = new WorldRuntime({ registry, project, world });
      for (let tick = 0; tick < 30; tick += 1) {
        routed.injectLocalIntent(0, { ...neutralIntent(), moveY: 1 });
        routed.step();
      }
      for (const id of routed.instanceIds) {
        const state = routed.instance(id)!;
        if (state.definition.intentSource.kind !== 'local-input' && state.lastIntent.moveY === 1) {
          issues.push(
            issue(
              `instance "${id}" received input bound to another instance`,
              'intent reaches only the bound instance',
              `moveY=1 on a ${state.definition.intentSource.kind} source`,
            ),
          );
        }
      }

      // Observation paths must name instances, never array positions.
      const paths = flattenObservations(observeWorld(routed)).map((entry) => entry.path);
      for (const path of paths) {
        if (/\/instances\/\d+\//.test(path)) {
          issues.push(issue(`observation path uses an array index: ${path}`, 'stable instance ids', path));
        }
      }

      // Legacy: a project with no explicit world still runs, as one instance.
      const legacy = worldOf(project);
      if (legacy.instances.length !== 1) {
        issues.push(
          issue(
            'a legacy project synthesized more than one instance',
            'exactly one synthesized instance',
            String(legacy.instances.length),
          ),
        );
      }
      if (legacy.instances[0]?.source.characterId !== project.activeCharacterId) {
        issues.push(
          issue(
            'the synthesized instance does not follow activeCharacterId',
            project.activeCharacterId,
            String(legacy.instances[0]?.source.characterId),
          ),
        );
      }

      return {
        ok: issues.length === 0,
        issues,
        output: `${runtime.instanceIds.length} instances, world hash ${hashA}`,
      };
    },
  );
}

export function worldStages(): StageResult[] {
  return [worldContractStage()];
}

if (process.argv[1]?.includes('check-world')) {
  const results = worldStages();
  for (const result of results) printStage(result);
  process.exit(results.every((result) => result.ok) ? 0 : 1);
}
