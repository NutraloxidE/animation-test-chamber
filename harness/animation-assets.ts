/**
 * Node-side asset loading, shared by every harness stage and by the API server.
 *
 * The registry itself is deliberately filesystem-blind (PLAN 30), so exactly
 * one file in the repository is allowed to know that assets live in
 * `assets/animation/<kind>/<id>/<version>.json`. This is it.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type {
  AnimationAsset,
  AnimationAssetType,
  ProjectDefinition,
  ResolvedProject,
} from '@atc/schema';
import { assetFilePath } from '@atc/schema';
import {
  AnimationAssetRegistry,
  resolveCharacterAnimation,
  type StoredAsset,
} from '@atc/animation-asset-runtime';
import { REPO_ROOT } from './lib.ts';

export const ASSET_ROOT = 'assets/animation';
export const PROJECT_PATH = 'projects/demo-character/project.json';
export const LIBRARY_INDEX_PATH = 'generated/animation-assets/library-index.json';
export const LEGACY_PROJECT_FIXTURE =
  'tests/fixtures/animation-assets/legacy-demo-project.v1.json';

const DIRECTORY_BY_TYPE: Record<string, AnimationAssetType> = {
  behaviors: 'animation-behavior',
  'motion-sets': 'animation-motion-set',
  clips: 'animation-clip',
  rigs: 'humanoid-rig',
  tuning: 'animation-tuning',
};

/** Every published asset version on disk, in a stable order. */
export function loadStoredAssets(root: string = REPO_ROOT): StoredAsset[] {
  const assets: StoredAsset[] = [];
  for (const directory of Object.keys(DIRECTORY_BY_TYPE).sort()) {
    const base = resolve(root, ASSET_ROOT, directory);
    if (!existsSync(base)) continue;
    for (const assetId of readdirSync(base).sort()) {
      const versionDirectory = resolve(base, assetId);
      for (const file of readdirSync(versionDirectory).sort()) {
        if (!file.endsWith('.json')) continue;
        assets.push({
          assetType: DIRECTORY_BY_TYPE[directory]!,
          id: assetId,
          version: file.replace(/\.json$/, ''),
          document: JSON.parse(readFileSync(resolve(versionDirectory, file), 'utf8')) as AnimationAsset,
        });
      }
    }
  }
  return assets;
}

export function loadAssetRegistry(root: string = REPO_ROOT): AnimationAssetRegistry {
  return new AnimationAssetRegistry(loadStoredAssets(root));
}

export function loadCanonicalProject(root: string = REPO_ROOT): ProjectDefinition {
  return JSON.parse(
    readFileSync(resolve(root, PROJECT_PATH), 'utf8'),
  ) as ProjectDefinition;
}

export interface LoadResolvedOptions {
  characterId?: string;
  root?: string;
}

/**
 * The project as one character sees it. Throws on an unresolvable reference —
 * every caller here is about to run a simulation or an export, and doing either
 * against a half-resolved document is exactly what the hash check exists to
 * prevent.
 */
export function loadResolvedProject(options: LoadResolvedOptions = {}): ResolvedProject {
  const root = options.root ?? REPO_ROOT;
  const registry = loadAssetRegistry(root);
  const project = loadCanonicalProject(root);
  const result = resolveCharacterAnimation({
    registry,
    project,
    ...(options.characterId ? { characterId: options.characterId } : {}),
  });
  const errors = result.issues.filter((issue) => issue.severity === 'error');
  if (errors.length > 0) {
    throw new Error(
      `cannot resolve animation assets:\n${errors.map((issue) => `  - [${issue.code}] ${issue.message}`).join('\n')}`,
    );
  }
  return result.project;
}

/** Repository path a stored asset belongs at. */
export function pathForStoredAsset(asset: StoredAsset): string {
  return assetFilePath(asset.assetType, asset.id, asset.version);
}
