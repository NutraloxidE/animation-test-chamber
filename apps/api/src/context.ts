import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProjectDefinition } from '@atc/schema';
import { validateProject, validateProjectReferences } from '@atc/schema';
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
