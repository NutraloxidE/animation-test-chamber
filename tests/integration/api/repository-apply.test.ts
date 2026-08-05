/**
 * `POST /api/repository/apply`, over real HTTP handlers against a real
 * temporary checkout.
 *
 * The properties worth proving are the separations the whole editing model
 * rests on, and none of them can be checked against a mock filesystem: a
 * preview does not write, a stage does not write, an apply writes atomically
 * and validated, a stale baseline is refused rather than overwritten, and every
 * refusal leaves the repository byte-identical.
 *
 * Every request here is built as an untrusted JSON payload rather than through
 * a typed helper, because that is what the endpoint actually receives. A test
 * that could only send well-formed requests would prove nothing about the
 * boundary it exists to defend.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProjectDefinition, SceneDefinition } from '@atc/schema';
import { validateSceneReferences } from '@atc/schema';
import {
  DocumentEditSession,
  applySceneOperation,
  type SceneOperation,
} from '@atc/editor-core';
import { createApp } from '../../../apps/api/src/app.ts';

const SOURCE_REPO = resolve(__dirname, '../../..');
const PROJECT_PATH = 'projects/demo-character/project.json';

let repoRoot: string;
let app: ReturnType<typeof createApp>['app'];

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'atc-api-apply-'));
  mkdirSync(join(repoRoot, 'projects/demo-character'), { recursive: true });
  cpSync(join(SOURCE_REPO, PROJECT_PATH), join(repoRoot, PROJECT_PATH));
  cpSync(join(SOURCE_REPO, 'assets/animation'), join(repoRoot, 'assets/animation'), {
    recursive: true,
  });
  app = createApp({ runtime: { repoRoot, health: { state: 'ready' }, transactionOptions: {} } as never }).app;
});

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

function projectOf(): ProjectDefinition {
  return JSON.parse(readFileSync(join(repoRoot, PROJECT_PATH), 'utf8')) as ProjectDefinition;
}

function sceneOf(): SceneDefinition {
  return projectOf().scenes[0]!;
}

function projectBytes(): string {
  return readFileSync(join(repoRoot, PROJECT_PATH), 'utf8');
}

function reportFiles(): string[] {
  const dir = join(repoRoot, 'reports/apply');
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

function transactionDirs(): string[] {
  const dir = join(repoRoot, '.chamber-transactions');
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

function session(project = projectOf()) {
  const scene = project.scenes[0]!;
  const characterIds = new Set(project.characters.map((entry) => entry.id));
  return new DocumentEditSession<SceneDefinition, SceneOperation>({
    target: { kind: 'scene', id: scene.id },
    baseRevisionId: project.revisionId,
    document: scene,
    apply: (document, operation) => applySceneOperation(document, operation, project),
    validate: (document) => validateSceneReferences(document, characterIds),
  });
}

async function post(body: unknown) {
  const response = await app.request('/api/repository/apply', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** A structurally complete request, for tests that vary exactly one thing. */
function validRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    target: { kind: 'scene', id: sceneOf().id },
    expected: { projectRevisionId: projectOf().revisionId },
    operations: [],
    actor: 'human',
    intent: 'a complete request',
    ...overrides,
  };
}

function issuesOf(body: Record<string, unknown>): { path: string; message: string; keyword: string }[] {
  return (body.issues ?? []) as { path: string; message: string; keyword: string }[];
}

const placeLight: SceneOperation = {
  type: 'scene.place_asset',
  entityId: 'key-light',
  displayName: 'Key light',
  asset: { kind: 'light', lightType: 'directional' },
};

describe('preview and stage do not write', () => {
  it('leaves the repository byte-identical through dispatch and stage', () => {
    const before = projectBytes();
    const s = session();
    s.dispatch(placeLight);
    s.stageAll();
    expect(s.stagedPaths).toEqual(['/entities/key-light']);
    expect(projectBytes()).toBe(before);
  });
});

describe('apply writes', () => {
  it('persists the staged entity and returns the new canonical documents', async () => {
    const s = session();
    s.dispatch(placeLight);
    s.stageAll();

    const { status, body } = await post(s.buildApplyRequest('place a key light'));
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.status).toBe('applied');
    expect(body.changedPaths).toEqual(['/entities/key-light']);

    const persisted = sceneOf().entities.find((entity) => entity.id === 'key-light');
    expect(persisted).toBeDefined();
    expect(persisted!.kind).toBe('light');
  });

  it('bumps the project revision so the next session opens against it', async () => {
    const before = projectOf().revisionId;
    const s = session();
    s.dispatch(placeLight);
    s.stageAll();
    await post(s.buildApplyRequest('place a key light'));
    expect(projectOf().revisionId).not.toBe(before);
  });

  it('writes a machine-readable report that claims no git commit', async () => {
    const s = session();
    s.dispatch(placeLight);
    s.stageAll();
    const { body } = await post(s.buildApplyRequest('place a key light'));

    const report = JSON.parse(readFileSync(join(repoRoot, body.reportPath as string), 'utf8')) as {
      operations: string[];
      intent: string;
      applyId: string;
      commitSha?: string;
      protectionApproval?: unknown;
    };
    expect(report.operations).toEqual(['scene.place_asset']);
    expect(report.intent).toBe('place a key light');
    expect(report.applyId).toBe(body.applyId);
    // No protected path was touched, so there is no approval to record. An
    // approval field on an unprotected Apply would be evidence of a decision
    // nobody made.
    expect(report.protectionApproval).toBeUndefined();
    // Apply is not a commit; a report that invented a SHA before one existed
    // would be the most convincing possible form of a fabricated result.
    expect(report.commitSha).toBeUndefined();
  });

  it('does not create a git commit', async () => {
    const s = session();
    s.dispatch(placeLight);
    s.stageAll();
    await post(s.buildApplyRequest('place a key light'));

    const head = await app.request('/api/git/head');
    const headBody = (await head.json()) as { commits?: unknown[] };
    // The fake git adapter records commits it was asked to make; Apply asked
    // for none.
    expect(headBody.commits ?? []).toHaveLength(0);
  });
});

/**
 * The endpoint receives JSON. Every case below is one a well-behaved client
 * cannot produce and a direct POST can, which is exactly why the server has to
 * answer them — and answer them before it reads a canonical byte.
 */
describe('request schema', () => {
  it('accepts a complete, well-formed request', async () => {
    const { status, body } = await post(
      validRequest({ operations: [placeLight], intent: 'place a key light' }),
    );
    expect(status).toBe(200);
    expect(body.status).toBe('applied');
  });

  it.each([
    ['an unknown top-level property', () => validRequest({ mode: 'force' })],
    ['an unknown target property', () => validRequest({ target: { kind: 'scene', id: 'x', label: 'y' } })],
    ['an unknown expected property', () => validRequest({ expected: { projectRevisionId: 'r', at: 1 } })],
    ['a missing expected revision', () => validRequest({ expected: {} })],
    ['a missing target', () => validRequest({ target: undefined })],
    ['a missing operations array', () => validRequest({ operations: undefined })],
    ['operations that are not an array', () => validRequest({ operations: 'all of them' })],
    ['an unknown actor', () => validRequest({ actor: 'robot' })],
    ['a missing actor', () => validRequest({ actor: undefined })],
    ['a non-string intent', () => validRequest({ intent: 42 })],
    ['a blank intent', () => validRequest({ intent: '   ' })],
    ['a non-object target', () => validRequest({ target: 'scene' })],
    ['an unknown target kind', () => validRequest({ target: { kind: 'material', id: 'x' } })],
    /*
     * `unlockedPaths` and `approved` were the previous network contract. They
     * are refused now rather than ignored: a caller still sending them believes
     * it is authorising something, and silently dropping the field would apply
     * the change with no authorisation while looking like it honoured one.
     */
    ['a legacy unlockedPaths field', () => validRequest({ unlockedPaths: ['/displayName'] })],
    ['a legacy approved flag', () => validRequest({ approved: true })],
    ['a client-supplied changedPaths', () => validRequest({ changedPaths: ['/displayName'] })],
    ['a malformed approval', () => validRequest({ approval: { approvedPaths: '/a', reason: 'r' } })],
    ['an approval with an unknown property', () => validRequest({ approval: { approvedPaths: [], reason: 'r', force: true } })],
    ['an approval with a duplicate path', () => validRequest({ approval: { approvedPaths: ['/a', '/a'], reason: 'r' } })],
    ['an approval with a blank reason', () => validRequest({ approval: { approvedPaths: ['/a'], reason: '  ' } })],
    ['an approval with a missing reason', () => validRequest({ approval: { approvedPaths: ['/a'] } })],
    ['an approval path that is not a canonical path', () => validRequest({ approval: { approvedPaths: ['entities/a'], reason: 'r' } })],
    ['an unknown operation type', () => validRequest({ operations: [{ type: 'scene.set_matereal', entityId: 'x' }] })],
    ['an operation with an unknown field', () => validRequest({ operations: [{ ...placeLight, entityIdd: 'typo' }] })],
    ['an operation missing a required field', () => validRequest({ operations: [{ type: 'scene.rename_entity', entityId: 'ground' }] })],
    ['a generic path/value command', () => validRequest({ operations: [{ path: '/displayName', value: 'x' }] })],
  ])('refuses %s with 400 and no write', async (_label, build) => {
    const before = projectBytes();
    const result = await post(build());

    expect(result.status).toBe(400);
    expect(result.body.ok).toBe(false);
    expect(issuesOf(result.body).length).toBeGreaterThan(0);
    expect(projectBytes()).toBe(before);
    expect(reportFiles()).toEqual([]);
    expect(transactionDirs()).toEqual([]);
  });

  /*
   * `JSON.stringify` cannot produce this, which is the point: a raw body can.
   * `1e999` is valid JSON that `JSON.parse` turns into `Infinity`, and an
   * Infinity that reached a transform would serialise back out as `null` and
   * quietly corrupt the scene.
   */
  it('refuses a raw payload whose number parses to Infinity', async () => {
    const before = projectBytes();
    const response = await app.request('/api/repository/apply', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(
        validRequest({
          operations: [
            {
              type: 'scene.set_transform',
              entityId: sceneOf().entities[0]!.id,
              transform: {
                position: { x: '__INF__', y: 0, z: 0 },
                rotation: { x: 0, y: 0, z: 0, w: 1 },
                scale: { x: 1, y: 1, z: 1 },
              },
            },
          ],
        }),
      ).replace('"__INF__"', '1e999'),
    });

    expect(response.status).toBe(400);
    expect(projectBytes()).toBe(before);
    expect(reportFiles()).toEqual([]);
  });

  it('names an unknown operation type rather than dumping the union', async () => {
    const { body } = await post(
      validRequest({ operations: [{ type: 'scene.set_matereal', entityId: 'x' }] }),
    );
    expect(issuesOf(body)[0]!.message).toContain('scene.set_matereal');
    expect(issuesOf(body)[0]!.path).toMatch(/^\/operations\/0/);
  });

  it('names the unknown target kind rather than dumping the union', async () => {
    const { body } = await post(validRequest({ target: { kind: 'material', id: 'x' } }));
    expect(issuesOf(body)[0]!.path).toBe('/target/kind');
    expect(issuesOf(body)[0]!.message).toContain('material');
  });

  it('refuses a body that is not JSON at all', async () => {
    const response = await app.request('/api/repository/apply', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });
    expect(response.status).toBe(400);
  });

  it('refuses a JSON body that is not an object', async () => {
    const { status } = await post([1, 2, 3]);
    expect(status).toBe(400);
  });

  it('refuses a character target as unsupported, not as malformed', async () => {
    const { status, body } = await post(
      validRequest({ target: { kind: 'character', id: 'demo-humanoid' } }),
    );
    expect(status).toBe(400);
    // Structurally valid; this endpoint just does not apply it yet. The
    // distinction matters to a caller trying to find a typo they did not make.
    expect(issuesOf(body)[0]!.keyword).toBe('unsupported');
  });

  it('refuses an unknown scene id rather than falling back to the first scene', async () => {
    const { status } = await post(
      validRequest({ target: { kind: 'scene', id: 'no-such-scene' }, operations: [placeLight] }),
    );
    expect(status).toBe(404);
  });
});

/**
 * Protection that only the browser enforces is not protection: `curl` does not
 * run the browser session, and the endpoint is reachable without it.
 */
describe('exact-path protection approval', () => {
  /** Protects the first entity of the canonical scene, on disk. */
  function protectFirstEntity(level: 'locked' | 'approval-required' | 'invariant'): string {
    const project = projectOf();
    const scene = project.scenes[0]!;
    const entity = scene.entities[0]!;
    const guarded = {
      ...project,
      scenes: [
        {
          ...scene,
          entities: [{ ...entity, protection: { level, reason: 'test fixture' } }, ...scene.entities.slice(1)],
        },
        ...project.scenes.slice(1),
      ],
    };
    writeFileSync(join(repoRoot, PROJECT_PATH), `${JSON.stringify(guarded, null, 2)}\n`, 'utf8');
    return entity.id;
  }

  function renameEntity(entityId: string, displayName: string): SceneOperation {
    return { type: 'scene.rename_entity', entityId, displayName };
  }

  it('refuses an AI edit to a locked path, with no browser session involved', async () => {
    const entityId = protectFirstEntity('locked');
    const before = projectBytes();

    const { status, body } = await post(
      validRequest({
        operations: [renameEntity(entityId, 'Renamed anyway')],
        actor: 'ai',
        intent: 'agent rename of a locked entity',
      }),
    );

    expect(status).toBe(403);
    expect(issuesOf(body)[0]!.keyword).toBe('protection');
    expect(projectBytes()).toBe(before);
  });

  it('refuses an AI edit to an approval-required path', async () => {
    const entityId = protectFirstEntity('approval-required');
    const { status, body } = await post(
      validRequest({
        operations: [renameEntity(entityId, 'Renamed by an agent')],
        actor: 'ai',
        intent: 'agent rename',
      }),
    );
    expect(status).toBe(403);
    expect(issuesOf(body)[0]!.keyword).toBe('approval-required');
  });

  /*
   * An approval an AI grants itself is not an approval. Refused rather than
   * ignored: a caller that believed it had approved something has to be told it
   * did not, and a silently ignored field looks identical to an honoured one.
   */
  it('refuses an AI request that carries its own approval', async () => {
    const entityId = protectFirstEntity('approval-required');
    const { status, body } = await post(
      validRequest({
        operations: [renameEntity(entityId, 'Self-approved')],
        actor: 'ai',
        intent: 'agent rename with a self-granted approval',
        approval: {
          approvedPaths: [`/entities/${entityId}/displayName`],
          reason: 'the agent is confident',
        },
      }),
    );
    expect(status).toBe(403);
    expect(issuesOf(body)[0]!.message).toContain('AI actor');
  });

  it('refuses a human protected edit that carries no approval', async () => {
    const entityId = protectFirstEntity('locked');
    const before = projectBytes();

    const { status, body } = await post(
      validRequest({
        operations: [renameEntity(entityId, 'No approval')],
        intent: 'rename a locked entity without approving it',
      }),
    );

    expect(status).toBe(403);
    expect(issuesOf(body)[0]!.keyword).toBe('approval-required');
    // The message names the exact path that needs approving, so the caller can
    // build the approval without guessing what the server computed.
    expect(issuesOf(body)[0]!.message).toContain(`/entities/${entityId}/displayName`);
    expect(projectBytes()).toBe(before);
  });

  it('accepts a human protected edit whose approval names exactly the protected path', async () => {
    const entityId = protectFirstEntity('locked');
    const { status, body } = await post(
      validRequest({
        operations: [renameEntity(entityId, 'Approved and renamed')],
        intent: 'rename a locked entity',
        approval: {
          approvedPaths: [`/entities/${entityId}/displayName`],
          reason: 'the display name was agreed in review',
        },
      }),
    );

    expect(status).toBe(200);
    expect(body.status).toBe('applied');
    expect(sceneOf().entities[0]!.displayName).toBe('Approved and renamed');
  });

  it('records the exact approved paths and reason in the report', async () => {
    const entityId = protectFirstEntity('locked');
    const { body } = await post(
      validRequest({
        operations: [renameEntity(entityId, 'Approved and renamed')],
        intent: 'rename a locked entity',
        approval: {
          approvedPaths: [`/entities/${entityId}/displayName`],
          reason: 'the display name was agreed in review',
        },
      }),
    );

    const report = JSON.parse(readFileSync(join(repoRoot, body.reportPath as string), 'utf8')) as {
      protectionApproval?: { approvedPaths: string[]; reason: string };
      approved?: unknown;
    };
    expect(report.protectionApproval).toEqual({
      approvedPaths: [`/entities/${entityId}/displayName`],
      reason: 'the display name was agreed in review',
    });
    // Never a bare boolean: it names nothing and can be checked against nothing.
    expect(report.approved).toBeUndefined();
  });

  it('refuses an approval that misses one of the protected paths', async () => {
    const entityId = protectFirstEntity('locked');
    const before = projectBytes();

    const { status, body } = await post(
      validRequest({
        operations: [
          renameEntity(entityId, 'Renamed'),
          { type: 'scene.set_enabled', entityId, enabled: false },
        ],
        intent: 'two protected changes, one approved',
        approval: {
          approvedPaths: [`/entities/${entityId}/displayName`],
          reason: 'only approved the rename',
        },
      }),
    );

    expect(status).toBe(403);
    expect(issuesOf(body)[0]!.keyword).toBe('approval-mismatch');
    expect(projectBytes()).toBe(before);
    expect(reportFiles()).toEqual([]);
  });

  it('refuses an approval carrying an extra path the operations never touched', async () => {
    const entityId = protectFirstEntity('locked');
    const { status, body } = await post(
      validRequest({
        operations: [renameEntity(entityId, 'Renamed')],
        intent: 'approve more than this Apply does',
        approval: {
          approvedPaths: [`/entities/${entityId}/displayName`, '/entities/some-other/transform'],
          reason: 'approving generously',
        },
      }),
    );
    expect(status).toBe(403);
    expect(issuesOf(body)[0]!.keyword).toBe('approval-mismatch');
  });

  it('refuses a prefix approval standing in for an exact path', async () => {
    const entityId = protectFirstEntity('locked');
    const { status } = await post(
      validRequest({
        operations: [renameEntity(entityId, 'Renamed')],
        intent: 'approve by prefix',
        approval: { approvedPaths: [`/entities/${entityId}`], reason: 'approving the whole entity' },
      }),
    );
    expect(status).toBe(403);
  });

  it('refuses an approval on an Apply that changes nothing protected', async () => {
    const { status, body } = await post(
      validRequest({
        operations: [placeLight],
        intent: 'approve an unprotected change',
        approval: { approvedPaths: ['/entities/key-light'], reason: 'unnecessary approval' },
      }),
    );
    expect(status).toBe(403);
    expect(issuesOf(body)[0]!.path).toBe('/approval');
  });

  it('refuses an invariant edit that no approval can authorise', async () => {
    const entityId = protectFirstEntity('invariant');
    const { status, body } = await post(
      validRequest({
        operations: [renameEntity(entityId, 'Renamed anyway')],
        intent: 'change a project invariant',
        approval: {
          approvedPaths: [`/entities/${entityId}/displayName`],
          reason: 'approving an invariant',
        },
      }),
    );
    // An invariant a sufficiently insistent caller can talk past is not one.
    expect(status).toBe(403);
    expect(issuesOf(body)[0]!.keyword).toBe('protection');
  });
});

/**
 * Applying twice without reloading the page is the ordinary case, not an edge
 * one — and it is the first thing a stale session revision breaks.
 */
describe('repeated apply from one session', () => {
  it('accepts the second apply after the session adopts the applied revision', async () => {
    const s = session();
    s.dispatch(placeLight);
    s.stageAll();
    const first = await post(s.buildApplyRequest('place a key light'));
    expect(first.status).toBe(200);

    s.acceptApplied(
      first.body.targetDocument as SceneDefinition,
      (first.body.project as ProjectDefinition).revisionId,
    );

    s.dispatch({ type: 'scene.rename_entity', entityId: 'key-light', displayName: 'Rim light' });
    s.stageAll();
    const second = await post(s.buildApplyRequest('rename the light'));
    expect(second.status).toBe(200);
    expect(sceneOf().entities.find((entity) => entity.id === 'key-light')!.displayName).toBe(
      'Rim light',
    );
  });
});

/**
 * An Apply whose operations produce the document that is already on disk is a
 * success that writes nothing. Minting a revision for it would invalidate every
 * other open session in exchange for no change at all.
 */
describe('no-change apply', () => {
  it('reports no-change, writes no file, no report and no transaction', async () => {
    const before = projectBytes();
    const revisionBefore = projectOf().revisionId;
    const scene = sceneOf();

    const { status, body } = await post(
      validRequest({
        operations: [{ type: 'scene.rename', displayName: scene.displayName }],
        intent: 'rename the scene to the name it already has',
      }),
    );

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    // Its own status, never `applied`: the caller asked what their button did,
    // and "nothing" is the true answer.
    expect(body.status).toBe('no-change');
    expect(body.changedPaths).toEqual([]);
    expect(body.reportPath).toBeUndefined();
    expect(body.applyId).toBeUndefined();

    expect(projectBytes()).toBe(before);
    expect(projectOf().revisionId).toBe(revisionBefore);
    expect(reportFiles()).toEqual([]);
    expect(transactionDirs()).toEqual([]);
  });

  it('treats an empty operation list as no-change', async () => {
    const before = projectBytes();
    const { status, body } = await post(validRequest({ intent: 'apply nothing at all' }));

    expect(status).toBe(200);
    expect(body.status).toBe('no-change');
    expect(projectBytes()).toBe(before);
    expect(reportFiles()).toEqual([]);
  });

  it('treats setting a transform to its existing value as no-change', async () => {
    const before = projectBytes();
    const entity = sceneOf().entities[0]!;

    const { status, body } = await post(
      validRequest({
        operations: [
          { type: 'scene.set_transform', entityId: entity.id, transform: entity.transform },
        ],
        intent: 'set the transform it already has',
      }),
    );

    expect(status).toBe(200);
    expect(body.status).toBe('no-change');
    expect(projectBytes()).toBe(before);
  });
});

describe('revision conflict', () => {
  it('refuses a stale baseline instead of overwriting', async () => {
    const s = session();
    s.dispatch(placeLight);
    s.stageAll();
    const request = s.buildApplyRequest('place a key light');

    // Something else moves the repository forward underneath the session.
    const moved = { ...projectOf(), revisionId: 'moved-on-externally' };
    writeFileSync(join(repoRoot, PROJECT_PATH), `${JSON.stringify(moved, null, 2)}\n`, 'utf8');
    const beforeApply = projectBytes();

    const { status, body } = await post(request);
    expect(status).toBe(409);
    expect(body.ok).toBe(false);
    expect(body.status).toBe('conflict');
    expect(issuesOf(body)[0]!.keyword).toBe('conflict');
    expect(issuesOf(body)[0]!.message).toContain('moved-on-externally');

    // No overwrite, and the staged work is still the caller's to resubmit.
    expect(projectBytes()).toBe(beforeApply);
    expect(s.staged).toHaveLength(1);
  });
});

describe('server-side validation', () => {
  it('refuses an operation the server cannot validate, leaving the repository alone', async () => {
    const before = projectBytes();
    const { status, body } = await post(
      validRequest({
        operations: [
          {
            type: 'scene.place_asset',
            entityId: 'ghost',
            displayName: 'Ghost',
            asset: { kind: 'character', characterId: 'no-such-character' },
          },
        ],
        actor: 'ai',
        intent: 'place a character that does not exist',
      }),
    );

    expect(status).toBe(422);
    expect(body.ok).toBe(false);
    expect(body.status).toBe('invalid');
    // The issue names which operation failed, not just that something did.
    expect(issuesOf(body)[0]!.path).toMatch(/^\/operations\/0\//);
    expect(projectBytes()).toBe(before);
  });
});

/**
 * Canonical content revisions repeat, legitimately: A → B → A returns to the
 * bytes A already had, and identical content must carry identical identity.
 * The report cannot be identified by that, or the second transition to a
 * content state collides with the first.
 */
describe('apply report identity', () => {
  async function rename(displayName: string, project = projectOf()) {
    return post({
      target: { kind: 'scene', id: project.scenes[0]!.id },
      expected: { projectRevisionId: project.revisionId },
      operations: [{ type: 'scene.rename', displayName }],
      actor: 'human',
      intent: `rename the scene to ${displayName}`,
    });
  }

  it('survives a content revision returning to a previous value', async () => {
    const original = sceneOf().displayName;

    const first = await rename('B');
    expect(first.status).toBe(200);
    const revisionB = projectOf().revisionId;

    const second = await rename(original);
    expect(second.status).toBe(200);

    // The third Apply reaches exactly the bytes the first one produced.
    const third = await rename('B');
    expect(third.status).toBe(200);
    expect(third.body.status).toBe('applied');

    // Identical content, identical content-derived revision. That is the point.
    expect(projectOf().revisionId).toBe(revisionB);

    // Three Applies, three distinct reports, all still readable.
    const reports = reportFiles();
    expect(reports).toHaveLength(3);
    expect(new Set(reports).size).toBe(3);
    for (const file of reports) {
      const report = JSON.parse(
        readFileSync(join(repoRoot, 'reports/apply', file), 'utf8'),
      ) as { applyId: string };
      expect(report.applyId).toBeTruthy();
    }

    // Three distinct apply identities for three distinct events.
    const applyIds = [first, second, third].map((result) => result.body.applyId);
    expect(new Set(applyIds).size).toBe(3);
  });

  it('does not let the apply identity leak into the canonical revision', async () => {
    const original = sceneOf().displayName;
    await rename('B');
    const revisionB = projectOf().revisionId;
    await rename(original);
    await rename('B');

    // If `applyId` or a timestamp were folded into the revision hash, the same
    // content would carry a different revision every time it was reached.
    expect(projectOf().revisionId).toBe(revisionB);
  });
});
