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
