/**
 * Prefab harness stages (§19).
 *
 * Each stage answers one question that, left unasked, would let the repository
 * ship a Prefab graph that only appears to work: documents that validate,
 * references that resolve, hashes that match, an index that is not stale, a
 * migration that reproduces itself, and — the load-bearing one — five migrated
 * Prefabs whose *effective* composition still equals the five Characters they
 * replaced.
 */
import { computeContentHash } from '@atc/animation-asset-runtime';
import {
  describePrefabUsage,
  resolveGameObjectPrefab,
  resolvedComponents,
} from '@atc/prefab-runtime';
import { componentOfType, isCharacterComposition, prefabAssetFilePath } from '@atc/schema';
import { loadCanonicalProject } from './animation-assets.ts';
import { buildPrefabIndexFile } from './generate-prefab-asset-index.ts';
import { printStage, readRepoFile, stage, type StageIssue, type StageResult } from './lib.ts';
import { runMigration } from './migrate-character-prefabs.ts';
import { PREFAB_LIBRARY_INDEX_PATH, loadPrefabRegistry, loadStoredPrefabs } from './prefabs.ts';

/** Every Prefab document validates, seals and sits where its metadata says. */
export function prefabIntegrityStage(): StageResult {
  return stage(
    'prefab assets validate and resolve',
    {
      reproduce: 'npx tsx harness/check-prefabs.ts',
      suggestion:
        'a hash mismatch means a published Prefab version was edited in place — publish a new version instead',
    },
    () => {
      const registry = loadPrefabRegistry();
      const issues: StageIssue[] = [];
      for (const stored of loadStoredPrefabs()) {
        const expectedPath = prefabAssetFilePath(stored.id, stored.version);
        const reference = registry.referenceTo(stored.id, stored.version);
        const report = registry.validate(reference);
        for (const issue of report.issues.filter((entry) => entry.severity === 'error')) {
          issues.push({
            files: [expectedPath],
            expected: 'a Prefab that validates against its own schema and neighbours',
            actual: issue.message,
            message: `${issue.code}: ${issue.message}`,
          });
        }
        if (computeContentHash(stored.document) !== stored.document.metadata.contentHash) {
          issues.push({
            files: [expectedPath],
            expected: 'the stored contentHash to match the document',
            actual: 'it does not',
            message: `published-prefab-modified: ${stored.id}@${stored.version}`,
          });
        }
      }
      return {
        ok: issues.length === 0,
        issues,
        output: `${registry.size} Prefab version(s) checked`,
      };
    },
  );
}

/** Every Prefab resolves — variant chain, patches, nesting and all. */
export function prefabResolutionStage(): StageResult {
  return stage(
    'every prefab resolves to a composition',
    {
      reproduce: 'npx tsx harness/check-prefabs.ts',
      suggestion:
        'an invalid-override-target means a variant patches a node or component its parent no longer has',
    },
    () => {
      const registry = loadPrefabRegistry();
      const issues: StageIssue[] = [];
      const notes: string[] = [];
      for (const stored of registry.all()) {
        const reference = registry.referenceTo(stored.id, stored.version);
        const resolution = resolveGameObjectPrefab(registry, reference);
        for (const issue of resolution.issues.filter((entry) => entry.severity === 'error')) {
          issues.push({
            files: [prefabAssetFilePath(stored.id, stored.version)],
            expected: `${stored.id}@${stored.version} to resolve`,
            actual: issue.message,
            message: `${issue.code}: ${issue.message}`,
          });
        }
        const components = resolvedComponents(resolution.prefab.root);
        notes.push(`${stored.id}: ${components.length} component(s)`);
      }
      return { ok: issues.length === 0, issues, output: notes.join(' | ') };
    },
  );
}

/**
 * The migrated Prefabs still *are* the five Characters.
 *
 * The comparison is against `project.characters`, field by field, through the
 * resolver — not against a recorded expectation. A golden file would pass just
 * as well if both sides drifted together.
 */
export function prefabEquivalenceStage(): StageResult {
  return stage(
    'migrated prefabs preserve the pre-migration characters',
    {
      reproduce: 'npx tsx harness/check-prefabs.ts',
      suggestion:
        'a difference here is never cosmetic: find which authored value the migration stopped carrying across',
    },
    () => {
      const registry = loadPrefabRegistry();
      const project = loadCanonicalProject();
      const { identityMap } = runMigration();
      const issues: StageIssue[] = [];

      for (const character of project.characters) {
        const reference = identityMap[character.id];
        if (!reference) {
          issues.push({
            files: ['harness/migrate-character-prefabs.ts'],
            expected: `a Prefab for character "${character.id}"`,
            actual: 'none was produced',
            message: `character "${character.id}" has no migrated Prefab`,
          });
          continue;
        }
        const resolution = resolveGameObjectPrefab(registry, reference);
        const components = resolvedComponents(resolution.prefab.root);
        const compare = (field: string, expected: unknown, actual: unknown): void => {
          if (JSON.stringify(expected) === JSON.stringify(actual)) return;
          issues.push({
            files: [prefabAssetFilePath(reference.assetId, reference.version)],
            expected: JSON.stringify(expected).slice(0, 200),
            actual: JSON.stringify(actual).slice(0, 200),
            message: `${character.id}: ${field} differs after migration`,
          });
        };

        const model = componentOfType(components, 'model-renderer');
        const animator = componentOfType(components, 'animator');
        const capsule = componentOfType(components, 'capsule-collider');
        const sockets = componentOfType(components, 'equipment-sockets');

        const expectedModel =
          character.model.kind === 'procedural-humanoid'
            ? { kind: 'procedural-humanoid', presetId: character.model.presetId }
            : {
                kind: 'repository-model',
                assetPath: character.model.assetPath,
                scale: character.model.scale,
                rotationYRad: character.model.rotationYRad,
              };
        compare('model binding', expectedModel, model?.model);
        compare('animation assignment', character.animation, animator?.assignment);
        compare('capsule radius', character.capsuleRadius, capsule?.radius);
        compare('capsule height', character.capsuleHeight, capsule?.height);

        if (character.model.kind === 'repository-model' && character.model.rightHandBone) {
          const grips = character.model.weaponGrips ?? {};
          for (const [mode, grip] of Object.entries(grips)) {
            const socket = sockets?.sockets.find((entry) => entry.socketId === `right-hand-${mode}`);
            compare(`socket "${mode}" bone`, character.model.rightHandBone, socket?.boneName);
            compare(`socket "${mode}" position`, grip.position, socket?.localPosition);
            compare(`socket "${mode}" rotation`, grip.rotation, socket?.localRotation);
          }
        }

        if (!isCharacterComposition(components)) {
          issues.push({
            files: [prefabAssetFilePath(reference.assetId, reference.version)],
            expected: 'Animator + CharacterMotor',
            actual: components.map((entry) => entry.componentType).join(', '),
            message: `${character.id}: migrated Prefab is not a character composition`,
          });
        }
      }

      return {
        ok: issues.length === 0,
        issues,
        output: `${project.characters.length} character(s) equivalent after migration`,
      };
    },
  );
}

/** The same input must always produce the same Prefabs, or every hash moves. */
export function prefabMigrationDeterminismStage(): StageResult {
  return stage(
    'prefab migration is deterministic',
    {
      reproduce: 'npx tsx harness/migrate-character-prefabs.ts --check',
      suggestion:
        'remove the wall-clock time or unordered iteration that made the output vary between runs',
    },
    () => {
      const first = runMigration();
      const second = runMigration();
      const same =
        JSON.stringify(first.prefabs) === JSON.stringify(second.prefabs) &&
        first.projectContent === second.projectContent;
      const onDisk = first.prefabs.every(
        (prefab) => readRepoFile(prefab.path) === prefab.content,
      );
      const issues: StageIssue[] = [];
      if (!same) {
        issues.push({
          files: ['harness/migrate-character-prefabs.ts'],
          expected: 'two runs to produce identical Prefabs',
          actual: 'the two runs differ',
          message: 'the Prefab migration is not reproducible',
        });
      }
      if (!onDisk) {
        issues.push({
          files: ['assets/prefabs'],
          expected: 'the committed Prefabs to match a fresh migration',
          actual: 'they do not',
          message: 'run `pnpm prefabs:migrate` and commit the result',
        });
      }
      return {
        ok: issues.length === 0,
        issues,
        output: `${first.prefabs.length} Prefab(s) produced identically twice`,
      };
    },
  );
}

/** A stale index would render a library that quietly disagrees with the repository. */
export function prefabLibraryIndexStage(): StageResult {
  return stage(
    'generated prefab index is current',
    {
      reproduce: 'pnpm assets:prefabs:index',
      suggestion: 'run `pnpm assets:prefabs:index` and commit the result',
    },
    () => {
      const onDisk = readRepoFile(PREFAB_LIBRARY_INDEX_PATH);
      const expected = buildPrefabIndexFile();
      if (onDisk === expected) {
        return {
          ok: true,
          issues: [],
          output: `${loadPrefabRegistry().size} Prefab version(s) indexed`,
        };
      }
      return {
        ok: false,
        issues: [
          {
            files: [PREFAB_LIBRARY_INDEX_PATH],
            expected: 'the index to match assets/prefabs/**',
            actual: onDisk === null ? 'the index is missing' : 'the index is stale',
            message: 'the generated Prefab index has drifted from the Prefabs on disk',
          },
        ],
      };
    },
  );
}

/**
 * The usage graph agrees with the documents it describes.
 *
 * One graph feeds the Inspector, the delete policy, the blast radius and this
 * stage (§8.3), so checking it here checks all four at once.
 */
export function prefabUsageStage(): StageResult {
  return stage(
    'prefab usage graph names exact holders',
    {
      reproduce: 'npx tsx harness/check-prefabs.ts',
      suggestion: 'a missing holder means a Scene instance or nested reference the graph cannot see',
    },
    () => {
      const registry = loadPrefabRegistry();
      const project = loadCanonicalProject();
      const usage = describePrefabUsage({ prefabRegistry: registry, project });
      const issues: StageIssue[] = [];

      const placed = new Map<string, number>();
      for (const scene of project.scenes) {
        for (const gameObject of scene.gameObjects ?? []) {
          const key = `${gameObject.prefab.assetId}@${gameObject.prefab.version}`;
          placed.set(key, (placed.get(key) ?? 0) + 1);
        }
      }
      for (const [key, count] of placed) {
        const entry = usage.find(
          (candidate) => `${candidate.prefab.assetId}@${candidate.prefab.version}` === key,
        );
        if (!entry || entry.sceneInstances.length !== count) {
          issues.push({
            files: ['packages/prefab-runtime/src/usage.ts'],
            expected: `${count} Scene instance(s) of ${key}`,
            actual: `${entry?.sceneInstances.length ?? 0}`,
            message: `usage graph miscounts Scene instances of ${key}`,
          });
        }
      }

      for (const entry of usage) {
        if (!entry.abstract) continue;
        if (entry.sceneInstances.length > 0) {
          issues.push({
            files: ['projects/demo-character/project.json'],
            expected: `abstract Prefab "${entry.prefab.assetId}" to be unplaceable`,
            actual: `${entry.sceneInstances.length} Scene instance(s)`,
            message: `abstract-prefab-placed: ${entry.prefab.assetId}`,
          });
        }
      }

      return {
        ok: issues.length === 0,
        issues,
        output: `${usage.length} Prefab version(s) in the usage graph`,
      };
    },
  );
}

export function prefabStages(): StageResult[] {
  return [
    prefabIntegrityStage(),
    prefabResolutionStage(),
    prefabEquivalenceStage(),
    prefabMigrationDeterminismStage(),
    prefabLibraryIndexStage(),
    prefabUsageStage(),
  ];
}

function main(): void {
  const results = prefabStages();
  for (const result of results) printStage(result);
  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} prefab checks passed`);
  process.exit(failed.length > 0 ? 1 : 0);
}

if (process.argv[1]?.includes('check-prefabs')) main();
