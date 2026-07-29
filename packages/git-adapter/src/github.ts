import { Octokit } from 'octokit';
import { createAppAuth } from '@octokit/auth-app';
import {
  GitConflictError,
  ProtectedBranchError,
  type CommitRequest,
  type CommitResult,
  type GitAdapter,
  type HeadInfo,
  type PullRequestRequest,
  type PullRequestResult,
} from './types.ts';

export interface GitHubAppConfig {
  appId: string;
  privateKey: string;
  installationId: string;
  owner: string;
  repo: string;
  protectedBranch: string;
}

/**
 * Reads GitHub App configuration from the environment. Returns null when any
 * piece is missing, which is the normal case — the app must boot and stay fully
 * usable with the fake adapter (PLAN 22.1).
 */
export function readGitHubConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): GitHubAppConfig | null {
  const appId = env.GITHUB_APP_ID;
  const privateKey = env.GITHUB_APP_PRIVATE_KEY;
  const installationId = env.GITHUB_APP_INSTALLATION_ID;
  const owner = env.GITHUB_REPO_OWNER;
  const repo = env.GITHUB_REPO_NAME;

  if (!appId || !privateKey || !installationId || !owner || !repo) return null;

  return {
    appId,
    // Private keys are usually pasted into .env with escaped newlines.
    privateKey: privateKey.replace(/\\n/g, '\n'),
    installationId,
    owner,
    repo,
    protectedBranch: env.GITHUB_PROTECTED_BRANCH || 'main',
  };
}

/**
 * Commits through a GitHub App installation token.
 *
 * The token is minted here, on the API server, and never leaves it — the
 * browser holds no credential of any kind (PLAN 9.3).
 */
export class GitHubAppAdapter implements GitAdapter {
  readonly kind = 'github' as const;
  readonly protectedBranch: string;

  private readonly octokit: Octokit;

  constructor(private readonly config: GitHubAppConfig) {
    this.protectedBranch = config.protectedBranch;
    this.octokit = new Octokit({
      authStrategy: createAppAuth,
      auth: {
        appId: config.appId,
        privateKey: config.privateKey,
        installationId: config.installationId,
      },
    });
  }

  private get repoParams(): { owner: string; repo: string } {
    return { owner: this.config.owner, repo: this.config.repo };
  }

  async getHead(branch: string): Promise<HeadInfo> {
    try {
      const response = await this.octokit.rest.repos.getBranch({
        ...this.repoParams,
        branch,
      });
      return { sha: response.data.commit.sha, exists: true };
    } catch (error) {
      if (isNotFound(error)) {
        const base = await this.octokit.rest.repos.getBranch({
          ...this.repoParams,
          branch: this.protectedBranch,
        });
        return { sha: base.data.commit.sha, exists: false };
      }
      throw error;
    }
  }

  async readFile(branch: string, path: string): Promise<string | null> {
    try {
      const response = await this.octokit.rest.repos.getContent({
        ...this.repoParams,
        path,
        ref: branch,
      });
      const data = response.data as { content?: string; encoding?: string };
      if (!data.content) return null;
      return Buffer.from(data.content, (data.encoding as BufferEncoding) ?? 'base64').toString(
        'utf8',
      );
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async commit(request: CommitRequest): Promise<CommitResult> {
    if (request.branch === this.protectedBranch) {
      throw new ProtectedBranchError(request.branch);
    }

    const head = await this.getHead(request.branch);
    if (head.exists && head.sha !== request.baseSha) {
      throw new GitConflictError(
        `branch "${request.branch}" moved from ${request.baseSha} to ${head.sha}`,
        request.baseSha,
        head.sha,
      );
    }

    const createdBranch = !head.exists;
    if (createdBranch) {
      await this.octokit.rest.git.createRef({
        ...this.repoParams,
        ref: `refs/heads/${request.branch}`,
        sha: head.sha,
      });
    }

    // Build a tree from blobs so one commit carries every changed file.
    const blobs = await Promise.all(
      request.files.map(async (file) => {
        const blob = await this.octokit.rest.git.createBlob({
          ...this.repoParams,
          content: file.content,
          encoding: 'utf-8',
        });
        return { path: file.path, sha: blob.data.sha };
      }),
    );

    const baseCommit = await this.octokit.rest.git.getCommit({
      ...this.repoParams,
      commit_sha: head.sha,
    });

    const tree = await this.octokit.rest.git.createTree({
      ...this.repoParams,
      base_tree: baseCommit.data.tree.sha,
      tree: blobs.map((blob) => ({
        path: blob.path,
        mode: '100644' as const,
        type: 'blob' as const,
        sha: blob.sha,
      })),
    });

    const commit = await this.octokit.rest.git.createCommit({
      ...this.repoParams,
      message: `${request.message}\n\n${request.body}`,
      tree: tree.data.sha,
      parents: [head.sha],
    });

    await this.octokit.rest.git.updateRef({
      ...this.repoParams,
      ref: `heads/${request.branch}`,
      sha: commit.data.sha,
      // Never clobber a branch that moved underneath us.
      force: false,
    });

    return { sha: commit.data.sha, branch: request.branch, createdBranch };
  }

  async createPullRequest(request: PullRequestRequest): Promise<PullRequestResult> {
    const response = await this.octokit.rest.pulls.create({
      ...this.repoParams,
      head: request.branch,
      base: request.baseBranch,
      title: request.title,
      body: request.body,
    });
    return { number: response.data.number, url: response.data.html_url };
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { status?: number }).status === 404;
}
