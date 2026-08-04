/**
 * `pnpm harness:scenes` — the scene contract stage.
 *
 * Checks the things a unit test would only check for the fixture it happens to
 * load: that the shipped scene validates, that two entities on one character
 * genuinely share one animation bundle while sharing no mutable state, that a
 * scene is deterministic across two runs, that observation paths name entities
 * rather than array positions, and that the World-to-Scene migration is
 * idempotent against the committed data.
 *
 * It runs before the test suites in `harness:one-shot` for the same reason the
 * asset stages do: a broken scene contract makes every later failure a symptom.
 */
import {
  loadProjectDocument,
  validateAgainst,
  validateProjectReferences,
  validateSceneReferences,
  type SceneDefinition,
} from '@atc/schema';
import {
  SceneRuntime,
  animationResolutionKey,
  flattenObservations,
  hashSceneTrace,
  observeScene,
  recordSceneTrace,
  resolveScene,
} from '@atc/scene-runtime';
import { neutralIntent } from '@atc/character-control-runtime';
import { loadAssetRegistry, loadCanonicalProject } from './animation-assets.ts';
import { printStage, stage, type StageIssue, type StageResult } from './lib.ts';

const PROJECT_PATH = 'projects/demo-character/project.json';

function issue(message: string, expected: string, actual: string): StageIssue {
  return { files: [PROJECT_PATH], expected, actual, message };
}

export function sceneContractStage(): StageResult {
  return stage(
    'scene contract',
    {
      reproduce: 'pnpm harness:scenes',
      blocksCommit: true,
      suggestion:
        'a scene failure is a contract failure: check entity identity, shared resolution and tick order before touching the fixture',
    },
    () => {
      const issues: StageIssue[] = [];
      const project = loadCanonicalProject();
      const registry = loadAssetRegistry();

      const references = validateProjectReferences(project);
      for (const problem of references.issues) {
        issues.push(
          issue(`references ${problem.path}: ${problem.message}`, 'resolvable references', problem.message),
        );
      }

      const characterIds = new Set(project.characters.map((entry) => entry.id));
      for (const scene of project.scenes) {
        const schema = validateAgainst('SceneDefinition', scene);
        for (const problem of schema.issues) {
          issues.push(issue(`scene ${scene.id} ${problem.path}: ${problem.message}`, 'a valid scene', problem.message));
        }
        for (const problem of validateSceneReferences(scene, characterIds).issues) {
          issues.push(issue(`scene ${scene.id} ${problem.path}: ${problem.message}`, 'resolvable references', problem.message));
        }
      }

      /*
       * Migration idempotence, checked against the committed document rather
       * than a constructed one. A migration that is only usually idempotent
       * produces a repository whose diff depends on how many times somebody
       * opened it, and the second change looks exactly like an edit.
       */
      const reloaded = loadProjectDocument(project);
      if (reloaded.migrated) {
        issues.push(
          issue(
            'the committed project still reads as a legacy World document',
            'a current Scene project',
            'migration reported work to do',
          ),
        );
      }
      if (JSON.stringify(reloaded.project) !== JSON.stringify(project)) {
        issues.push(
          issue('loading the committed project changed it', 'an unchanged document', 'it differs'),
        );
      }

      const scene = project.scenes[0];
      if (!scene) {
        // Not a failure: a character-only repository is a legitimate shape, and
        // the checks below have nothing to say about it.
        return { ok: issues.length === 0, issues };
      }

      issues.push(...runtimeIssues(scene, project, registry));
      return { ok: issues.length === 0, issues };
    },
  );
}

function runtimeIssues(
  scene: SceneDefinition,
  project: ReturnType<typeof loadCanonicalProject>,
  registry: ReturnType<typeof loadAssetRegistry>,
): StageIssue[] {
  const issues: StageIssue[] = [];
  const build = (): SceneRuntime => new SceneRuntime({ registry, project, scene });
  const runtime = build();

  // Shared definition, independent state — the whole contract in two checks.
  const [firstId, secondId] = runtime.entityIds;
  if (firstId && secondId) {
    const first = runtime.resolvedCharacter(firstId)!;
    const second = runtime.resolvedCharacter(secondId)!;
    if (first.definition.characterId === second.definition.characterId) {
      if (first.bundle !== second.bundle) {
        issues.push(
          issue(
            'two entities of one character resolved to different animation bundles',
            'one shared immutable bundle',
            'two bundles',
          ),
        );
      }
      if (first.resolved === second.resolved) {
        issues.push(
          issue(
            'two entities share one ResolvedProject wrapper',
            'a distinct wrapper per entity',
            'one shared wrapper',
          ),
        );
      }
      if (runtime.character(firstId)!.simulation === runtime.character(secondId)!.simulation) {
        issues.push(
          issue(
            'two entities share one simulation object',
            'independent mutable state per entity',
            'a shared Simulation',
          ),
        );
      }
    }
  }

  // Determinism: two independent runs from the same start state.
  const hashA = hashSceneTrace(recordSceneTrace(build(), 120));
  const hashB = hashSceneTrace(recordSceneTrace(build(), 120));
  if (hashA !== hashB) {
    issues.push(issue('repeated fixed-tick runs produced different scenes', hashA, hashB));
  }

  // Routing: an injected human frame must not reach a script-driven entity.
  const routed = build();
  for (let tick = 0; tick < 30; tick += 1) {
    routed.injectHumanIntent(0, { ...neutralIntent(), moveY: 1 });
    routed.step();
  }
  for (const id of routed.entityIds) {
    const definition = routed.resolvedCharacter(id)!.definition;
    if (definition.controller.kind !== 'human' && routed.character(id)!.lastIntent.moveY === 1) {
      issues.push(
        issue(
          `entity "${id}" received input bound to another entity`,
          'intent reaches only the bound entity',
          `moveY=1 on a ${definition.controller.kind} controller`,
        ),
      );
    }
  }

  // Observation paths must name entities, never array positions.
  for (const { path } of flattenObservations(observeScene(routed))) {
    if (/\/entities\/\d+\//.test(path)) {
      issues.push(issue(`observation path uses an array index: ${path}`, 'stable entity ids', path));
    }
  }

  /*
   * Rename-invariance rather than a substring scan: an asset id may
   * legitimately contain a character's name, so "the key does not mention the
   * character" is not a property the key can have. What it must have is that
   * renaming a character does not change it.
   */
  const resolution = resolveScene({ registry, project, scene });
  const firstResolved = resolution.characters[0];
  if (firstResolved) {
    const character = project.characters.find(
      (entry) => entry.id === firstResolved.definition.characterId,
    );
    if (character) {
      const renamed = { ...character, id: 'renamed-for-the-harness' };
      if (animationResolutionKey(renamed) !== animationResolutionKey(character)) {
        issues.push(
          issue(
            'renaming a character changed its animation resolution key',
            'a key built only from animation inputs',
            'the key moved',
          ),
        );
      }
    }
  }

  return issues;
}

if (process.argv[1]?.includes('check-scenes')) {
  const result = sceneContractStage();
  printStage(result);
  if (!result.ok) process.exit(1);
}
