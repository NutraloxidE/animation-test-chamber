import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createNodeFilesystem,
  withFaultInjection,
  recoverRepository,
  runRepositoryTransaction,
  sha256Hex,
  transactionRootDir,
  acquireWriteLock,
  releaseWriteLock,
  type FilesystemOps,
  type RepositoryTransactionRequest,
  type TransactionJournal,
} from '@atc/repository-transaction';

let repoRoot: string;

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'atc-repo-tx-'));
  mkdirSync(join(repoRoot, 'assets'), { recursive: true });
  writeFileSync(join(repoRoot, 'project.json'), 'project-v1\n', 'utf8');
  writeFileSync(join(repoRoot, 'assets', 'existing.json'), 'existing-v1\n', 'utf8');
});

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

function hashOf(relativePath: string): string {
  return sha256Hex(new Uint8Array(readFileSync(join(repoRoot, relativePath))));
}

function readText(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), 'utf8');
}

function noopValidator() {
  return { issues: [] };
}

function baseRequest(overrides: Partial<RepositoryTransactionRequest> = {}): RepositoryTransactionRequest {
  return {
    intent: 'test transaction',
    expected: {},
    writes: [
      { repositoryPath: 'assets/new-asset.json', mode: 'create', content: 'new-asset-v1\n' },
      { repositoryPath: 'project.json', mode: 'replace', content: 'project-v2\n' },
    ],
    validatePreparedView: noopValidator,
    ...overrides,
  };
}

describe('successful commit', () => {
  it('promotes every write and leaves a resolvable journal', async () => {
    const result = await runRepositoryTransaction(repoRoot, baseRequest());
    expect(result.ok).toBe(true);
    expect(result.state).toBe('committed');
    expect(result.written.sort()).toEqual(['assets/new-asset.json', 'project.json'].sort());
    expect(readText('assets/new-asset.json')).toBe('new-asset-v1\n');
    expect(readText('project.json')).toBe('project-v2\n');
  });

  it('the prepared view sees proposed content overlaid on disk during validation', async () => {
    let seenDuringValidation: { newAsset: string; existing: string } | undefined;
    const result = await runRepositoryTransaction(
      repoRoot,
      baseRequest({
        validatePreparedView(view) {
          seenDuringValidation = {
            newAsset: view.readText('assets/new-asset.json'),
            existing: view.readText('assets/existing.json'),
          };
          return { issues: [] };
        },
      }),
    );
    expect(result.ok).toBe(true);
    expect(seenDuringValidation).toEqual({ newAsset: 'new-asset-v1\n', existing: 'existing-v1\n' });
  });
});

describe('path validation', () => {
  it.each([
    ['/absolute/path.json', 'absolute'],
    ['../escape.json', 'traversal'],
    ['a/../../b.json', 'traversal'],
    ['', 'empty'],
  ])('refuses %s (%s)', async (path) => {
    const result = await runRepositoryTransaction(
      repoRoot,
      baseRequest({ writes: [{ repositoryPath: path, mode: 'create', content: 'x' }] }),
    );
    expect(result.ok).toBe(false);
    expect(result.state).toBe('validation-refused');
    expect(readText('project.json')).toBe('project-v1\n');
  });
});

describe('validator refusal', () => {
  it('refuses without writing anything when a validator reports an error', async () => {
    const before = hashOf('project.json');
    const result = await runRepositoryTransaction(
      repoRoot,
      baseRequest({
        validatePreparedView() {
          return { issues: [{ code: 'domain-invalid', severity: 'error', message: 'no' }] };
        },
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.state).toBe('validation-refused');
    expect(hashOf('project.json')).toBe(before);
    expect(() => readFileSync(join(repoRoot, 'assets/new-asset.json'))).toThrow();
  });

  it('a warning-only validation result still commits', async () => {
    const result = await runRepositoryTransaction(
      repoRoot,
      baseRequest({
        validatePreparedView() {
          return { issues: [{ code: 'fyi', severity: 'warning', message: 'noted' }] };
        },
      }),
    );
    expect(result.ok).toBe(true);
  });
});

describe('create/replace mode enforcement', () => {
  it('refuses create when the target already exists', async () => {
    const result = await runRepositoryTransaction(
      repoRoot,
      baseRequest({
        writes: [{ repositoryPath: 'assets/existing.json', mode: 'create', content: 'x' }],
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.code === 'create-target-exists')).toBe(true);
    expect(readText('assets/existing.json')).toBe('existing-v1\n');
  });

  it('refuses replace when the target does not exist', async () => {
    const result = await runRepositoryTransaction(
      repoRoot,
      baseRequest({
        writes: [{ repositoryPath: 'assets/missing.json', mode: 'replace', content: 'x' }],
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.code === 'replace-target-missing')).toBe(true);
  });
});

describe('optimistic concurrency', () => {
  it('refuses on a stale project revision expectation', async () => {
    const result = await runRepositoryTransaction(
      repoRoot,
      baseRequest({
        expected: {
          projectRevisionId: 'rev-1',
          files: [{ repositoryPath: 'project.json', expectedSha256: '0'.repeat(64) }],
        },
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.state).toBe('conflict-refused');
    expect(result.issues.some((i) => i.code === 'stale-expectation')).toBe(true);
    expect(readText('project.json')).toBe('project-v1\n');
  });

  it('refuses on a stale referenced-asset hash even when that asset is not written', async () => {
    const staleHash = hashOf('assets/existing.json');
    writeFileSync(join(repoRoot, 'assets/existing.json'), 'existing-v2-changed-underneath\n', 'utf8');
    const result = await runRepositoryTransaction(
      repoRoot,
      baseRequest({
        expected: { files: [{ repositoryPath: 'assets/existing.json', expectedSha256: staleHash }] },
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.code === 'stale-expectation')).toBe(true);
  });

  it('succeeds when every expectation still matches fresh disk state', async () => {
    const projectHash = hashOf('project.json');
    const result = await runRepositoryTransaction(
      repoRoot,
      baseRequest({
        expected: { files: [{ repositoryPath: 'project.json', expectedSha256: projectHash }] },
      }),
    );
    expect(result.ok).toBe(true);
  });

  it('two publishes proposing the same new version: first wins, second is refused', async () => {
    const requestFor = (content: string): RepositoryTransactionRequest => ({
      intent: 'publish next version',
      expected: {},
      writes: [{ repositoryPath: 'assets/next-version.json', mode: 'create', content }],
      validatePreparedView: noopValidator,
    });

    const first = await runRepositoryTransaction(repoRoot, requestFor('from-first-writer\n'));
    const second = await runRepositoryTransaction(repoRoot, requestFor('from-second-writer\n'));

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    expect(second.issues.some((i) => i.code === 'create-target-exists')).toBe(true);
    expect(readText('assets/next-version.json')).toBe('from-first-writer\n');
  });
});

describe('fault injection during promotion', () => {
  function failOnRename(atCallIndex: number) {
    return withFaultInjection(createNodeFilesystem(), (ctx) => {
      if (ctx.op === 'rename' && ctx.callIndex === atCallIndex) {
        throw new Error(`injected failure at rename #${atCallIndex}`);
      }
    });
  }

  it('failure before the first promotion leaves the repository untouched', async () => {
    const projectHash = hashOf('project.json');
    const result = await runRepositoryTransaction(repoRoot, baseRequest(), { fs: failOnRename(1) });
    expect(result.ok).toBe(false);
    expect(result.state).toBe('rolled-back');
    expect(hashOf('project.json')).toBe(projectHash);
    expect(() => readFileSync(join(repoRoot, 'assets/new-asset.json'))).toThrow();
  });

  it('failure after the first asset promotion rolls that one back too', async () => {
    const projectHash = hashOf('project.json');
    const result = await runRepositoryTransaction(repoRoot, baseRequest(), { fs: failOnRename(2) });
    expect(result.ok).toBe(false);
    expect(result.state).toBe('rolled-back');
    expect(hashOf('project.json')).toBe(projectHash);
    expect(() => readFileSync(join(repoRoot, 'assets/new-asset.json'))).toThrow();
  });

  it('failure after all creates but before the project replace rolls everything back', async () => {
    const projectHash = hashOf('project.json');
    const result = await runRepositoryTransaction(
      repoRoot,
      baseRequest({
        writes: [
          { repositoryPath: 'assets/one.json', mode: 'create', content: 'one\n' },
          { repositoryPath: 'assets/two.json', mode: 'create', content: 'two\n' },
          { repositoryPath: 'project.json', mode: 'replace', content: 'project-v2\n' },
        ],
      }),
      { fs: failOnRename(3) },
    );
    expect(result.ok).toBe(false);
    expect(result.state).toBe('rolled-back');
    expect(hashOf('project.json')).toBe(projectHash);
    expect(() => readFileSync(join(repoRoot, 'assets/one.json'))).toThrow();
    expect(() => readFileSync(join(repoRoot, 'assets/two.json'))).toThrow();
  });

  it('failure during the project rename itself restores the original project byte-identical', async () => {
    const projectHash = hashOf('project.json');
    const result = await runRepositoryTransaction(repoRoot, baseRequest(), { fs: failOnRename(2) });
    expect(result.ok).toBe(false);
    expect(readText('project.json')).toBe('project-v1\n');
    expect(hashOf('project.json')).toBe(projectHash);
  });

  it('failure surfaced during post-promotion hash verification triggers a full rollback', async () => {
    const seenAt = new Map<string, number>();
    const targetAbs = join(repoRoot, 'assets/new-asset.json');
    const fs: FilesystemOps = withFaultInjection(createNodeFilesystem(), (ctx) => {
      if (ctx.op !== 'readFileBytes' || ctx.path !== targetAbs) return;
      const count = (seenAt.get(ctx.path) ?? 0) + 1;
      seenAt.set(ctx.path, count);
      // 1st read: prepare-phase "does this create target already exist" check.
      // 2nd read: post-promotion verification. Corrupt it right before that read.
      if (count === 2) {
        writeFileSync(targetAbs, 'CORRUPTED-BY-TEST\n', 'utf8');
      }
    });

    const projectHash = hashOf('project.json');
    const result = await runRepositoryTransaction(repoRoot, baseRequest(), { fs });
    expect(result.ok).toBe(false);
    expect(result.state).toBe('rolled-back');
    expect(hashOf('project.json')).toBe(projectHash);
    expect(() => readFileSync(targetAbs)).toThrow();
  });
});

describe('crash recovery', () => {
  it('a journal stuck in state=promoting after a simulated crash is rolled back on recovery', async () => {
    const fs = createNodeFilesystem();
    const projectHash = hashOf('project.json');

    // A real crash mid-promotion can't be produced by throwing inside this
    // process's own call (that path is exactly what the "fault injection
    // during promotion" tests above already cover, and it always runs
    // rollback before returning). A crash means the process never gets to
    // run its own rollback at all, so we stage the on-disk artifacts a crash
    // would leave behind directly, and rely on `recoverRepository` — the
    // startup path a fresh process takes — to resolve them.
    //
    // Manually stage a "crashed mid-promotion" transaction directory: one
    // asset already renamed into place (promoted), the project replace still
    // sitting in prepared/ with its backup saved, journal state=promoting.
    const txId = 'tx-crash-sim-0001';
    const txDir = join(transactionRootDir(repoRoot), txId);
    mkdirSync(join(txDir, 'prepared', 'assets'), { recursive: true });
    mkdirSync(join(txDir, 'backups'), { recursive: true });

    // The new asset: already promoted (renamed out of prepared/ for real).
    writeFileSync(join(repoRoot, 'assets/new-asset.json'), 'new-asset-v1\n', 'utf8');
    // The project replace: still staged, not yet promoted; backup saved.
    writeFileSync(join(txDir, 'prepared', 'project.json'), 'project-v2\n', 'utf8');
    writeFileSync(join(txDir, 'backups', 'project.json'), 'project-v1\n', 'utf8');

    const journal = {
      schemaVersion: 1 as const,
      transactionId: txId,
      intent: 'crash simulation',
      state: 'promoting' as const,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      expected: {},
      writes: [
        {
          repositoryPath: 'assets/new-asset.json',
          mode: 'create' as const,
          preparedSha256: sha256Hex(new TextEncoder().encode('new-asset-v1\n')),
          originalSha256: null,
          promoted: true,
        },
        {
          repositoryPath: 'project.json',
          mode: 'replace' as const,
          preparedSha256: sha256Hex(new TextEncoder().encode('project-v2\n')),
          originalSha256: projectHash,
          promoted: false,
        },
      ],
    };
    writeFileSync(join(txDir, 'journal.json'), JSON.stringify(journal, null, 2), 'utf8');

    const result = recoverRepository(repoRoot, { fs });
    expect(result.readOnly).toBe(false);
    expect(readText('project.json')).toBe('project-v1\n');
    expect(hashOf('project.json')).toBe(projectHash);
    expect(() => readFileSync(join(repoRoot, 'assets/new-asset.json'))).toThrow();
    expect(() => readFileSync(join(txDir, 'journal.json'))).toThrow();
  });

  it('recovery is idempotent: running it twice yields the same resolved state', async () => {
    const fs = createNodeFilesystem();
    const first = recoverRepository(repoRoot, { fs });
    const second = recoverRepository(repoRoot, { fs });
    expect(first).toEqual(second);
    expect(first.readOnly).toBe(false);
  });

  it('a fatal (unrestorable) rollback leaves the repository marked read-only rather than silently resolved', async () => {
    const fs = createNodeFilesystem();
    const txId = 'tx-fatal-sim-0001';
    const txDir = join(transactionRootDir(repoRoot), txId);
    mkdirSync(join(txDir, 'backups'), { recursive: true });
    // No backup file written for project.json: rollback cannot restore it.
    writeFileSync(join(repoRoot, 'project.json'), 'project-v2-promoted\n', 'utf8');

    const journal = {
      schemaVersion: 1 as const,
      transactionId: txId,
      intent: 'fatal simulation',
      state: 'promoting' as const,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      expected: {},
      writes: [
        {
          repositoryPath: 'project.json',
          mode: 'replace' as const,
          preparedSha256: sha256Hex(new TextEncoder().encode('project-v2-promoted\n')),
          originalSha256: sha256Hex(new TextEncoder().encode('project-v1\n')),
          promoted: true,
        },
      ],
    };
    writeFileSync(join(txDir, 'journal.json'), JSON.stringify(journal, null, 2), 'utf8');

    const result = recoverRepository(repoRoot, { fs });
    expect(result.readOnly).toBe(true);
    expect(result.transactions[0]?.outcome).toBe('fatal');
    // The directory is left in place for a human, not silently deleted.
    expect(() => readFileSync(join(txDir, 'journal.json'))).not.toThrow();

    const again = recoverRepository(repoRoot, { fs });
    expect(again.readOnly).toBe(true);
  });
});

describe('point of no return', () => {
  const real = createNodeFilesystem();

  /** The journal file a write targets, whether it goes through a temp file or not. */
  function primaryJournalPathOf(writtenPath: string): string {
    return writtenPath.replace(/\.next$/, '');
  }

  function journalOnDisk(writtenPath: string): TransactionJournal | null {
    const bytes = real.readFileIfExists(primaryJournalPathOf(writtenPath));
    if (!bytes) return null;
    try {
      return JSON.parse(new TextDecoder().decode(bytes)) as TransactionJournal;
    } catch {
      return null;
    }
  }

  /**
   * Fails one specific journal write, identified by the state already on disk
   * rather than by a call index. A call index would silently start pointing at
   * a different moment the first time the journal gains or loses an
   * intermediate write; "the write that follows this exact recorded state" goes
   * on meaning the same thing.
   */
  function failJournalWriteAfter(
    predicate: (journal: TransactionJournal) => boolean,
  ): { fs: FilesystemOps; fired: () => boolean } {
    let fired = false;
    const fs = withFaultInjection(real, (ctx) => {
      // Once only: the scenario is a single failed write, not a disk that has
      // stopped accepting journals altogether. Rollback's own journal writes
      // must be allowed to succeed so this exercises the rollback path rather
      // than the fatal one.
      if (fired) return;
      if (ctx.op !== 'writeFile' || !/journal\.json(\.next)?$/.test(ctx.path)) return;
      const journal = journalOnDisk(ctx.path);
      if (!journal || !predicate(journal)) return;
      fired = true;
      throw new Error('injected journal write failure');
    });
    return { fs, fired: () => fired };
  }

  const allPromoted = (journal: TransactionJournal): boolean =>
    journal.state === 'promoting' && journal.writes.every((entry) => entry.promoted);

  it('rolls back every canonical write when the final committed journal write fails', async () => {
    const projectHash = hashOf('project.json');
    const { fs, fired } = failJournalWriteAfter(allPromoted);

    const result = await runRepositoryTransaction(repoRoot, baseRequest(), { fs });

    expect(fired()).toBe(true);
    expect(result.ok).toBe(false);
    // The canonical files were all in place when this failed. Reporting it as a
    // validation refusal would claim nothing had happened yet, which is the one
    // thing that is definitely untrue at this point.
    expect(result.state).not.toBe('validation-refused');
    expect(result.state).toBe('rolled-back');
    // Byte-identical, not merely "looks restored".
    expect(readText('project.json')).toBe('project-v1\n');
    expect(hashOf('project.json')).toBe(projectHash);
    expect(() => readFileSync(join(repoRoot, 'assets/new-asset.json'))).toThrow();
  });

  it('never returns validation-refused once the promoting journal write is attempted', async () => {
    const projectHash = hashOf('project.json');
    const { fs, fired } = failJournalWriteAfter((journal) => journal.state === 'prepared');

    const result = await runRepositoryTransaction(repoRoot, baseRequest(), { fs });

    expect(fired()).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.state).not.toBe('validation-refused');
    expect(hashOf('project.json')).toBe(projectHash);
    expect(() => readFileSync(join(repoRoot, 'assets/new-asset.json'))).toThrow();
  });

  it('rolls back the files already promoted when a per-entry journal write fails', async () => {
    const projectHash = hashOf('project.json');
    // Fails the write that would record the *first* entry as promoted — by
    // which point that entry's rename has already landed.
    const { fs, fired } = failJournalWriteAfter(
      (journal) => journal.state === 'promoting' && journal.writes.every((entry) => !entry.promoted),
    );

    const result = await runRepositoryTransaction(
      repoRoot,
      baseRequest({
        writes: [
          { repositoryPath: 'assets/one.json', mode: 'create', content: 'one\n' },
          { repositoryPath: 'assets/two.json', mode: 'create', content: 'two\n' },
          { repositoryPath: 'project.json', mode: 'replace', content: 'project-v2\n' },
        ],
      }),
      { fs },
    );

    expect(fired()).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.state).not.toBe('validation-refused');
    expect(hashOf('project.json')).toBe(projectHash);
    expect(() => readFileSync(join(repoRoot, 'assets/one.json'))).toThrow();
    expect(() => readFileSync(join(repoRoot, 'assets/two.json'))).toThrow();
  });

  it('preserves the transaction directory as evidence when rollback cannot be certified', async () => {
    // The backup a rollback would restore from is destroyed after it is taken,
    // so the replace target cannot be put back and the outcome is fatal.
    let backupPath: string | undefined;
    const fs = withFaultInjection(real, (ctx) => {
      if (ctx.op === 'writeFile' && /backups[/\\]project\.json$/.test(ctx.path)) {
        backupPath = ctx.path;
      }
      if (ctx.op !== 'writeFile' || !/journal\.json(\.next)?$/.test(ctx.path)) return;
      const journal = journalOnDisk(ctx.path);
      if (!journal || !allPromoted(journal)) return;
      if (backupPath) real.remove(backupPath);
      throw new Error('injected journal write failure with an unrecoverable backup');
    });

    const result = await runRepositoryTransaction(repoRoot, baseRequest(), { fs });

    expect(result.ok).toBe(false);
    expect(result.state).not.toBe('validation-refused');
    // Whatever the outcome is called, the evidence a human needs must survive.
    const remaining = real.listFilesRecursive(transactionRootDir(repoRoot));
    expect(remaining.some((path) => path.endsWith('journal.json'))).toBe(true);
  });

  it('a successful transaction still commits with no injected failure', async () => {
    const result = await runRepositoryTransaction(repoRoot, baseRequest());
    expect(result.ok).toBe(true);
    expect(result.state).toBe('committed');
  });
});

describe('create rollback ownership', () => {
  it('never deletes a foreign create target during rollback', async () => {
    const real = createNodeFilesystem();
    const foreignAbs = join(repoRoot, 'assets/new-asset.json');
    const foreignBytes = 'written-by-another-process\n';
    const projectHash = hashOf('project.json');

    // The create target is absent when prepare checks it, and a foreign
    // process creates it before promotion reaches that entry. Ordering the
    // replace first gives that window a deterministic place to open.
    const fs = withFaultInjection(real, (ctx) => {
      if (ctx.op === 'rename' && ctx.path === join(repoRoot, 'project.json')) {
        writeFileSync(foreignAbs, foreignBytes, 'utf8');
      }
    });

    const result = await runRepositoryTransaction(
      repoRoot,
      baseRequest({
        writes: [
          { repositoryPath: 'project.json', mode: 'replace', content: 'project-v2\n' },
          { repositoryPath: 'assets/new-asset.json', mode: 'create', content: 'ours\n' },
        ],
      }),
      { fs },
    );

    expect(result.ok).toBe(false);
    // The bytes belong to whoever wrote them. This transaction never promoted
    // that path, so it has no claim to delete it.
    expect(readText('assets/new-asset.json')).toBe(foreignBytes);
    expect(hashOf('project.json')).toBe(projectHash);
    // Ownership could not be proven, so the repository must stop accepting
    // writes rather than carry on over an unexplained file.
    const recovery = recoverRepository(repoRoot, { fs: real });
    expect(recovery.readOnly).toBe(true);
    expect(readText('assets/new-asset.json')).toBe(foreignBytes);
  });

  it('removes a create target it promoted itself and can still prove it wrote', async () => {
    const projectHash = hashOf('project.json');
    const fs = withFaultInjection(createNodeFilesystem(), (ctx) => {
      // Fail the last rename, after the create above it has been promoted.
      if (ctx.op === 'rename' && ctx.path === join(repoRoot, 'project.json')) {
        throw new Error('injected failure promoting the project');
      }
    });

    const result = await runRepositoryTransaction(
      repoRoot,
      baseRequest({
        writes: [
          { repositoryPath: 'assets/new-asset.json', mode: 'create', content: 'ours\n' },
          { repositoryPath: 'project.json', mode: 'replace', content: 'project-v2\n' },
        ],
      }),
      { fs },
    );

    expect(result.ok).toBe(false);
    expect(result.state).toBe('rolled-back');
    expect(() => readFileSync(join(repoRoot, 'assets/new-asset.json'))).toThrow();
    expect(hashOf('project.json')).toBe(projectHash);
  });

  it('leaves a create target it promoted but that someone else has since rewritten', async () => {
    const real = createNodeFilesystem();
    const targetAbs = join(repoRoot, 'assets/new-asset.json');
    const rewritten = 'rewritten-after-promotion\n';

    const fs = withFaultInjection(real, (ctx) => {
      if (ctx.op === 'rename' && ctx.path === join(repoRoot, 'project.json')) {
        // Our create is already promoted; a third party rewrites it, then our
        // own promotion fails and rollback runs.
        writeFileSync(targetAbs, rewritten, 'utf8');
        throw new Error('injected failure promoting the project');
      }
    });

    const result = await runRepositoryTransaction(
      repoRoot,
      baseRequest({
        writes: [
          { repositoryPath: 'assets/new-asset.json', mode: 'create', content: 'ours\n' },
          { repositoryPath: 'project.json', mode: 'replace', content: 'project-v2\n' },
        ],
      }),
      { fs },
    );

    expect(result.ok).toBe(false);
    // We promoted it, but these are not the bytes we promoted, so they are not
    // ours to delete.
    expect(readText('assets/new-asset.json')).toBe(rewritten);
    expect(recoverRepository(repoRoot, { fs: real }).readOnly).toBe(true);
    expect(readText('assets/new-asset.json')).toBe(rewritten);
  });
});

describe('report write does not affect the committed outcome', () => {
  it('a report write failure after commit still returns ok:true', async () => {
    let reportAttempted = false;
    const fs = withFaultInjection(createNodeFilesystem(), (ctx) => {
      if (ctx.op === 'writeFile' && ctx.path.endsWith('report.json')) {
        reportAttempted = true;
        throw new Error('disk full writing report');
      }
    });
    const result = await runRepositoryTransaction(repoRoot, baseRequest(), { fs });
    expect(reportAttempted).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.state).toBe('committed');
    expect(readText('project.json')).toBe('project-v2\n');
  });
});

describe('write lock', () => {
  const deps = { now: () => new Date().toISOString(), isProcessAlive: () => true, staleLockAfterMs: 60_000 };

  it('refuses a second transaction while the first still holds the lock', () => {
    const fs = createNodeFilesystem();
    const first = acquireWriteLock(
      fs,
      repoRoot,
      { pid: process.pid, hostname: 'h', createdAt: deps.now(), transactionId: 'tx-holder' },
      deps,
    );
    expect(first.acquired).toBe(true);
    const second = acquireWriteLock(
      fs,
      repoRoot,
      { pid: process.pid, hostname: 'h', createdAt: deps.now(), transactionId: 'tx-contender' },
      deps,
    );
    expect(second.acquired).toBe(false);
    releaseWriteLock(fs, repoRoot, 'tx-holder');
  });

  it('steals a stale lock left by a dead process and resolves what it was holding', async () => {
    const fs = createNodeFilesystem();
    const deadPid = 999_999_991;
    const lockPath = join(transactionRootDir(repoRoot), 'write.lock');
    mkdirSync(transactionRootDir(repoRoot), { recursive: true });
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: deadPid,
        hostname: 'stale-host-does-not-matter',
        createdAt: new Date(Date.now() - 10 * 60_000).toISOString(),
        transactionId: 'tx-stale-holder',
      }),
      'utf8',
    );

    const result = await runRepositoryTransaction(repoRoot, baseRequest(), {
      fs,
      isProcessAlive: () => false,
      staleLockAfterMs: 1000,
    });
    expect(result.ok).toBe(true);
  });
});
