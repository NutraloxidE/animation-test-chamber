import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
  // The journal itself now lands via a `journal.json.next` -> `journal.json`
  // rename (atomic-journal write), so `rename` calls are no longer only
  // promotion renames. Counting only renames that are not the journal swap
  // keeps these fault points aimed at the Nth *promotion* rename, same as
  // before that change.
  function failOnRename(atCallIndex: number) {
    let promotionRenameIndex = 0;
    return withFaultInjection(createNodeFilesystem(), (ctx) => {
      if (ctx.op !== 'rename' || ctx.path.endsWith('journal.json')) return;
      promotionRenameIndex += 1;
      if (promotionRenameIndex === atCallIndex) {
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

  it('failure surfaced during post-promotion hash verification rolls back what it safely can', async () => {
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
    // The project.json replace target was untouched by the corruption and
    // rolls back cleanly.
    expect(hashOf('project.json')).toBe(projectHash);
    // The create target's bytes no longer match what this transaction wrote
    // (the corruption is indistinguishable, from rollback's point of view,
    // from a foreign process having overwritten it right after promotion).
    // Ownership-safe rollback (WP-03) must not delete content it cannot
    // prove is its own, so the file is left in place — fatal, not silently
    // removed — and the outcome is reported as incomplete rather than a
    // clean success.
    expect(readText('assets/new-asset.json')).toBe('CORRUPTED-BY-TEST\n');
    expect(result.issues.some((issue) => issue.code === 'rollback-incomplete')).toBe(true);
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

  it('a promoted create with a matching hash is removed on recovery', async () => {
    const fs = createNodeFilesystem();
    const txId = 'tx-create-match-0001';
    const txDir = join(transactionRootDir(repoRoot), txId);
    mkdirSync(txDir, { recursive: true });
    const bytes = 'new-asset-v1\n';
    writeFileSync(join(repoRoot, 'assets/new-asset.json'), bytes, 'utf8');

    const journal = {
      schemaVersion: 1 as const,
      transactionId: txId,
      intent: 'create match',
      state: 'promoting' as const,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      expected: {},
      writes: [
        {
          repositoryPath: 'assets/new-asset.json',
          mode: 'create' as const,
          preparedSha256: sha256Hex(new TextEncoder().encode(bytes)),
          originalSha256: null,
          promoted: true,
        },
      ],
    };
    writeFileSync(join(txDir, 'journal.json'), JSON.stringify(journal, null, 2), 'utf8');

    const result = recoverRepository(repoRoot, { fs });
    expect(result.readOnly).toBe(false);
    expect(() => readFileSync(join(repoRoot, 'assets/new-asset.json'))).toThrow();
  });

  it('an unpromoted, foreign create target survives recovery and is reported fatal', async () => {
    const fs = createNodeFilesystem();
    const txId = 'tx-create-foreign-0001';
    const txDir = join(transactionRootDir(repoRoot), txId);
    mkdirSync(txDir, { recursive: true });
    const foreignBytes = 'not-ours\n';
    writeFileSync(join(repoRoot, 'assets/foreign.json'), foreignBytes, 'utf8');

    const journal = {
      schemaVersion: 1 as const,
      transactionId: txId,
      intent: 'never got to promote',
      state: 'promoting' as const,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      expected: {},
      writes: [
        {
          repositoryPath: 'assets/foreign.json',
          mode: 'create' as const,
          preparedSha256: sha256Hex(new TextEncoder().encode('ours\n')),
          originalSha256: null,
          promoted: false,
        },
      ],
    };
    writeFileSync(join(txDir, 'journal.json'), JSON.stringify(journal, null, 2), 'utf8');

    const result = recoverRepository(repoRoot, { fs });
    expect(result.readOnly).toBe(true);
    expect(result.transactions[0]?.outcome).toBe('fatal');
    expect(readFileSync(join(repoRoot, 'assets/foreign.json'), 'utf8')).toBe(foreignBytes);

    // Recovery is idempotent, and a second pass does not delete the foreign
    // file either.
    const again = recoverRepository(repoRoot, { fs });
    expect(again.readOnly).toBe(true);
    expect(readFileSync(join(repoRoot, 'assets/foreign.json'), 'utf8')).toBe(foreignBytes);
  });

  it('a promoted create modified afterward (hash no longer matches) survives recovery, marked fatal', async () => {
    const fs = createNodeFilesystem();
    const txId = 'tx-create-modified-0001';
    const txDir = join(transactionRootDir(repoRoot), txId);
    mkdirSync(txDir, { recursive: true });
    writeFileSync(join(repoRoot, 'assets/modified.json'), 'edited-after-promotion\n', 'utf8');

    const journal = {
      schemaVersion: 1 as const,
      transactionId: txId,
      intent: 'promoted then edited by someone else',
      state: 'promoting' as const,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      expected: {},
      writes: [
        {
          repositoryPath: 'assets/modified.json',
          mode: 'create' as const,
          preparedSha256: sha256Hex(new TextEncoder().encode('original-promoted-content\n')),
          originalSha256: null,
          promoted: true,
        },
      ],
    };
    writeFileSync(join(txDir, 'journal.json'), JSON.stringify(journal, null, 2), 'utf8');

    const result = recoverRepository(repoRoot, { fs });
    expect(result.readOnly).toBe(true);
    expect(result.transactions[0]?.outcome).toBe('fatal');
    expect(readFileSync(join(repoRoot, 'assets/modified.json'), 'utf8')).toBe('edited-after-promotion\n');
  });
});

/** Fails the journal write whose serialized content contains `match` (e.g. a state or promoted flag). */
function failOnJournalContent(match: string): FilesystemOps {
  const base = createNodeFilesystem();
  return {
    ...base,
    writeFile(absolutePath, data) {
      if (absolutePath.endsWith('journal.json.next')) {
        const text = new TextDecoder().decode(data);
        if (text.includes(match)) {
          throw new Error(`injected failure writing journal (matched "${match}")`);
        }
      }
      base.writeFile(absolutePath, data);
    },
  };
}

function listTransactionDirs(): string[] {
  return readdirSync(transactionRootDir(repoRoot)).filter((name) => name !== 'write.lock');
}

describe('point of no return: promotion-phase journal failures (WP-02)', () => {
  it('failure writing state=promoting leaves the canonical repository unchanged and never refuses as validation-refused', async () => {
    const projectHash = hashOf('project.json');
    const result = await runRepositoryTransaction(repoRoot, baseRequest(), {
      fs: failOnJournalContent('"state": "promoting"'),
    });
    expect(result.ok).toBe(false);
    expect(result.state).not.toBe('validation-refused');
    expect(result.state).toBe('rolled-back');
    expect(hashOf('project.json')).toBe(projectHash);
    expect(() => readFileSync(join(repoRoot, 'assets/new-asset.json'))).toThrow();
  });

  it('failure writing a promoted-entry journal rolls back the files already promoted and never refuses as validation-refused', async () => {
    const projectHash = hashOf('project.json');
    let promotedJournalWrites = 0;
    const base = createNodeFilesystem();
    const fs: FilesystemOps = {
      ...base,
      writeFile(absolutePath, data) {
        if (absolutePath.endsWith('journal.json.next')) {
          const text = new TextDecoder().decode(data);
          if (text.includes('"promoted": true')) {
            promotedJournalWrites += 1;
            if (promotedJournalWrites === 1) {
              throw new Error('injected failure writing promoted-entry journal');
            }
          }
        }
        base.writeFile(absolutePath, data);
      },
    };
    const result = await runRepositoryTransaction(repoRoot, baseRequest(), { fs });
    expect(result.ok).toBe(false);
    expect(result.state).not.toBe('validation-refused');
    expect(result.state).toBe('rolled-back');
    expect(hashOf('project.json')).toBe(projectHash);
    expect(() => readFileSync(join(repoRoot, 'assets/new-asset.json'))).toThrow();
  });

  it('failure writing the final state=committed journal rolls back every canonical write (WP-01-A / P1-A)', async () => {
    const projectHash = hashOf('project.json');
    const result = await runRepositoryTransaction(repoRoot, baseRequest(), {
      fs: failOnJournalContent('"state": "committed"'),
    });
    expect(result.ok).toBe(false);
    // The bug this reproduces: canonical files already promoted, then the
    // final journal write throws, and the transaction incorrectly reports
    // validation-refused — implying nothing changed when it did.
    expect(result.state).not.toBe('validation-refused');
    expect(result.state).toBe('rolled-back');
    expect(readText('project.json')).toBe('project-v1\n');
    expect(hashOf('project.json')).toBe(projectHash);
    expect(() => readFileSync(join(repoRoot, 'assets/new-asset.json'))).toThrow();
    // Evidence is preserved rather than deleted, unlike a validation refusal.
    expect(listTransactionDirs().length).toBeGreaterThan(0);
  });

  it('successful transaction still returns committed', async () => {
    const result = await runRepositoryTransaction(repoRoot, baseRequest());
    expect(result.ok).toBe(true);
    expect(result.state).toBe('committed');
  });
});

describe('ownership-safe create rollback (WP-01-B / WP-03)', () => {
  it('never deletes a foreign create target during rollback', async () => {
    const base = createNodeFilesystem();
    const foreignPath = join(repoRoot, 'assets/foreign.json');
    const foreignBytes = 'planted-by-a-concurrent-writer\n';
    let intercepted = false;
    const fs: FilesystemOps = {
      ...base,
      rename(fromAbsolute, toAbsolute) {
        if (toAbsolute === foreignPath && !intercepted) {
          intercepted = true;
          // The prepare phase saw this path absent; a foreign writer lands
          // here the instant before this transaction would have renamed
          // onto it, and the transaction detects the collision rather than
          // silently overwriting it.
          writeFileSync(foreignPath, foreignBytes, 'utf8');
          throw new Error('detected a foreign write at the create target');
        }
        base.rename(fromAbsolute, toAbsolute);
      },
    };

    const result = await runRepositoryTransaction(
      repoRoot,
      {
        intent: 'plant a new asset',
        expected: {},
        writes: [{ repositoryPath: 'assets/foreign.json', mode: 'create', content: 'ours\n' }],
        validatePreparedView: noopValidator,
      },
      { fs },
    );

    expect(result.ok).toBe(false);
    expect(result.state).not.toBe('validation-refused');
    // The foreign bytes must remain byte-identical: rollback never deletes a
    // create target it cannot prove it promoted.
    expect(readFileSync(foreignPath, 'utf8')).toBe(foreignBytes);
    expect(result.issues.some((issue) => issue.code === 'rollback-incomplete')).toBe(true);
    // Evidence preserved, not cleaned up as if nothing happened.
    expect(listTransactionDirs().length).toBeGreaterThan(0);
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
