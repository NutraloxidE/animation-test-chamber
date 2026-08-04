/**
 * `POST /api/repository/apply`, over real HTTP handlers against a real
 * temporary checkout.
 *
 * The four properties worth proving are the four separations the whole editing
 * model rests on, and none of them can be checked against a mock filesystem:
 * a preview does not write, a stage does not write, an apply writes atomically
 * and validated, and a stale baseline is refused rather than overwritten.
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

const placeLight: SceneOperation = {
  type: 'scene.place_asset',
  entityId: 'key-light',
  displayName: 'Key light',
  asset: { kind: 'light', lightType: 'directional' },
};

describe('preview and stage do not write', () => {
  it('leaves the repository byte-identical through dispatch and stage', () => {
    const before = readFileSync(join(repoRoot, PROJECT_PATH), 'utf8');
    const s = session();
    s.dispatch(placeLight);
    s.stageAll();
    expect(s.stagedPaths).toEqual(['/entities/key-light']);
    expect(readFileSync(join(repoRoot, PROJECT_PATH), 'utf8')).toBe(before);
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
      commitSha?: string;
    };
    expect(report.operations).toEqual(['scene.place_asset']);
    expect(report.intent).toBe('place a key light');
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
 * Protection that only the browser enforces is not protection: `curl` does not
 * run the browser session, and the endpoint is reachable without it.
 */
describe('server-side protection', () => {
  /** Locks the first entity of the canonical scene, on disk. */
  function lockFirstEntity(level: 'locked' | 'approval-required'): string {
    const project = projectOf();
    const scene = project.scenes[0]!;
    const entity = scene.entities[0]!;
    const locked = {
      ...project,
      scenes: [
        {
          ...scene,
          entities: [{ ...entity, protection: { level, reason: 'test fixture' } }, ...scene.entities.slice(1)],
        },
        ...project.scenes.slice(1),
      ],
    };
    writeFileSync(join(repoRoot, PROJECT_PATH), `${JSON.stringify(locked, null, 2)}\n`, 'utf8');
    return entity.id;
  }

  it('refuses a locked path posted directly, with no browser session involved', async () => {
    const entityId = lockFirstEntity('locked');
    const before = readFileSync(join(repoRoot, PROJECT_PATH), 'utf8');

    const { status, body } = await post({
      target: { kind: 'scene', id: sceneOf().id },
      expected: { projectRevisionId: projectOf().revisionId },
      operations: [{ type: 'scene.rename_entity', entityId, displayName: 'Renamed anyway' }],
      actor: 'human',
      intent: 'rename a locked entity',
    });

    expect(status).toBe(403);
    expect((body.issues as { keyword: string }[])[0]!.keyword).toBe('protection');
    expect(readFileSync(join(repoRoot, PROJECT_PATH), 'utf8')).toBe(before);
  });

  it('refuses an AI edit to an approval-required path', async () => {
    const entityId = lockFirstEntity('approval-required');
    const { status, body } = await post({
      target: { kind: 'scene', id: sceneOf().id },
      expected: { projectRevisionId: projectOf().revisionId },
      operations: [{ type: 'scene.rename_entity', entityId, displayName: 'Renamed by an agent' }],
      actor: 'ai',
      intent: 'agent rename',
    });
    expect(status).toBe(403);
    expect((body.issues as { keyword: string }[])[0]!.keyword).toBe('approval-required');
  });

  /*
   * An approval an AI grants itself is not an approval. Refused rather than
   * ignored: a caller that believed it had approved something has to be told it
   * did not, and a silently ignored field looks identical to an honoured one.
   */
  it('refuses an AI request that carries its own approval', async () => {
    const entityId = lockFirstEntity('approval-required');
    const { status, body } = await post({
      target: { kind: 'scene', id: sceneOf().id },
      expected: { projectRevisionId: projectOf().revisionId },
      operations: [{ type: 'scene.rename_entity', entityId, displayName: 'Self-approved' }],
      actor: 'ai',
      approved: true,
      intent: 'agent rename with a self-granted approval',
    });
    expect(status).toBe(403);
    expect(String((body.issues as { message: string }[])[0]!.message)).toContain('AI actor');
  });

  it('refuses an AI request that carries its own unlocks', async () => {
    const entityId = lockFirstEntity('locked');
    const { status } = await post({
      target: { kind: 'scene', id: sceneOf().id },
      expected: { projectRevisionId: projectOf().revisionId },
      operations: [{ type: 'scene.rename_entity', entityId, displayName: 'Self-unlocked' }],
      actor: 'ai',
      unlockedPaths: [`/entities/${entityId}/displayName`],
      intent: 'agent rename with a self-granted unlock',
    });
    expect(status).toBe(403);
  });

  it('accepts a human edit to a locked path they unlocked in their session', async () => {
    const entityId = lockFirstEntity('locked');
    const { status } = await post({
      target: { kind: 'scene', id: sceneOf().id },
      expected: { projectRevisionId: projectOf().revisionId },
      operations: [{ type: 'scene.rename_entity', entityId, displayName: 'Unlocked and renamed' }],
      actor: 'human',
      unlockedPaths: [`/entities/${entityId}/displayName`],
      intent: 'rename an entity the human unlocked',
    });
    expect(status).toBe(200);
    expect(sceneOf().entities[0]!.displayName).toBe('Unlocked and renamed');
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
  it('reports success, writes no file and creates no report', async () => {
    const before = readFileSync(join(repoRoot, PROJECT_PATH), 'utf8');
    const scene = sceneOf();
    const { status, body } = await post({
      target: { kind: 'scene', id: scene.id },
      expected: { projectRevisionId: projectOf().revisionId },
      operations: [{ type: 'scene.rename', displayName: scene.displayName }],
      actor: 'human',
      intent: 'rename the scene to the name it already has',
    });

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.unchanged).toBe(true);
    expect(body.reportPath).toBeUndefined();
    expect(readFileSync(join(repoRoot, PROJECT_PATH), 'utf8')).toBe(before);
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
    const beforeApply = readFileSync(join(repoRoot, PROJECT_PATH), 'utf8');

    const { status, body } = await post(request);
    expect(status).toBe(409);
    expect(body.ok).toBe(false);
    expect((body.issues as { keyword: string }[])[0]!.keyword).toBe('conflict');
    expect(String((body.issues as { message: string }[])[0]!.message)).toContain(
      'moved-on-externally',
    );

    // No overwrite, and the staged work is still the caller's to resubmit.
    expect(readFileSync(join(repoRoot, PROJECT_PATH), 'utf8')).toBe(beforeApply);
    expect(s.staged).toHaveLength(1);
  });
});

describe('server-side validation', () => {
  it('refuses an operation the server cannot validate, leaving the repository alone', async () => {
    const before = readFileSync(join(repoRoot, PROJECT_PATH), 'utf8');
    const { status, body } = await post({
      target: { kind: 'scene', id: sceneOf().id },
      expected: { projectRevisionId: projectOf().revisionId },
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
    });

    expect(status).toBe(422);
    expect(body.ok).toBe(false);
    // The issue names which operation failed, not just that something did.
    expect((body.issues as { path: string }[])[0]!.path).toMatch(/^\/operations\/0\//);
    expect(readFileSync(join(repoRoot, PROJECT_PATH), 'utf8')).toBe(before);
  });

  /*
   * The client could have assembled a perfectly valid-looking document here.
   * The server does not accept documents — it replays operations — so a client
   * that mis-assembled one is refused rather than believed.
   */
  it('refuses an unknown scene id rather than falling back to the first scene', async () => {
    const { status } = await post({
      target: { kind: 'scene', id: 'no-such-scene' },
      expected: { projectRevisionId: projectOf().revisionId },
      operations: [placeLight],
      actor: 'human',
      intent: 'apply to a scene that does not exist',
    });
    expect(status).toBe(404);
  });

  it('refuses a malformed request', async () => {
    const { status } = await post({ target: { kind: 'scene', id: sceneOf().id } });
    expect(status).toBe(400);
  });

  /*
   * The operation union is a TypeScript type, and TypeScript is not present at
   * runtime. Every case below is one a well-behaved client cannot produce and a
   * direct POST can, which is exactly why the server has to answer them.
   */
  it('refuses an unknown operation type by name', async () => {
    const before = readFileSync(join(repoRoot, PROJECT_PATH), 'utf8');
    const { status, body } = await post({
      target: { kind: 'scene', id: sceneOf().id },
      expected: { projectRevisionId: projectOf().revisionId },
      operations: [{ type: 'scene.set_matereal', entityId: 'x' }],
      actor: 'human',
      intent: 'typo',
    });
    expect(status).toBe(400);
    expect(String((body.issues as { message: string }[])[0]!.message)).toContain(
      'scene.set_matereal',
    );
    expect(readFileSync(join(repoRoot, PROJECT_PATH), 'utf8')).toBe(before);
  });

  it('refuses an operation carrying an unknown field', async () => {
    const { status, body } = await post({
      target: { kind: 'scene', id: sceneOf().id },
      expected: { projectRevisionId: projectOf().revisionId },
      operations: [{ ...placeLight, entityIdd: 'typo' }],
      actor: 'human',
      intent: 'a typo that must not be silently ignored',
    });
    expect(status).toBe(400);
    expect((body.issues as { path: string }[])[0]!.path).toMatch(/^\/operations\/0/);
  });

  it('refuses an operation missing a required field', async () => {
    const { status } = await post({
      target: { kind: 'scene', id: sceneOf().id },
      expected: { projectRevisionId: projectOf().revisionId },
      operations: [{ type: 'scene.rename_entity', entityId: 'ground' }],
      actor: 'human',
      intent: 'rename with no name',
    });
    expect(status).toBe(400);
  });

  it('refuses a body that is not JSON at all', async () => {
    const response = await app.request('/api/repository/apply', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });
    expect(response.status).toBe(400);
  });

  it('refuses a character target here rather than silently applying it', async () => {
    const { status, body } = await post({
      target: { kind: 'character', id: 'demo-humanoid' },
      expected: { projectRevisionId: projectOf().revisionId },
      operations: [],
      actor: 'human',
      intent: 'edit a character',
    });
    expect(status).toBe(400);
    expect((body.issues as { keyword: string }[])[0]!.keyword).toBe('unsupported');
  });
});
