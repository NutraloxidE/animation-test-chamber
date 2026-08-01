import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  acquireWriteLock,
  createNodeFilesystem,
  generateTransactionId,
  journalFilePath,
  journalNextFilePath,
  readJournal,
  recoverRepository,
  sha256Hex,
  transactionDir,
  transactionRootDir,
  withFaultInjection,
  writeJournal,
  type FilesystemOps,
  type TransactionJournal,
} from '@atc/repository-transaction';

let repoRoot: string;

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'atc-repo-journal-'));
});

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

function sampleJournal(transactionId: string, state: TransactionJournal['state'] = 'preparing'): TransactionJournal {
  return {
    schemaVersion: 1,
    transactionId,
    intent: 'test journal',
    state,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    expected: {},
    writes: [],
  };
}

describe('atomic journal write', () => {
  it('journal write uses a temp file and an atomic rename, never truncating the primary in place', () => {
    const ops: { op: string; path: string }[] = [];
    const fs = withFaultInjection(createNodeFilesystem(), (ctx) => {
      ops.push({ op: ctx.op, path: ctx.path });
    });

    const transactionId = generateTransactionId();
    const txDir = transactionDir(repoRoot, transactionId);
    writeJournal(fs, txDir, sampleJournal(transactionId));

    const nextPath = journalNextFilePath(txDir);
    const primaryPath = journalFilePath(txDir);

    const writeIndex = ops.findIndex((entry) => entry.op === 'writeFile' && entry.path === nextPath);
    const renameIndex = ops.findIndex((entry) => entry.op === 'rename' && entry.path === primaryPath);

    expect(writeIndex).toBeGreaterThanOrEqual(0);
    expect(renameIndex).toBeGreaterThan(writeIndex);
    // The primary path is never targeted directly by writeFile: only ever
    // reached via the rename of the temp file onto it.
    expect(ops.some((entry) => entry.op === 'writeFile' && entry.path === primaryPath)).toBe(false);

    const result = readJournal(fs, txDir);
    expect(result.status).toBe('valid');
  });

  it('the primary journal remains valid and unchanged when the temp write fails', () => {
    const transactionId = generateTransactionId();
    const txDir = transactionDir(repoRoot, transactionId);
    const realFs = createNodeFilesystem();
    writeJournal(realFs, txDir, sampleJournal(transactionId, 'preparing'));
    const before = readFileSync(journalFilePath(txDir), 'utf8');

    const failingFs = withFaultInjection(createNodeFilesystem(), (ctx) => {
      if (ctx.op === 'writeFile' && ctx.path === journalNextFilePath(txDir)) {
        throw new Error('injected failure writing journal.json.next');
      }
    });

    expect(() => writeJournal(failingFs, txDir, sampleJournal(transactionId, 'prepared'))).toThrow();

    const after = readFileSync(journalFilePath(txDir), 'utf8');
    expect(after).toBe(before);
    const result = readJournal(realFs, txDir);
    expect(result.status).toBe('valid');
    if (result.status === 'valid') {
      expect(result.journal.state).toBe('preparing');
    }
  });
});

describe('torn/corrupt journal (WP-01-C)', () => {
  function writeTornJournal(txDir: string): void {
    mkdirSync(txDir, { recursive: true });
    // A process that died mid-write to journal.json directly (pre-atomic-
    // write behaviour, or a filesystem where rename is not actually atomic)
    // leaves exactly this: a syntactically incomplete document.
    writeFileSync(journalFilePath(txDir), '{"schemaVersion":1,"transactionId":', 'utf8');
  }

  it('a malformed journal.json never throws out of recoverRepository', () => {
    const fs = createNodeFilesystem();
    const txId = 'tx-torn-0001';
    writeTornJournal(transactionDir(repoRoot, txId));

    expect(() => recoverRepository(repoRoot, { fs })).not.toThrow();
  });

  it('a corrupt journal makes the repository read-only and reports an explicit journal-corrupt reason', () => {
    const fs = createNodeFilesystem();
    const txId = 'tx-torn-0002';
    writeTornJournal(transactionDir(repoRoot, txId));

    const result = recoverRepository(repoRoot, { fs });
    expect(result.readOnly).toBe(true);
    const entry = result.transactions.find((t) => t.transactionId === txId);
    expect(entry?.outcome).toBe('fatal');
    expect(entry?.message).toMatch(/journal-corrupt/);
  });

  it('the corrupt transaction directory is preserved, not deleted', () => {
    const fs = createNodeFilesystem();
    const txId = 'tx-torn-0003';
    const txDir = transactionDir(repoRoot, txId);
    writeTornJournal(txDir);

    recoverRepository(repoRoot, { fs });
    expect(() => readFileSync(journalFilePath(txDir))).not.toThrow();
  });

  it('a corrupt journal does not block recovery of other, independent valid transactions', () => {
    const fs = createNodeFilesystem();
    const corruptId = 'tx-torn-0004';
    writeTornJournal(transactionDir(repoRoot, corruptId));

    const cleanId = 'tx-clean-0001';
    const cleanTxDir = transactionDir(repoRoot, cleanId);
    writeJournal(fs, cleanTxDir, sampleJournal(cleanId, 'preparing'));

    const result = recoverRepository(repoRoot, { fs });
    expect(result.readOnly).toBe(true);
    expect(result.transactions.find((t) => t.transactionId === corruptId)?.outcome).toBe('fatal');
    expect(result.transactions.find((t) => t.transactionId === cleanId)?.outcome).toBe('cleaned-up');
  });

  it('recovery of a corrupt journal is idempotent', () => {
    const fs = createNodeFilesystem();
    const txId = 'tx-torn-0005';
    writeTornJournal(transactionDir(repoRoot, txId));

    const first = recoverRepository(repoRoot, { fs });
    const second = recoverRepository(repoRoot, { fs });
    expect(first).toEqual(second);
    expect(second.readOnly).toBe(true);
  });
});

describe('.next handling on recovery (WP-04.4)', () => {
  it('a stale .next next to a valid primary is discarded; the primary is authoritative', () => {
    const fs = createNodeFilesystem();
    const txId = 'tx-next-stale-0001';
    const txDir = transactionDir(repoRoot, txId);
    writeJournal(fs, txDir, sampleJournal(txId, 'preparing'));
    // Simulate a write that got as far as the temp file but never renamed.
    writeFileSync(journalNextFilePath(txDir), JSON.stringify(sampleJournal(txId, 'prepared')), 'utf8');

    const result = recoverRepository(repoRoot, { fs });
    // 'preparing' resolves as cleaned-up (promotion never began).
    expect(result.transactions.find((t) => t.transactionId === txId)?.outcome).toBe('cleaned-up');
    expect(result.readOnly).toBe(false);
  });

  it('a missing primary with a pending .next never guesses the commit state', () => {
    const fs = createNodeFilesystem();
    const txId = 'tx-next-orphan-0001';
    const txDir = transactionDir(repoRoot, txId);
    mkdirSync(txDir, { recursive: true });
    writeFileSync(journalNextFilePath(txDir), JSON.stringify(sampleJournal(txId, 'committed')), 'utf8');

    const result = recoverRepository(repoRoot, { fs });
    expect(result.readOnly).toBe(true);
    const entry = result.transactions.find((t) => t.transactionId === txId);
    expect(entry?.outcome).toBe('fatal');
    expect(entry?.message).toMatch(/journal-missing-with-pending-next/);
    // Preserved for a human, not silently promoted or discarded.
    expect(() => readFileSync(journalNextFilePath(txDir))).not.toThrow();
  });

  it('a corrupt primary with a valid .next never auto-promotes the .next', () => {
    const fs = createNodeFilesystem();
    const txId = 'tx-next-corrupt-primary-0001';
    const txDir = transactionDir(repoRoot, txId);
    mkdirSync(txDir, { recursive: true });
    writeFileSync(journalFilePath(txDir), '{not valid json', 'utf8');
    writeFileSync(journalNextFilePath(txDir), JSON.stringify(sampleJournal(txId, 'committed')), 'utf8');

    const result = recoverRepository(repoRoot, { fs });
    expect(result.readOnly).toBe(true);
    const entry = result.transactions.find((t) => t.transactionId === txId);
    expect(entry?.outcome).toBe('fatal');
    expect(entry?.message).toMatch(/journal-corrupt/);
    expect(() => readFileSync(journalNextFilePath(txDir))).not.toThrow();
    expect(() => readFileSync(journalFilePath(txDir))).not.toThrow();
  });
});

describe('stale lock cannot bypass an unresolved transaction (WP-04.5)', () => {
  const deps = { now: () => new Date().toISOString(), isProcessAlive: () => false, staleLockAfterMs: 1000 };

  function plantStaleLock(transactionId: string): void {
    mkdirSync(transactionRootDir(repoRoot), { recursive: true });
    writeFileSync(
      join(transactionRootDir(repoRoot), 'write.lock'),
      JSON.stringify({
        pid: 999_999_992,
        hostname: 'dead-host',
        createdAt: new Date(Date.now() - 10 * 60_000).toISOString(),
        transactionId,
      }),
      'utf8',
    );
  }

  it('a stale lock pointing at a corrupt transaction is not stolen', () => {
    const fs = createNodeFilesystem();
    const txId = 'tx-lock-corrupt-0001';
    mkdirSync(transactionDir(repoRoot, txId), { recursive: true });
    writeFileSync(journalFilePath(transactionDir(repoRoot, txId)), '{broken', 'utf8');
    plantStaleLock(txId);

    const acquisition = acquireWriteLock(
      fs,
      repoRoot,
      { pid: process.pid, hostname: 'h', createdAt: deps.now(), transactionId: 'tx-contender' },
      deps,
    );
    expect(acquisition.acquired).toBe(false);
    if (!acquisition.acquired) {
      expect(acquisition.reason).toBe('blocked-by-unresolved-transaction');
    }
    // The lock file itself is untouched — no takeover happened.
    expect(() => readFileSync(join(transactionRootDir(repoRoot), 'write.lock'))).not.toThrow();
  });

  it('a stale lock pointing at a fatal (unrestorable) transaction is not stolen', () => {
    const fs = createNodeFilesystem();
    const txId = 'tx-lock-fatal-0001';
    const txDir = transactionDir(repoRoot, txId);
    mkdirSync(txDir, { recursive: true });
    const fatalJournal: TransactionJournal = {
      ...sampleJournal(txId, 'rolling-back'),
      fatal: { message: 'could not restore 1 file(s)', unrestoredPaths: ['assets/x.json'] },
    };
    writeJournal(fs, txDir, fatalJournal);
    plantStaleLock(txId);

    const acquisition = acquireWriteLock(
      fs,
      repoRoot,
      { pid: process.pid, hostname: 'h', createdAt: deps.now(), transactionId: 'tx-contender' },
      deps,
    );
    expect(acquisition.acquired).toBe(false);
    if (!acquisition.acquired) {
      expect(acquisition.reason).toBe('blocked-by-unresolved-transaction');
    }
  });

  it('an ordinary stale lock with no corrupt/fatal transaction is still reclaimed normally', () => {
    const fs = createNodeFilesystem();
    plantStaleLock('tx-holder-does-not-exist');

    const acquisition = acquireWriteLock(
      fs,
      repoRoot,
      { pid: process.pid, hostname: 'h', createdAt: deps.now(), transactionId: 'tx-contender' },
      deps,
    );
    expect(acquisition.acquired).toBe(true);
  });
});
