import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import type { ProjectDefinition, ResolvedProject } from '@atc/schema';
import { validateProject, validateProjectReferences } from '@atc/schema';
import { analyzeDiff } from '@atc/runtime-core';
import { buildCommitDraft } from '@atc/editor-core';
import {
  GitConflictError,
  ProtectedBranchError,
  sessionBranchName,
} from '@atc/git-adapter';
import { REPLAY_FIXTURES, runReplay } from '@atc/replay-runtime';
import { TERRAIN_PRESETS, findTerrainPreset } from '@atc/terrain-runtime';
import { buildUnityBundle } from '@atc/unity-export';
import {
  canCommitRawAsset,
  importAsset,
  promoteCandidate,
  unknownLicenseManifest,
} from '@atc/acquisition-core';
import {
  createContext,
  loadProject,
  loadResolvedProject,
  saveProject,
  PROJECT_PATH,
  REPO_ROOT,
} from './context.ts';
import { recoverRepository } from '@atc/repository-transaction';
import { animationAssetRoutes } from './routes/animation-assets.ts';

const context = createContext();
const app = new Hono();

/**
 * Resolve any repository transaction a previous process crashed in the
 * middle of, before this one accepts a single write (PLAN Part I §9). If a
 * transaction could not be fully rolled back, writes are refused rather than
 * risking a second one landing on top of an already-inconsistent repository.
 */
const startupRecovery = recoverRepository(REPO_ROOT);
if (startupRecovery.transactions.length > 0) {
  console.log(
    `[repository-transaction] startup recovery resolved ${startupRecovery.transactions.length} ` +
      `transaction(s): ${startupRecovery.transactions.map((t) => `${t.transactionId}=${t.outcome}`).join(', ')}`,
  );
}
const repositoryReadOnly = startupRecovery.readOnly;
if (repositoryReadOnly) {
  console.error(
    '[repository-transaction] one or more transactions could not be fully rolled back; ' +
      'the write API is disabled until a human resolves .chamber-transactions/',
  );
}

// The web dev server runs on a different port; nothing here is authenticated,
// so it is bound to localhost only (see serve() below).
app.use('/api/*', cors({ origin: ['http://localhost:5173', 'http://127.0.0.1:5173'] }));

app.use('/api/*', async (c, next) => {
  if (repositoryReadOnly && c.req.method !== 'GET') {
    return c.json(
      {
        error:
          'the repository is in read-only mode: a prior transaction could not be fully rolled back ' +
          'and needs manual resolution under .chamber-transactions/',
      },
      503,
    );
  }
  await next();
});

app.get('/api/health', (c) =>
  c.json({
    ok: true,
    gitAdapter: context.git.kind,
    gitConfigured: context.gitConfigured,
    aiProvider: context.ai.id,
    aiRequiresApiKey: context.ai.requiresApiKey,
    animationWorker: context.worker.available ? 'available' : 'unavailable',
    protectedBranch: context.git.protectedBranch,
  }),
);

app.get('/api/project', (c) => {
  try {
    return c.json({ project: loadProject() });
  } catch (error) {
    return c.json({ error: message(error) }, 500);
  }
});

app.get('/api/terrain-presets', (c) => c.json({ presets: TERRAIN_PRESETS }));

/** The resolved document for one character, which is what the runtime wants. */
app.get('/api/resolved-project', (c) => {
  try {
    return c.json({
      project: loadResolvedProject({
        ...(c.req.query('characterId') ? { characterId: c.req.query('characterId')! } : {}),
        ...(c.req.query('contextKey') ? { contextKey: c.req.query('contextKey')! } : {}),
      }),
    });
  } catch (error) {
    return c.json({ error: message(error) }, 500);
  }
});

app.route('/', animationAssetRoutes());

app.get('/api/replays', (c) => c.json({ replays: REPLAY_FIXTURES }));

app.post('/api/validate', async (c) => {
  const body = await c.req.json<{ document: unknown }>();
  const schemaResult = validateProject(body.document);
  const referenceResult = validateProjectReferences(body.document);
  return c.json({
    valid: schemaResult.valid && referenceResult.valid,
    issues: [...schemaResult.issues, ...referenceResult.issues],
  });
});

/** Runs a replay against a submitted document, for before/after comparison. */
app.post('/api/replay/run', async (c) => {
  const body = await c.req.json<{ document?: ResolvedProject; replayId: string; terrainPresetId?: string; characterId?: string; contextKey?: string }>();
  try {
    const project = body.document ?? loadResolvedProject(resolveOptions(body));
    const replay = REPLAY_FIXTURES.find((entry) => entry.id === body.replayId);
    if (!replay) return c.json({ error: `unknown replay "${body.replayId}"` }, 404);
    const terrain = body.terrainPresetId ? findTerrainPreset(body.terrainPresetId) : undefined;
    return c.json({ trace: runReplay(project, replay, terrain) });
  } catch (error) {
    return c.json({ error: message(error) }, 400);
  }
});

app.post('/api/ai/propose', async (c) => {
  const body = await c.req.json<{
    document?: ResolvedProject;
    request: string;
    targetPath: string;
    replayId?: string;
    terrainPresetId?: string;
    characterId?: string;
    contextKey?: string;
  }>();
  try {
    const project = body.document ?? loadResolvedProject(resolveOptions(body));
    const proposals = await context.ai.proposeAdjustments({
      project,
      request: body.request,
      targetPath: body.targetPath,
      ...(body.replayId ? { replayId: body.replayId } : {}),
      ...(body.terrainPresetId ? { terrainPresetId: body.terrainPresetId } : {}),
    });
    return c.json({ provider: context.ai.id, proposals });
  } catch (error) {
    return c.json({ error: message(error) }, 400);
  }
});

app.post('/api/ai/harmonize', async (c) => {
  const body = await c.req.json<{ document?: ResolvedProject; targetPath: string; request?: string; characterId?: string; contextKey?: string }>();
  try {
    const project = body.document ?? loadResolvedProject(resolveOptions(body));
    const patch = await context.ai.harmonizeRelatedTransitions({
      project,
      request: body.request ?? '',
      targetPath: body.targetPath,
    });
    return c.json({ provider: context.ai.id, patch });
  } catch (error) {
    return c.json({ error: message(error) }, 400);
  }
});

app.post('/api/ai/explain', async (c) => {
  const body = await c.req.json<{ document: ResolvedProject }>();
  try {
    const repository = loadResolvedProject();
    const diff = analyzeDiff(repository, body.document);
    return c.json({ explanation: await context.ai.explainDiff(diff), diff });
  } catch (error) {
    return c.json({ error: message(error) }, 400);
  }
});

app.get('/api/git/head', async (c) => {
  const branch = c.req.query('branch') ?? context.git.protectedBranch;
  try {
    return c.json({ ...(await context.git.getHead(branch)), branch });
  } catch (error) {
    return c.json({ error: message(error) }, 500);
  }
});

/**
 * Commits a tuning session.
 *
 * The server re-derives the diff from the canonical file on disk and re-runs the
 * protection policy. The browser's opinion about what is allowed is never
 * trusted: a client that skipped its own checks still cannot land a locked value.
 */
app.post('/api/commit', async (c) => {
  const body = await c.req.json<{
    document: ProjectDefinition;
    baseSha: string;
    sessionId: string;
    author?: string;
    intent?: string;
    acknowledgeWarnings?: boolean;
  }>();

  try {
    const repository = loadProject();

    const schemaResult = validateProject(body.document);
    const referenceResult = validateProjectReferences(body.document);
    if (!schemaResult.valid || !referenceResult.valid) {
      return c.json(
        {
          error: 'document failed validation',
          issues: [...schemaResult.issues, ...referenceResult.issues],
        },
        400,
      );
    }

    const diff = analyzeDiff(repository, body.document);
    if (!diff.commitAllowed) {
      return c.json(
        {
          error: 'commit refused by diff policy',
          findings: diff.findings.filter((finding) => finding.severity === 'blocking'),
        },
        409,
      );
    }
    if (diff.changes.length === 0) {
      return c.json({ error: 'nothing to commit' }, 400);
    }

    const draft = buildCommitDraft({
      document: body.document,
      diff,
      author: body.author ?? 'chamber-user',
      ...(body.intent ? { intent: body.intent } : {}),
      parentRevisionId: repository.revisionId,
    });

    const branch = sessionBranchName(repository.id, body.sessionId);
    const result = await context.git.commit({
      branch,
      baseSha: body.baseSha,
      message: draft.message,
      body: draft.body,
      files: [
        { path: PROJECT_PATH, content: `${JSON.stringify(draft.document, null, 2)}\n` },
      ],
    });

    saveProject(draft.document);

    return c.json({
      commit: result,
      revision: draft.revision,
      message: draft.message,
      body: draft.body,
      document: draft.document,
      warnings: diff.findings.filter((finding) => finding.severity === 'warning'),
    });
  } catch (error) {
    if (error instanceof ProtectedBranchError) {
      return c.json({ error: error.message, kind: 'protected-branch' }, 403);
    }
    if (error instanceof GitConflictError) {
      return c.json(
        {
          error: error.message,
          kind: 'conflict',
          expectedSha: error.expectedSha,
          actualSha: error.actualSha,
          conflicts: error.conflicts,
        },
        409,
      );
    }
    return c.json({ error: message(error) }, 500);
  }
});

app.post('/api/pull-request', async (c) => {
  const body = await c.req.json<{ sessionId: string; title: string; body: string }>();
  try {
    const repository = loadProject();
    const branch = sessionBranchName(repository.id, body.sessionId);
    const result = await context.git.createPullRequest({
      branch,
      baseBranch: context.git.protectedBranch,
      title: body.title,
      body: body.body,
    });
    return c.json({ pullRequest: result, adapter: context.git.kind });
  } catch (error) {
    return c.json({ error: message(error) }, 500);
  }
});

app.post('/api/acquisition/import', async (c) => {
  const body = await c.req.json<{
    filename: string;
    /** base64 file contents */
    content: string;
    license?: Partial<ReturnType<typeof unknownLicenseManifest>>;
    replacesClipId?: string;
    repositoryIsPublic?: boolean;
  }>();

  try {
    const bytes = new Uint8Array(Buffer.from(body.content, 'base64'));
    const contentHash = createHash('sha256').update(bytes).digest('hex');

    const license = {
      ...unknownLicenseManifest({
        provider: 'manual-import',
        sourceType: 'import',
        sourceRef: body.filename,
        acquiredBy: 'chamber-user',
      }),
      ...body.license,
    };

    const result = importAsset({
      filename: body.filename,
      bytes,
      license,
      contentHash,
      ...(body.replacesClipId ? { replacesClipId: body.replacesClipId } : {}),
    });

    if (result.pendingJob) {
      const job = await context.worker.submit({
        format: result.pendingJob.format,
        filename: result.pendingJob.filename,
        contentHash: result.pendingJob.contentHash,
        options: {
          targetFps: 60,
          targetSkeletonId: 'canonical-humanoid',
          extractRootMotion: true,
          upAxis: 'y',
          unitScale: 1,
        },
      });
      return c.json({ candidate: null, pendingJob: result.pendingJob, job, errors: result.errors });
    }

    const rawAssetDecision = canCommitRawAsset(license, {
      repositoryIsPublic: body.repositoryIsPublic ?? true,
    });

    return c.json({
      candidate: result.candidate,
      pendingJob: null,
      errors: result.errors,
      rawAssetCommit: rawAssetDecision,
    });
  } catch (error) {
    return c.json({ error: message(error) }, 400);
  }
});

app.post('/api/acquisition/promote', async (c) => {
  const body = await c.req.json<{
    document?: ResolvedProject;
    candidateId: string;
    to: Parameters<typeof promoteCandidate>[2];
    actor?: 'human' | 'ai';
  }>();
  try {
    const project = body.document ?? loadResolvedProject();
    const result = promoteCandidate(project, body.candidateId, body.to, body.actor ?? 'human');
    return c.json(result, result.ok ? 200 : 409);
  } catch (error) {
    return c.json({ error: message(error) }, 400);
  }
});

app.post('/api/unity/export', async (c) => {
  try {
    const body = await c.req
      .json<{ document?: ResolvedProject }>()
      .catch(() => ({}) as { document?: ResolvedProject });
    const project = body.document ?? loadResolvedProject();
    const files = buildUnityBundle(project, REPLAY_FIXTURES);

    const outputRoot = resolve(REPO_ROOT, 'generated/unity');
    for (const file of files) {
      const target = resolve(outputRoot, file.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, file.content, 'utf8');
    }

    return c.json({
      outputDirectory: 'generated/unity',
      fileCount: files.length,
      files: files.map((file) => file.path),
    });
  } catch (error) {
    return c.json({ error: message(error) }, 500);
  }
});

/** Character and weapon context a request may pin its resolution to. */
function resolveOptions(body: { characterId?: string; contextKey?: string }): {
  characterId?: string;
  contextKey?: string;
} {
  return {
    ...(body.characterId ? { characterId: body.characterId } : {}),
    ...(body.contextKey ? { contextKey: body.contextKey } : {}),
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const port = Number(process.env.API_PORT ?? 8787);

// Bound to loopback: the server mints GitHub installation tokens and must not be
// reachable from the network.
serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, (info) => {
  console.log(`[api] listening on http://127.0.0.1:${info.port}`);
  console.log(`[api] git adapter: ${context.git.kind}${context.gitConfigured ? '' : ' (no GitHub App configured)'}`);
  console.log(`[api] ai provider: ${context.ai.id}`);
  console.log(`[api] animation worker: ${context.worker.available ? 'available' : 'unavailable'}`);
});

export { app };
