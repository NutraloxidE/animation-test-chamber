import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ProjectDefinition, ResolvedProject } from '@atc/schema';
import {
  AnimationAssetRegistry,
  resolveCharacterAnimation,
  type StoredAsset,
} from '@atc/animation-asset-runtime';
import { readdirSync } from 'node:fs';

const REPO_ROOT = resolve(__dirname, '../..');
const PROJECT_PATH = resolve(REPO_ROOT, 'projects/demo-character/project.json');
const ASSET_ROOT = resolve(REPO_ROOT, 'assets/animation');

const DIRECTORY_BY_TYPE = {
  behaviors: 'animation-behavior',
  'motion-sets': 'animation-motion-set',
  clips: 'animation-clip',
  rigs: 'humanoid-rig',
  tuning: 'animation-tuning',
} as const;

/**
 * Loads the canonical demo project. Tests read the real file rather than a
 * hand-built fixture so a schema or data change cannot pass the suite while
 * breaking the thing the app actually loads.
 */
export function loadDemoProject(): ProjectDefinition {
  return JSON.parse(readFileSync(PROJECT_PATH, 'utf8')) as ProjectDefinition;
}

/** Every published asset version, read from the repository for the same reason. */
export function loadDemoAssets(): StoredAsset[] {
  const assets: StoredAsset[] = [];
  for (const [directory, assetType] of Object.entries(DIRECTORY_BY_TYPE)) {
    const base = resolve(ASSET_ROOT, directory);
    for (const assetId of readdirSync(base).sort()) {
      for (const file of readdirSync(resolve(base, assetId)).sort()) {
        if (!file.endsWith('.json')) continue;
        assets.push({
          assetType,
          id: assetId,
          version: file.replace(/\.json$/, ''),
          document: JSON.parse(readFileSync(resolve(base, assetId, file), 'utf8')),
        });
      }
    }
  }
  return assets;
}

export function demoRegistry(): AnimationAssetRegistry {
  return new AnimationAssetRegistry(loadDemoAssets());
}

/**
 * The demo project resolved for one character — the shape the runtime, the
 * panels and the exporter all consume. Tests that used to load `project.json`
 * and read `.graph` now come here instead.
 */
export function loadResolvedDemoProject(characterId?: string): ResolvedProject {
  const result = resolveCharacterAnimation({
    registry: demoRegistry(),
    project: loadDemoProject(),
    ...(characterId ? { characterId } : {}),
  });
  const errors = result.issues.filter((issue) => issue.severity === 'error');
  if (errors.length > 0) {
    throw new Error(
      `demo project does not resolve: ${errors.map((issue) => issue.message).join('; ')}`,
    );
  }
  return result.project;
}

/** Deep clone, so a test mutating a document cannot leak into the next test. */
export function cloneProject<T>(project: T): T {
  return structuredClone(project);
}
