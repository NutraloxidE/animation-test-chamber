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
  WorldReplayRecorder,
  WorldRuntime,
  createReplayRuntime,
  flattenObservations,
  hashWorldTrace,
  neutralIntent,
  observeWorld,
  animationResolutionKey,
  recordWorldTrace,
  resolveWorld,
  simulateWorld,
  worldOf,
} from '@atc/world-runtime';
import { createDefaultRegistry } from '@atc/capability-runtime';
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
          // Bundle identity, not wrapper identity — see the resolution checks
          // below and reports/pr14-critical-fixes.md.
          if (first.animationResolutionKey !== second.animationResolutionKey) {
            issues.push(
              issue(
                'two instances of one character resolved to different animation bundles',
                'one shared bundle identity',
                'two identities',
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

      /*
       * Character-safe resolution. The cache must share the immutable animation
       * bundle and nothing else: sharing the whole `ResolvedProject` hands one
       * character another's model path and capsule dimensions. Checked
       * structurally, by identity, rather than by scanning source text.
       */
      const resolution = resolveWorld({ registry, project, world });
      const [firstResolved, secondResolved] = resolution.instances;
      if (firstResolved && secondResolved) {
        if (firstResolved.resolved === secondResolved.resolved) {
          issues.push(
            issue(
              'two instances share one ResolvedProject wrapper',
              'a distinct wrapper per instance',
              'one shared wrapper',
            ),
          );
        }
        if (firstResolved.bundle !== secondResolved.bundle) {
          issues.push(
            issue(
              'two instances of one character resolved to different animation bundles',
              'one shared immutable bundle',
              'two bundles',
            ),
          );
        }
        /*
         * Rename-invariance rather than a substring scan: an asset id may
         * legitimately contain the character's name, so "the key does not
         * mention the character" is not a property the key can have. What it
         * must have is that renaming a character does not change it.
         */
        const character = project.characters.find(
          (entry) => entry.id === firstResolved.definition.source.characterId,
        );
        if (
          character &&
          animationResolutionKey({ ...character, id: 'renamed-for-the-harness' }) !==
            animationResolutionKey(character)
        ) {
          issues.push(
            issue(
              'renaming a character changed its animation resolution key',
              'a key built only from animation inputs',
              'the key moved',
            ),
          );
        }
      }

      /*
       * Stateless simulation. Two independent calls must agree, because the
       * HTTP surface builds a fresh runtime per request and has no other way to
       * be correct.
       */
      const simulateArgs = { registry, project, world, ticks: 90 } as const;
      const simulatedA = simulateWorld(simulateArgs);
      const simulatedB = simulateWorld(simulateArgs);
      if (simulatedA.worldHash !== simulatedB.worldHash) {
        issues.push(
          issue(
            'two identical simulate calls disagreed',
            simulatedA.worldHash,
            simulatedB.worldHash,
          ),
        );
      }
      if (simulatedA.tick !== 90 || simulatedA.observation.tick !== 90) {
        issues.push(
          issue(
            'a simulate response did not carry its own final observation',
            'tick 90 in the same response',
            `${simulatedA.tick} / ${simulatedA.observation.tick}`,
          ),
        );
      }
      if (!createDefaultRegistry().command('world.simulate')) {
        issues.push(
          issue(
            'the multi-instance capability does not declare world.simulate',
            'world.simulate registered',
            'absent',
          ),
        );
      }

      /*
       * Camera-faithful replay. Movement is camera-relative, so a recording
       * that drops camera yaw replays a different run with matching input bytes.
       */
      const live = new WorldRuntime({ registry, project, world });
      const recorder = new WorldReplayRecorder(live);
      const liveTicks: unknown[] = [];
      for (let tick = 0; tick < 90; tick += 1) {
        live.setCameraYaw(tick < 45 ? 0 : Math.PI / 2);
        live.injectLocalIntent(0, { ...neutralIntent(), moveY: 1 });
        recorder.step();
        liveTicks.push(live.instance(live.instanceIds[0]!)!.lastRecord);
      }
      const recording = recorder.finish();
      if (recording.controls.cameraYaw.length < 2) {
        issues.push(
          issue(
            'a recording with a camera turn captured no yaw change',
            'at least two camera keyframes',
            String(recording.controls.cameraYaw.length),
          ),
        );
      }
      const playback = recordWorldTrace(
        createReplayRuntime({ registry, project, world, replay: recording }),
        90,
      );
      const replayedTicks = playback.instances[playback.instanceOrder[0]!]!.ticks;
      if (JSON.stringify(replayedTicks) !== JSON.stringify(liveTicks)) {
        issues.push(
          issue(
            'a replayed run diverged from the run that recorded it',
            'byte-identical tick records',
            'they differ',
          ),
        );
      }

      // The fixture and the demo project must not drift: the project is what a
      // human opens, the fixture is what the manifest and the tests name.
      const fixtureJson = JSON.stringify(world);
      if (JSON.stringify(project.world ?? null) !== fixtureJson) {
        issues.push(
          issue(
            'projects/demo-character/project.json does not carry the acceptance world',
            'the project world to equal the fixture',
            'they differ',
          ),
        );
      }

      // Legacy: a project with no explicit world still runs, as one instance.
      const { world: _explicit, ...legacyProject } = project;
      const legacy = worldOf(legacyProject);
      if (legacy.instances.length !== 1) {
        issues.push(
          issue(
            'a legacy project synthesized more than one instance',
            'exactly one synthesized instance',
            String(legacy.instances.length),
          ),
        );
      }
      if (legacy.instances[0]?.source.characterId !== legacyProject.activeCharacterId) {
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
