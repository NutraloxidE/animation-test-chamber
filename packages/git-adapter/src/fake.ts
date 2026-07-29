import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { flattenValues } from '@atc/runtime-core';
import {
  GitConflictError,
  ProtectedBranchError,
  type CommitRequest,
  type CommitResult,
  type FieldConflict,
  type GitAdapter,
  type HeadInfo,
  type PullRequestRequest,
  type PullRequestResult,
} from './types.ts';

interface BranchState {
  sha: string;
  files: Map<string, string>;
}

/**
 * In-memory Git implementation with an optional on-disk mirror.
 *
 * This is what makes the full commit loop work on a fresh clone with no GitHub
 * App configured: identical semantics to the real adapter, including base-SHA
 * conflict detection and the protected-branch refusal, so the integration tests
 * exercise real behaviour rather than a stub that always says yes.
 */
export class FakeGitAdapter implements GitAdapter {
  readonly kind = 'fake' as const;

  private readonly branches = new Map<string, BranchState>();
  private pullRequestCounter = 0;
  private readonly pullRequests: (PullRequestRequest & { number: number })[] = [];

  constructor(
    readonly protectedBranch = 'main',
    /** When set, commits are mirrored here so a human can inspect them. */
    private readonly mirrorDirectory: string | null = null,
    seedFiles: Record<string, string> = {},
  ) {
    this.branches.set(protectedBranch, {
      sha: hashOf(JSON.stringify(seedFiles)),
      files: new Map(Object.entries(seedFiles)),
    });
  }

  async getHead(branch: string): Promise<HeadInfo> {
    const state = this.branches.get(branch);
    if (state) return { sha: state.sha, exists: true };
    // An unborn session branch inherits the protected branch's head, which is
    // the SHA a client should send as its base for the first commit.
    const root = this.branches.get(this.protectedBranch);
    return { sha: root?.sha ?? '', exists: false };
  }

  async readFile(branch: string, path: string): Promise<string | null> {
    const state = this.branches.get(branch) ?? this.branches.get(this.protectedBranch);
    return state?.files.get(path) ?? null;
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
        this.conflictsFor(request),
      );
    }

    const parent =
      this.branches.get(request.branch) ?? this.branches.get(this.protectedBranch);
    const files = new Map(parent?.files ?? []);
    for (const file of request.files) files.set(file.path, file.content);

    const sha = hashOf(
      `${request.baseSha}|${request.message}|${request.files.map((f) => `${f.path}:${f.content}`).join('|')}`,
    );

    const createdBranch = !this.branches.has(request.branch);
    this.branches.set(request.branch, { sha, files });

    if (this.mirrorDirectory) {
      for (const file of request.files) {
        const target = resolve(join(this.mirrorDirectory, request.branch, file.path));
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, file.content, 'utf8');
      }
      const logPath = resolve(join(this.mirrorDirectory, request.branch, 'COMMIT_LOG.txt'));
      const previous = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
      writeFileSync(logPath, `${previous}${sha} ${request.message}\n${request.body}\n\n`, 'utf8');
    }

    return { sha, branch: request.branch, createdBranch };
  }

  /**
   * Converts a whole-file clash into per-field conflicts so the UI can ask
   * "keep yours or theirs" one value at a time instead of on the whole project.
   */
  private conflictsFor(request: CommitRequest): FieldConflict[] {
    const conflicts: FieldConflict[] = [];
    const branchState = this.branches.get(request.branch);
    if (!branchState) return conflicts;

    for (const file of request.files) {
      const remoteRaw = branchState.files.get(file.path);
      if (!remoteRaw) continue;
      let ours: unknown;
      let theirs: unknown;
      try {
        ours = JSON.parse(file.content);
        theirs = JSON.parse(remoteRaw);
      } catch {
        continue;
      }
      const oursFlat = flattenValues(ours);
      const theirsFlat = flattenValues(theirs);
      for (const [path, value] of oursFlat) {
        const remoteValue = theirsFlat.get(path);
        if (remoteValue !== undefined && !Object.is(value, remoteValue)) {
          conflicts.push({ path, base: remoteValue, ours: value, theirs: remoteValue });
        }
      }
    }
    return conflicts;
  }

  async createPullRequest(request: PullRequestRequest): Promise<PullRequestResult> {
    if (!this.branches.has(request.branch)) {
      throw new Error(`cannot open a pull request for unknown branch "${request.branch}"`);
    }
    this.pullRequestCounter += 1;
    this.pullRequests.push({ ...request, number: this.pullRequestCounter });
    return {
      number: this.pullRequestCounter,
      url: `fake-git://pull/${this.pullRequestCounter}`,
    };
  }

  /** Test/diagnostic helpers. */
  listBranches(): string[] {
    return [...this.branches.keys()];
  }

  listPullRequests(): (PullRequestRequest & { number: number })[] {
    return [...this.pullRequests];
  }

  /** Simulates someone else pushing, for conflict tests. */
  forcePush(branch: string, files: Record<string, string>): string {
    const existing = this.branches.get(branch);
    const merged = new Map(existing?.files ?? []);
    for (const [path, content] of Object.entries(files)) merged.set(path, content);
    const sha = hashOf(`force|${branch}|${JSON.stringify(files)}|${Date.now()}`);
    this.branches.set(branch, { sha, files: merged });
    return sha;
  }
}

function hashOf(input: string): string {
  return createHash('sha1').update(input).digest('hex');
}
