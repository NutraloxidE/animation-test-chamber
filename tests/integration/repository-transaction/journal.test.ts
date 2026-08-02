/**
 * The journal is the only thing standing between a crashed process and a
 * repository nobody can reason about. These tests are about what happens when
 * the journal *itself* is the casualty — half-written by a crash, or shadowed
 * by a temp file whose fate nobody recorded — because a recovery path that
 * throws on a malformed journal turns one bad crash into a server that cannot
 * start.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createNodeFilesystem,
  journalFilePath,
  journalNextFilePath,
  readJournal,
  recoverRepository,
  runRepositoryTransaction,
  sha256Hex,
  transactionDir,
  transactionRootDir,
  withFaultInjection,
  writeJournal,
  type RepositoryTransactionRequest,
  type TransactionJournal,
} from '@atc/repository-transaction';

let repoRoot: string;

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'atc-repo-journal-'));
  mkdirSync(join(repoRoot, 'assets'), { recursive: true });
  writeFileSync(join(repoRoot, 'project.json'), 'project-v1\n', 'utf8');
});

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

function readText(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), 'utf8');
}

function baseRequest(overrides: Partial<RepositoryTransactionRequest> = {}): RepositoryTransactionRequest {
  return {
    intent: 'journal test transaction',
    expected: {},
    writes: [
      { repositoryPath: 'assets/new-asset.json', mode: 'create', content: 'new-asset-v1\n' },
      { repositoryPath: 'project.json', mode: 'replace', content: 'project-v2\n' },
    ],
    validatePreparedView: () => ({ issues: [] }),
    ...overrides,
  };
}

/** A journal describing a transaction that died mid-promotion. */
function promotingJournal(transactionId: string): TransactionJournal {
  return {
    schemaVersion: 1,
    transactionId,
    intent: 'staged for a recovery test',
    state: 'promoting',
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    expected: {},
    writes: [
      {
        repositoryPath: 'project.json',
        mode: 'replace',
        preparedSha256: sha256Hex(new TextEncoder().encode('project-v2\n')),
        originalSha256: sha256Hex(new TextEncoder().encode('project-v1\n')),
        promoted: false,
      },
    ],
  };
}

describe('atomic journal writes', () => {
  it('replaces the primary journal by rename rather than truncating it in place', async () => {
    const real = createNodeFilesystem();
    const primaryWrites: string[] = [];
    const renames: string[] = [];
    const fs = withFaultInjection(real, (ctx) => {
      if (ctx.op === 'writeFile' && ctx.path.endsWith('journal.json')) primaryWrites.push(ctx.path);
      if (ctx.op === 'rename' && ctx.path.endsWith('journal.json')) renames.push(ctx.path);
    });

    const result = await runRepositoryTransaction(repoRoot, baseRequest(), { fs });

    expect(result.ok).toBe(true);
    // Every journal update goes temp-then-rename. A direct write to the
    // primary path is exactly the window where a crash leaves torn JSON.
    expect(primaryWrites).toEqual([]);
    expect(renames.length).toBeGreaterThan(0);
  });

  it('leaves the previous primary journal intact when the temp write fails', () => {
    const fs = createNodeFilesystem();
    const txDir = transactionDir(repoRoot, 'tx-temp-write-fails');
    fs.mkdirRecursive(txDir);
    const first = promotingJournal('tx-temp-write-fails');
    writeJournal(fs, txDir, first);

    const failing = withFaultInjection(fs, (ctx) => {
      if (ctx.op === 'writeFile' && ctx.path.endsWith('.next')) {
        throw new Error('injected temp journal write failure');
      }
    });
    expect(() =>
      writeJournal(failing, txDir, { ...first, state: 'rolled-back', updatedAt: new Date().toISOString() }),
    ).toThrow();

    const after = readJournal(fs, txDir);
    expect(after.status).toBe('valid');
    if (after.status === 'valid') expect(after.journal.state).toBe('promoting');
  });
});

describe('corrupt journal', () => {
  const txId = 'tx-torn-journal-0001';

  function writeTornJournal(): string {
    const txDir = transactionDir(repoRoot, txId);
    mkdirSync(txDir, { recursive: true });
    // Exactly what a crash mid-write leaves: a prefix of valid JSON.
    writeFileSync(journalFilePath(txDir), '{"schemaVersion":1,"transactionId":', 'utf8');
    return txDir;
  }

  it('reads as corrupt rather than throwing out of readJournal', () => {
    const txDir = writeTornJournal();
    const result = readJournal(createNodeFilesystem(), txDir);
    expect(result.status).toBe('corrupt');
  });

  it('never throws out of recoverRepository', () => {
    writeTornJournal();
    expect(() => recoverRepository(repoRoot)).not.toThrow();
  });

  it('makes the repository read-only and says why', () => {
    writeTornJournal();
    const result = recoverRepository(repoRoot);
    expect(result.readOnly).toBe(true);
    const summary = result.transactions.find((entry) => entry.transactionId === txId);
    expect(summary?.outcome).toBe('fatal');
    expect(summary?.message).toMatch(/journal-corrupt/);
  });

  it('preserves the corrupt transaction directory instead of cleaning it up', () => {
    const txDir = writeTornJournal();
    recoverRepository(repoRoot);
    expect(existsSync(journalFilePath(txDir))).toBe(true);
    // Byte-identical: a recovery pass must not "repair" evidence either.
    expect(readFileSync(journalFilePath(txDir), 'utf8')).toBe('{"schemaVersion":1,"transactionId":');
  });

  it('is idempotent — a second pass reaches the same conclusion', () => {
    writeTornJournal();
    const first = recoverRepository(repoRoot);
    const second = recoverRepository(repoRoot);
    expect(second).toEqual(first);
  });

  it('still resolves other, independent, valid transactions in the same pass', () => {
    writeTornJournal();
    const fs = createNodeFilesystem();
    const goodDir = transactionDir(repoRoot, 'tx-good-0002');
    fs.mkdirRecursive(goodDir);
    writeJournal(fs, goodDir, { ...promotingJournal('tx-good-0002'), state: 'committed' });

    const result = recoverRepository(repoRoot);
    expect(result.readOnly).toBe(true);
    expect(result.transactions.find((t) => t.transactionId === 'tx-good-0002')?.outcome).toBe(
      'cleaned-up',
    );
    expect(existsSync(journalFilePath(goodDir))).toBe(false);
  });

  it('refuses to let a stale lock be taken over while a corrupt transaction is unresolved', async () => {
    writeTornJournal();
    const lockPath = join(transactionRootDir(repoRoot), 'write.lock');
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: 999_999_991,
        hostname: 'a-host-that-is-gone',
        createdAt: new Date(Date.now() - 10 * 60_000).toISOString(),
        transactionId: txId,
      }),
      'utf8',
    );

    const result = await runRepositoryTransaction(repoRoot, baseRequest(), {
      isProcessAlive: () => false,
      staleLockAfterMs: 1000,
    });

    // Stealing the lock here would mean writing on top of a repository whose
    // last transaction nobody can account for.
    expect(result.ok).toBe(false);
    expect(readText('project.json')).toBe('project-v1\n');
    expect(existsSync(join(repoRoot, 'assets/new-asset.json'))).toBe(false);
  });
});

describe('orphan .next journal files', () => {
  it('discards a stale temp file when the primary journal is valid', () => {
    const fs = createNodeFilesystem();
    const txDir = transactionDir(repoRoot, 'tx-stale-next-0001');
    fs.mkdirRecursive(txDir);
    writeJournal(fs, txDir, { ...promotingJournal('tx-stale-next-0001'), state: 'committed' });
    writeFileSync(journalNextFilePath(txDir), '{"partial":', 'utf8');

    const result = recoverRepository(repoRoot);
    expect(result.readOnly).toBe(false);
    expect(existsSync(txDir)).toBe(false);
  });

  it('does not promote a temp file into the primary journal when the primary is missing', () => {
    const fs = createNodeFilesystem();
    const txDir = transactionDir(repoRoot, 'tx-only-next-0001');
    fs.mkdirRecursive(txDir);
    // A complete, parseable .next with no primary: whether the rename ever
    // happened is precisely what is unknown, so guessing "committed" here
    // would be inventing the one fact that matters.
    writeFileSync(
      journalNextFilePath(txDir),
      JSON.stringify({ ...promotingJournal('tx-only-next-0001'), state: 'committed' }, null, 2),
      'utf8',
    );

    const result = recoverRepository(repoRoot);
    expect(result.readOnly).toBe(true);
    expect(existsSync(journalNextFilePath(txDir))).toBe(true);
    expect(existsSync(journalFilePath(txDir))).toBe(false);
  });

  it('preserves both files when the primary is corrupt and the temp file is valid', () => {
    const fs = createNodeFilesystem();
    const txDir = transactionDir(repoRoot, 'tx-corrupt-plus-next-0001');
    fs.mkdirRecursive(txDir);
    writeFileSync(journalFilePath(txDir), '{"schemaVersion":1,"transa', 'utf8');
    writeFileSync(
      journalNextFilePath(txDir),
      JSON.stringify({ ...promotingJournal('tx-corrupt-plus-next-0001'), state: 'committed' }, null, 2),
      'utf8',
    );

    const result = recoverRepository(repoRoot);
    expect(result.readOnly).toBe(true);
    expect(existsSync(journalFilePath(txDir))).toBe(true);
    expect(existsSync(journalNextFilePath(txDir))).toBe(true);
  });
});
