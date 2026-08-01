import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AnimationAsset, AnimationAssetType, ProjectDefinition, ResolvedProject } from '@atc/schema';
import { assetFilePath, validateProject, validateProjectReferences } from '@atc/schema';
import {
  AnimationAssetRegistry,
  resolveCharacterAnimation,
  type StoredAsset,
} from '@atc/animation-asset-runtime';
import {
  FakeGitAdapter,
  GitHubAppAdapter,
  readGitHubConfigFromEnv,
  type GitAdapter,
} from '@atc/git-adapter';
import { createAiProvider, type AiProvider } from '@atc/ai-adapter';
import { createWorkerClient, type AnimationWorkerClient } from '@atc/acquisition-core';

/**
 * Walks up from this file to the workspace root, so the server finds canonical
 * data whether it was started from the repo root or from apps/api.
 */
function findRepoRoot(start: string): string {
  let current = start;
  for (let depth = 0; depth < 10; depth += 1) {
    if (existsSync(resolve(current, 'pnpm-workspace.yaml'))) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return process.cwd();
}

export const REPO_ROOT = findRepoRoot(dirname(fileURLToPath(import.meta.url)));
export const PROJECT_PATH = 'projects/demo-character/project.json';
export const ASSET_ROOT = 'assets/animation';

const DIRECTORY_BY_TYPE: Record<string, AnimationAssetType> = {
  behaviors: 'animation-behavior',
  'motion-sets': 'animation-motion-set',
  clips: 'animation-clip',
  rigs: 'humanoid-rig',
  tuning: 'animation-tuning',
};

/**
 * Loads every published asset version from disk, freshly, on each call.
 *
 * Not cached deliberately: the transaction endpoints write new versions into
 * this directory, and a cached registry would answer the next request with the
 * repository as it was before the write it just accepted.
 */
export function loadStoredAssets(root: string = REPO_ROOT): StoredAsset[] {
  const assets: StoredAsset[] = [];
  for (const directory of Object.keys(DIRECTORY_BY_TYPE).sort()) {
    const base = resolve(root, ASSET_ROOT, directory);
    if (!existsSync(base)) continue;
    for (const assetId of readdirSync(base).sort()) {
      for (const file of readdirSync(resolve(base, assetId)).sort()) {
        if (!file.endsWith('.json')) continue;
        const assetType = DIRECTORY_BY_TYPE[directory]!;
        const version = file.replace(/\.json$/, '');
        const relativePath = `${ASSET_ROOT}/${directory}/${assetId}/${file}`;
        const document = JSON.parse(readFileSync(resolve(base, assetId, file), 'utf8')) as AnimationAsset;
        const expectedPath = assetFilePath(document.metadata.assetType, document.metadata.id, document.metadata.version);
        if (expectedPath !== relativePath) {
          throw new Error(
            `asset-path-mismatch: ${relativePath} contains ${document.metadata.assetType}:` +
              `${document.metadata.id}@${document.metadata.version}, which belongs at ${expectedPath}`,
          );
        }
        assets.push({ assetType, id: assetId, version, document });
      }
    }
  }
  return assets;
}

export function loadAssetRegistry(root: string = REPO_ROOT): AnimationAssetRegistry {
  return new AnimationAssetRegistry(loadStoredAssets(root));
}

/**
 * The project as one character sees it. Every endpoint that wants a graph or a
 * clip list goes through here, so there is one place that decides what
 * "resolved" means on the server.
 */
export function loadResolvedProject(options: { characterId?: string } = {}): ResolvedProject {
  const result = resolveCharacterAnimation({
    registry: loadAssetRegistry(),
    project: loadProject(),
    ...(options.characterId ? { characterId: options.characterId } : {}),
  });
  const errors = result.issues.filter((issue) => issue.severity === 'error');
  if (errors.length > 0) {
    throw new Error(
      `cannot resolve animation assets:\n  ${errors.map((issue) => `[${issue.code}] ${issue.message}`).join('\n  ')}`,
    );
  }
  return result.project;
}

export interface ServerContext {
  git: GitAdapter;
  ai: AiProvider;
  worker: AnimationWorkerClient;
  /** True when GitHub App credentials were found; drives the UI badge. */
  gitConfigured: boolean;
  aiConfigured: boolean;
}

export function loadProject(): ProjectDefinition {
  const path = resolve(REPO_ROOT, PROJECT_PATH);
  if (!existsSync(path)) {
    throw new Error(
      `canonical project not found at ${path}. Run \`pnpm seed:demo\` to create the demo project.`,
    );
  }
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as ProjectDefinition;

  const schemaResult = validateProject(parsed);
  const referenceResult = validateProjectReferences(parsed);
  if (!schemaResult.valid || !referenceResult.valid) {
    const issues = [...schemaResult.issues, ...referenceResult.issues]
      .map((issue) => `${issue.path}: ${issue.message}`)
      .join('\n  ');
    throw new Error(`canonical project failed validation:\n  ${issues}`);
  }

  return parsed;
}

/**
 * Writes the canonical project back to disk. Only called after the Git adapter
 * has accepted the commit, so disk never runs ahead of the recorded history.
 */
export function saveProject(project: ProjectDefinition): void {
  writeFileSync(
    resolve(REPO_ROOT, PROJECT_PATH),
    `${JSON.stringify(project, null, 2)}\n`,
    'utf8',
  );
}

/**
 * The repository-transaction write-lockout rule, pulled out as a pure
 * function so it can be unit-tested without booting the real server (which
 * binds a live port as a side effect of import). Read access always stays up
 * — the library and chamber can still open — only a write is refused while a
 * prior transaction remains unresolved.
 */
export function isWriteBlockedByReadOnly(method: string, repositoryReadOnly: boolean): boolean {
  return repositoryReadOnly && method !== 'GET';
}

export function createContext(env: NodeJS.ProcessEnv = process.env): ServerContext {
  const githubConfig = env.GIT_ADAPTER === 'github' ? readGitHubConfigFromEnv(env) : null;

  const git: GitAdapter = githubConfig
    ? new GitHubAppAdapter(githubConfig)
    : new FakeGitAdapter(
        env.GITHUB_PROTECTED_BRANCH || 'main',
        resolve(REPO_ROOT, '.chamber-fake-git'),
        { [PROJECT_PATH]: readFileSync(resolve(REPO_ROOT, PROJECT_PATH), 'utf8') },
      );

  const ai = createAiProvider(env);

  return {
    git,
    ai,
    worker: createWorkerClient(env),
    gitConfigured: githubConfig !== null,
    aiConfigured: ai.requiresApiKey,
  };
}
