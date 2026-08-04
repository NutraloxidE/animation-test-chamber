import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export interface StageIssue {
  /** Files the reader should look at. */
  files: string[];
  expected: string;
  actual: string;
  message: string;
}

export interface StageResult {
  name: string;
  ok: boolean;
  durationMs: number;
  issues: StageIssue[];
  /** Command a human can paste to reproduce this stage alone. */
  reproduce: string;
  /** Whether a failure here should stop a commit. */
  blocksCommit: boolean;
  suggestion: string;
  output?: string;
}

export function run(command: string, args: string[]): { code: number; output: string } {
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    env: { ...process.env, FORCE_COLOR: '0' },
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    code: result.status ?? 1,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim(),
  };
}

/**
 * Line endings, normalized to LF.
 *
 * Git checks these files out with CRLF on a Windows clone (`core.autocrlf`),
 * while `git show` hands back the LF blob. Every "did this file change?" check
 * in the harness compares those two, so without this the whole repository looks
 * modified in place on Windows and every real finding is buried.
 */
function normalizeEol(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

export function readRepoFile(relativePath: string): string | null {
  const full = resolve(REPO_ROOT, relativePath);
  return existsSync(full) ? normalizeEol(readFileSync(full, 'utf8')) : null;
}

export function writeRepoFile(relativePath: string, content: string): void {
  const full = resolve(REPO_ROOT, relativePath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, 'utf8');
}

/** Reads a path as it exists at a git revision, or null when it does not exist. */
export function readAtRevision(revision: string, relativePath: string): string | null {
  const result = spawnSync('git', ['show', `${revision}:${relativePath}`], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return result.status === 0 ? normalizeEol(result.stdout ?? '') : null;
}

export function gitHasCommits(): boolean {
  return spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT }).status === 0;
}

export function stage(
  name: string,
  options: {
    reproduce: string;
    blocksCommit?: boolean;
    suggestion?: string;
  },
  body: () => { ok: boolean; issues: StageIssue[]; output?: string },
): StageResult {
  const started = Date.now();
  let result: { ok: boolean; issues: StageIssue[]; output?: string };
  try {
    result = body();
  } catch (error) {
    result = {
      ok: false,
      issues: [
        {
          files: [],
          expected: 'the stage to run',
          actual: error instanceof Error ? error.message : String(error),
          message: 'the stage threw before it could report',
        },
      ],
    };
  }
  return {
    name,
    ok: result.ok,
    durationMs: Date.now() - started,
    issues: result.issues,
    reproduce: options.reproduce,
    blocksCommit: options.blocksCommit ?? true,
    suggestion: options.suggestion ?? '',
    ...(result.output !== undefined ? { output: result.output } : {}),
  };
}

/** Renders a stage result the way PLAN 17.3 asks for. */
export function printStage(result: StageResult): void {
  const status = result.ok ? 'PASS' : 'FAIL';
  console.log(`\n[${status}] ${result.name} (${result.durationMs}ms)`);
  if (result.ok) return;

  for (const issue of result.issues.slice(0, 20)) {
    console.log(`  - ${issue.message}`);
    if (issue.files.length > 0) console.log(`    files:    ${issue.files.join(', ')}`);
    if (issue.expected) console.log(`    expected: ${issue.expected}`);
    if (issue.actual) console.log(`    actual:   ${issue.actual}`);
  }
  if (result.issues.length > 20) {
    console.log(`  ... and ${result.issues.length - 20} more`);
  }
  console.log(`  reproduce:      ${result.reproduce}`);
  console.log(`  blocks commit:  ${result.blocksCommit ? 'yes' : 'no'}`);
  if (result.suggestion) console.log(`  next action:    ${result.suggestion}`);
}
