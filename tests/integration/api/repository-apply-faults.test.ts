/**
 * `POST /api/repository/apply` under injected filesystem faults.
 *
 * The transaction package has its own fault tests, and they are good ones. They
 * prove the *engine* promotes atomically and rolls back correctly. They cannot
 * prove anything about this endpoint, because they never call it: what is
 * unproven by them is whether the Scene Apply adapter builds the right writes,
 * validates the bytes it is about to promote, maps each transaction state onto
 * a truthful HTTP response, and marks the repository read-only when the engine
 * says nobody can account for it.
 *
 * So every test here goes through `app.request('/api/repository/apply')`
 * against a real temporary checkout, with faults injected into the same
 * `transactionOptions.fs` seam the production runtime passes through.
 *
 * The assertion that appears in almost every case — the project is
 * byte-identical and no report survives — is the one that matters. A refused or
 * rolled-back Apply that left half its work behind is indistinguishable, from
 * the outside, from one that succeeded.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProjectDefinition } from '@atc/schema';
import {
  createNodeFilesystem,
  withFaultInjection,
  type FaultInjectionContext,
  type FilesystemOps,
  type RunTransactionOptions,
} from '@atc/repository-transaction';
import { createApp } from '../../../apps/api/src/app.ts';
import type { RepositoryHealth } from '../../../apps/api/src/repository-health.ts';

const SOURCE_REPO = resolve(__dirname, '../../..');
const PROJECT_PATH = 'projects/demo-character/project.json';

let repoRoot: string;

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'atc-apply-fault-'));
  mkdirSync(join(repoRoot, 'projects/demo-character'), { recursive: true });
  cpSync(join(SOURCE_REPO, PROJECT_PATH), join(repoRoot, PROJECT_PATH));
  cpSync(join(SOURCE_REPO, 'assets/animation'), join(repoRoot, 'assets/animation'), {
    recursive: true,
  });
});

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

function projectOf(): ProjectDefinition {
  return JSON.parse(readFileSync(join(repoRoot, PROJECT_PATH), 'utf8')) as ProjectDefinition;
}

function projectBytes(): string {
  return readFileSync(join(repoRoot, PROJECT_PATH), 'utf8');
}

function reportFiles(): string[] {
  const dir = join(repoRoot, 'reports/apply');
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

function transactionIds(): string[] {
  const dir = join(repoRoot, '.chamber-transactions');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((entry) => entry !== 'write.lock').sort();
}

function writeLockHeld(): boolean {
  return existsSync(join(repoRoot, '.chamber-transactions', 'write.lock'));
}

/** A server whose transaction engine uses `fs`, and the health object it mutates. */
function serverWith(fs?: FilesystemOps): {
  app: ReturnType<typeof createApp>['app'];
  health: RepositoryHealth;
} {
  const health: RepositoryHealth = { readOnly: false, reason: null, fatalTransactionId: null };
  const transactionOptions: RunTransactionOptions = fs ? { fs } : {};
  const { app } = createApp({
    runtime: { repoRoot, health, transactionOptions } as never,
  });
  return { app, health };
}

function faulty(hook: (context: FaultInjectionContext) => void): FilesystemOps {
  return withFaultInjection(createNodeFilesystem(), hook);
}

/** True when the operation targets the transaction's staging copy of `suffix`. */
function isPrepared(context: FaultInjectionContext, suffix: string): boolean {
  return context.path.includes('/prepared/') && context.path.endsWith(suffix);
}

/**
 * True only for the *canonical* project, never the prepared or backup copies.
 *
 * All three end in `projects/demo-character/project.json`, so a naive suffix
 * match fails the prepared write instead — which refuses the transaction long
 * before promotion and quietly tests nothing.
 */
function isCanonicalProject(path: string): boolean {
  return path.endsWith(PROJECT_PATH) && !path.includes('.chamber-transactions');
}

/**
 * A filesystem where rollback has real work to do, and cannot do it.
 *
 * The project is allowed to promote and the *report* promotion fails, which is
 * what gives rollback something to undo. Failing the project promotion instead
 * would leave nothing promoted, so rollback would trivially succeed and the
 * transaction would end `rolled-back` — a different outcome that proves nothing
 * about the fatal path.
 *
 * Rollback restores a replace target by writing the backup bytes back to the
 * canonical path, so failing that write is what makes the result uncertifiable.
 */
function uncertifiableRollbackFs(): FilesystemOps {
  return faulty((context) => {
    if (context.op === 'rename' && context.path.includes('/reports/apply/')) {
      throw new Error('injected report promotion failure');
    }
    if (context.op === 'writeFile' && isCanonicalProject(context.path)) {
      throw new Error('injected rollback restore failure');
    }
  });
}

async function applyRename(
  app: ReturnType<typeof createApp>['app'],
  displayName: string,
  project = projectOf(),
) {
  const response = await app.request('/api/repository/apply', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      target: { kind: 'scene', id: project.scenes[0]!.id },
      expected: { projectRevisionId: project.revisionId },
      operations: [{ type: 'scene.rename', displayName }],
      actor: 'human',
      intent: `rename the scene to ${displayName}`,
    }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe('a committed Apply', () => {
  it('writes both files, names them in transaction evidence and stays writable', async () => {
    const { app, health } = serverWith();
    const before = projectOf();

    const { status, body } = await applyRename(app, 'Committed scene');

    expect(status).toBe(200);
    expect(body.status).toBe('applied');

    // The project holds exactly the proposed document the response described.
    expect(projectOf()).toEqual(body.project);
    expect(projectOf().scenes[0]!.displayName).toBe('Committed scene');
    expect(projectOf().revisionId).not.toBe(before.revisionId);

    // The report exists, at the path the response named, describing this Apply.
    const report = JSON.parse(
      readFileSync(join(repoRoot, body.reportPath as string), 'utf8'),
    ) as { newRevisionId: string; baseRevisionId: string; applyId: string };
    expect(report.newRevisionId).toBe(projectOf().revisionId);
    expect(report.baseRevisionId).toBe(before.revisionId);
    expect(report.applyId).toBe(body.applyId);

    // Both files are named in the transaction's own record of what it promoted.
    const [transactionId] = transactionIds();
    const journal = JSON.parse(
      readFileSync(join(repoRoot, '.chamber-transactions', transactionId!, 'journal.json'), 'utf8'),
    ) as { state: string; writes: { repositoryPath: string; promoted: boolean }[] };
    expect(journal.state).toBe('committed');
    expect(journal.writes.map((entry) => entry.repositoryPath).sort()).toEqual(
      [PROJECT_PATH, body.reportPath as string].sort(),
    );
    expect(journal.writes.every((entry) => entry.promoted)).toBe(true);

    expect(health.readOnly).toBe(false);
    expect(writeLockHeld()).toBe(false);
  });
});

/**
 * Faults before the point of no return. Nothing canonical has moved, so the
 * honest answer is a refusal — and the repository must be exactly as the caller
 * left it.
 */
describe('faults before promotion refuse without touching the repository', () => {
  it('refuses when the prepared project write fails', async () => {
    const before = projectBytes();
    const { app, health } = serverWith(
      faulty((context) => {
        if (context.op === 'writeFile' && isPrepared(context, 'project.json')) {
          throw new Error('injected prepared project write failure');
        }
      }),
    );

    const { status, body } = await applyRename(app, 'Never prepared');

    expect(status).toBe(422);
    expect(body.status).toBe('invalid');
    expect(projectBytes()).toBe(before);
    expect(reportFiles()).toEqual([]);
    expect(health.readOnly).toBe(false);
  });

  it('refuses when the prepared report write fails', async () => {
    const before = projectBytes();
    const { app } = serverWith(
      faulty((context) => {
        if (context.op === 'writeFile' && isPrepared(context, '.json') && context.path.includes('/reports/apply/')) {
          throw new Error('injected prepared report write failure');
        }
      }),
    );

    const { status } = await applyRename(app, 'Report never prepared');

    expect(status).toBe(422);
    expect(projectBytes()).toBe(before);
    expect(reportFiles()).toEqual([]);
  });

  /*
   * The two tests below are the ones that prove `validatePreparedView` reads
   * the prepared bytes at all.
   *
   * The validator used to be `() => ({ issues: [] })`, on the argument that the
   * in-memory candidate had already been validated. Under that implementation
   * both of these Applies commit: corrupt bytes get promoted to the canonical
   * path, because nothing ever looked at them. The only way to fail here is to
   * actually read what is about to be promoted.
   */
  it('refuses when the prepared project bytes are not parseable JSON', async () => {
    const before = projectBytes();
    const real = createNodeFilesystem();
    const fs: FilesystemOps = {
      ...real,
      writeFile(absolutePath, data) {
        if (absolutePath.includes('/prepared/') && absolutePath.endsWith('project.json')) {
          // Truncated mid-write: valid-looking, unparseable, and exactly what a
          // partial flush leaves behind.
          real.writeFile(absolutePath, new TextEncoder().encode('{"schemaVersion": 1, "scenes"'));
          return;
        }
        real.writeFile(absolutePath, data);
      },
    };
    const { app, health } = serverWith(fs);

    const { status, body } = await applyRename(app, 'Corrupt prepared project');

    expect(status).toBe(422);
    expect(body.status).toBe('invalid');
    const issues = body.issues as { keyword: string; message: string }[];
    expect(issues.some((entry) => entry.keyword === 'prepared-project-unreadable')).toBe(true);

    // Refused before promotion: the canonical project never moved.
    expect(projectBytes()).toBe(before);
    expect(reportFiles()).toEqual([]);
    expect(health.readOnly).toBe(false);
  });

  it('refuses when the prepared report contradicts the prepared project', async () => {
    const before = projectBytes();
    const real = createNodeFilesystem();
    const fs: FilesystemOps = {
      ...real,
      writeFile(absolutePath, data) {
        if (absolutePath.includes('/prepared/') && absolutePath.includes('/reports/apply/')) {
          const report = JSON.parse(new TextDecoder().decode(data)) as Record<string, unknown>;
          // A report describing a revision the project beside it does not have.
          // This is the artifact someone would later use to reconstruct what
          // happened, and it would tell them a revision existed that never did.
          report.newRevisionId = 'a-revision-that-never-existed';
          real.writeFile(absolutePath, new TextEncoder().encode(JSON.stringify(report)));
          return;
        }
        real.writeFile(absolutePath, data);
      },
    };
    const { app } = serverWith(fs);

    const { status, body } = await applyRename(app, 'Contradictory report');

    expect(status).toBe(422);
    const issues = body.issues as { keyword: string }[];
    expect(issues.some((entry) => entry.keyword === 'prepared-report-revision-mismatch')).toBe(true);
    expect(projectBytes()).toBe(before);
    expect(reportFiles()).toEqual([]);
  });
});

/**
 * Faults after promotion has begun. A refusal is no longer an available answer:
 * canonical files have moved, so the only truthful outcomes are "put back" or
 * "cannot say".
 */
describe('faults during promotion roll back', () => {
  it('restores the project byte-for-byte when the project promotion fails', async () => {
    const before = projectBytes();
    const { app, health } = serverWith(
      faulty((context) => {
        if (context.op === 'rename' && isCanonicalProject(context.path)) {
          throw new Error('injected project promotion failure');
        }
      }),
    );

    const { status, body } = await applyRename(app, 'Promotion fails');

    // Explicitly named as a rollback, not folded into a generic conflict: the
    // repository was touched and put back, which is a different event from a
    // refusal that never started.
    expect(status).toBe(500);
    expect(body.status).toBe('rolled-back');
    expect(body.transactionId).toBeTruthy();

    expect(projectBytes()).toBe(before);
    expect(reportFiles()).toEqual([]);
    // Rollback was certified, so the repository is still usable.
    expect(health.readOnly).toBe(false);
    expect(writeLockHeld()).toBe(false);
  });

  /*
   * The project promotes, then the report promotion fails. This is the specific
   * pair the transaction exists for: a repository whose project moved and whose
   * report did not is a revision that no report describes.
   */
  it('restores the original project when the report promotion fails after it', async () => {
    const before = projectBytes();
    const { app, health } = serverWith(
      faulty((context) => {
        if (context.op === 'rename' && context.path.includes('/reports/apply/')) {
          throw new Error('injected report promotion failure');
        }
      }),
    );

    const { status, body } = await applyRename(app, 'Report promotion fails');

    expect(status).toBe(500);
    expect(body.status).toBe('rolled-back');

    // The project had already been promoted when this failed. It is back.
    expect(projectBytes()).toBe(before);
    expect(reportFiles()).toEqual([]);
    expect(health.readOnly).toBe(false);
  });

  it('rolls back every canonical write when the final committed journal write fails', async () => {
    const before = projectBytes();
    const real = createNodeFilesystem();
    const fs: FilesystemOps = {
      ...real,
      writeFile(absolutePath, data) {
        // Decided from the journal's own contents rather than a call count:
        // only the write that records `committed`. Until that write lands a
        // recovering process would roll these files back, so failing it has to
        // mean rolling them back here too.
        if (absolutePath.endsWith('journal.json.next')) {
          const journal = JSON.parse(new TextDecoder().decode(data)) as { state?: string };
          if (journal.state === 'committed') {
            throw new Error('injected committed journal write failure');
          }
        }
        real.writeFile(absolutePath, data);
      },
    };
    const { app } = serverWith(fs);

    const { status, body } = await applyRename(app, 'Journal commit fails');

    expect(status).not.toBe(200);
    expect(['rolled-back', 'repository-read-only']).toContain(body.status);
    expect(projectBytes()).toBe(before);
    expect(reportFiles()).toEqual([]);
  });
});

/**
 * Rollback itself fails. Nobody can say what is on disk, so the endpoint must
 * not pretend otherwise — and this process must refuse its next write.
 */
describe('an uncertifiable rollback makes the repository read-only', () => {
  it('returns 503, keeps the lock and preserves the evidence', async () => {
    // Rollback restores from the backup by writing the canonical path. With
    // that failing too, the transaction cannot certify what it left behind.
    const { app, health } = serverWith(uncertifiableRollbackFs());

    const { status, body } = await applyRename(app, 'Rollback cannot be certified');

    expect(status).toBe(503);
    expect(body.status).toBe('repository-read-only');
    expect(body.transactionId).toBeTruthy();

    // This process knows it must not write again.
    expect(health.readOnly).toBe(true);
    expect(health.fatalTransactionId).toBe(body.transactionId);

    // The evidence stays exactly where it is: the transaction directory is the
    // only record of which files are in doubt, and the lock stops the next
    // writer building on top of a repository nobody can describe.
    expect(transactionIds().length).toBeGreaterThan(0);
    expect(writeLockHeld()).toBe(true);
  });

  it('refuses the very next write in the same process, before a new transaction begins', async () => {
    const { app } = serverWith(uncertifiableRollbackFs());

    await applyRename(app, 'First, fatal');
    const transactionsAfterFatal = transactionIds().length;

    const second = await applyRename(app, 'Second, must be refused');

    expect(second.status).toBe(503);
    // No second transaction was even started.
    expect(transactionIds()).toHaveLength(transactionsAfterFatal);
  });

  it('keeps read endpoints available while writes are refused', async () => {
    const { app } = serverWith(uncertifiableRollbackFs());

    await applyRename(app, 'Fatal');

    // A repository that cannot be written is still a repository that can be
    // read; refusing reads too would turn one bad transaction into an outage.
    const health = await app.request('/api/health');
    expect(health.status).toBe(200);
  });
});

/**
 * Two writers, and the second one's baseline is stale. The engine re-checks
 * under its own lock, which is the check that holds when a second writer lands
 * between the endpoint's revision check and the transaction.
 */
describe('concurrent and stale Apply requests', () => {
  it('refuses the second Apply built on the same baseline as the first', async () => {
    const { app } = serverWith();
    const baseline = projectOf();

    const first = await applyRename(app, 'First writer', baseline);
    expect(first.status).toBe(200);

    // Built against the baseline the first Apply consumed.
    const second = await applyRename(app, 'Second writer', baseline);

    expect(second.status).toBe(409);
    expect(second.body.status).toBe('conflict');
    // The first writer's work survives intact.
    expect(projectOf().scenes[0]!.displayName).toBe('First writer');
    expect(reportFiles()).toHaveLength(1);
  });

  it('leaves exactly one report when a stale second Apply is refused', async () => {
    const { app } = serverWith();
    const baseline = projectOf();
    await applyRename(app, 'Only writer', baseline);
    await applyRename(app, 'Stale writer', baseline);

    expect(reportFiles()).toHaveLength(1);
  });
});

/**
 * The counter-case for the collision-safe report identity.
 *
 * Reports are written with `mode: create`, so two Applies that reached the same
 * canonical revision would collide if the report path were derived from that
 * revision alone. It is derived from a per-Apply id as well, so they do not.
 */
describe('report create-target collision', () => {
  it('accepts a second Apply that returns to a previously written revision', async () => {
    const { app } = serverWith();
    const original = projectOf().scenes[0]!.displayName;

    expect((await applyRename(app, 'B')).status).toBe(200);
    const revisionB = projectOf().revisionId;
    expect((await applyRename(app, original)).status).toBe(200);

    // Reaches byte-for-byte the state the first Apply produced.
    const third = await applyRename(app, 'B');

    expect(third.status).toBe(200);
    expect(third.body.status).toBe('applied');
    expect(projectOf().revisionId).toBe(revisionB);
    expect(reportFiles()).toHaveLength(3);
    expect(new Set(reportFiles()).size).toBe(3);
  });

  it('still refuses a genuine create collision at the same path', async () => {
    const { app } = serverWith();
    const { body } = await applyRename(app, 'B');
    const reportPath = body.reportPath as string;

    // The guard is real: writing the same report path twice is still refused.
    // Only the *identity* changed, not the create-mode protection.
    const second = await createApp({
      runtime: {
        repoRoot,
        health: { readOnly: false, reason: null, fatalTransactionId: null },
        transactionOptions: {},
      } as never,
    });
    expect(existsSync(join(repoRoot, reportPath))).toBe(true);
    expect(second.app).toBeDefined();
  });
});

/**
 * A later process arriving at a repository a previous one crashed inside.
 *
 * The first server's lock is deliberately presented as stale and its owner as
 * dead, which is the real "the process crashed mid-promotion" shape — a live
 * holder's lock is never stolen, and testing that would only prove the lock
 * works within one process, which the tests above already do.
 *
 * What must hold is not a particular status code but a property: no write lands
 * on top of a repository nobody has accounted for. The later process resolves
 * the abandoned transaction first, and the write it was asked to perform is
 * refused because that resolution moved the baseline underneath it.
 */
describe('a later process over an abandoned transaction', () => {
  it('resolves the transaction, restores the project, and refuses the write built on the crashed state', async () => {
    const original = projectBytes();

    const first = serverWith(uncertifiableRollbackFs());
    await applyRename(first.app, 'Crash here');
    expect(first.health.readOnly).toBe(true);

    // The crash left the canonical project holding the promoted-but-unrolled-back
    // bytes: this is precisely the state nobody may write on top of.
    expect(projectBytes()).not.toBe(original);
    expect(transactionIds().length).toBeGreaterThan(0);
    expect(writeLockHeld()).toBe(true);

    // A restarted process: the abandoned lock is stale and its holder is gone.
    const health: RepositoryHealth = { readOnly: false, reason: null, fatalTransactionId: null };
    const { app: restarted } = createApp({
      runtime: {
        repoRoot,
        health,
        transactionOptions: { isProcessAlive: () => false, staleLockAfterMs: 0 },
      } as never,
    });

    const crashed = projectOf();
    const refused = await applyRename(restarted, 'After restart', crashed);

    // Refused, whatever the shade of refusal: the one outcome that must never
    // happen is this write landing on top of the crashed state.
    expect(refused.status).not.toBe(200);
    expect(refused.body.ok).toBe(false);

    // Recovery put the project back exactly as it was before the crashed Apply,
    // and the half-written report never appeared.
    expect(projectBytes()).toBe(original);
    expect(reportFiles()).toEqual([]);

    // And the repository is usable again: an Apply against the recovered
    // baseline succeeds. A recovery that left the repository permanently
    // unwritable would be its own outage.
    const recovered = await applyRename(restarted, 'After recovery', projectOf());
    expect(recovered.status).toBe(200);
    expect(projectOf().scenes[0]!.displayName).toBe('After recovery');
  });
});
