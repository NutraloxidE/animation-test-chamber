import { describe, expect, it, beforeEach } from 'vitest';
import { EditSession, buildCommitDraft } from '@atc/editor-core';
import { FakeGitAdapter, GitConflictError, ProtectedBranchError, sessionBranchName } from '@atc/git-adapter';
import { RuleBasedProvider } from '@atc/ai-adapter';
import { analyzeDiff, getAtPath } from '@atc/runtime-core';
import { buildUnityBundle } from '@atc/unity-export';
import { REPLAY_FIXTURES, compareTraces, findReplayFixture, runReplay } from '@atc/replay-runtime';
import { validateProject, validateResolvedProject } from '@atc/schema';
import { loadDemoProject, loadResolvedDemoProject } from '../fixtures/project.ts';

const PROJECT_PATH = 'projects/demo-character/project.json';
const BLEND_PATH = '/graph/transitions/run-to-attack-01/blendDurationSec';
const LOCKED_PATH = '/movement/jumpHeight';

function newSession() {
  const project = loadResolvedDemoProject();
  return { project, canonical: loadDemoProject(), session: new EditSession(project) };
}

function newGit(project: unknown) {
  return new FakeGitAdapter('main', null, {
    [PROJECT_PATH]: `${JSON.stringify(project, null, 2)}\n`,
  });
}

describe('the full human tuning loop', () => {
  let session: EditSession;

  beforeEach(() => {
    session = newSession().session;
  });

  it('walks a value from repository through preview, staging and commit', async () => {
    // 1. Pick the transition and change the blend.
    const before = getAtPath(session.repositoryProject, BLEND_PATH);
    expect(before).toBe(0.11);

    const outcome = session.setPreviewValue({
      path: BLEND_PATH,
      value: 0.085,
      actor: 'human',
      intent: '初動を早めるが、切り替わりの硬さは残さない',
      replayId: 'run-to-attack-forward',
      terrainPresetId: 'flat',
    });
    expect(outcome.applied).toBe(true);

    // 2. The preview reflects it immediately; the repository does not.
    expect(getAtPath(session.previewProject, BLEND_PATH)).toBe(0.085);
    expect(getAtPath(session.repositoryProject, BLEND_PATH)).toBe(0.11);
    expect(session.fieldView(BLEND_PATH).origin).toBe('human-preview');

    // 3. Compare before and after on the same replay.
    const replay = findReplayFixture('run-to-attack-forward');
    const comparison = compareTraces(
      runReplay(session.repositoryProject, replay),
      runReplay(session.previewProject, replay),
    );
    expect(comparison).toBeDefined();

    // 4. Stage it.
    session.stage(BLEND_PATH);
    expect(session.stagedPaths).toEqual([BLEND_PATH]);
    expect(session.fieldView(BLEND_PATH).origin).toBe('human-final');

    // 5. Schema validation passes.
    expect(session.validate().valid).toBe(true);

    // 6. Commit through the fake Git adapter.
    const git = newGit(session.repositoryProject);
    const head = await git.getHead('main');
    // The committed file is the canonical project, not the resolved document:
    // the resolved graph is derived, and writing it back would re-embed exactly
    // what the asset split took out.
    const canonical = loadDemoProject();
    const draft = buildCommitDraft({
      document: session.buildStagedProjectDocument(canonical),
      diff: session.diff(),
      author: 'tester',
      intent: '初動を早めるが、切り替わりの硬さは残さない',
      parentRevisionId: session.repositoryProject.revisionId,
    });

    const branch = sessionBranchName(session.repositoryProject.id, 'sess1');
    const result = await git.commit({
      branch,
      baseSha: head.sha,
      message: draft.message,
      body: draft.body,
      files: [
        {
          path: PROJECT_PATH,
          content: `${JSON.stringify(draft.document, null, 2)}\n`,
        },
      ],
    });

    expect(result.createdBranch).toBe(true);
    expect(result.branch).toBe('chamber/demo-character/sess1');

    expect(validateProject(draft.document).valid).toBe(true);

    // 7. The revision records it as a human adjustment, with the intent.
    session.acceptCommitted({
      ...session.buildStagedDocument(),
      revisionId: draft.document.revisionId,
      revisions: draft.document.revisions,
    });
    const revision = session.repositoryProject.revisions.at(-1)!;
    expect(revision.provenance?.source).toBe('human-adjustment');
    expect(revision.provenance?.intent).toContain('初動');
    expect(revision.changedPaths).toContain(BLEND_PATH);
    expect(session.repositoryProject.revisionId).toBe(revision.id);
    expect(getAtPath(session.repositoryProject, BLEND_PATH)).toBe(0.085);

    // 8. Provenance is attached to the transition itself.
    const provenance = getAtPath(session.repositoryProject, '/graph/transitions/run-to-attack-01/provenance') as {
      source: string;
      humanFinal: number;
      basedOnAiProposal?: number;
    };
    expect(provenance.source).toBe('human-adjustment');
    expect(provenance.humanFinal).toBe(0.085);
  });

  it('only commits staged paths, leaving other previews behind', () => {
    session.setPreviewValue({ path: BLEND_PATH, value: 0.09, actor: 'human' });
    session.setPreviewValue({
      path: '/camera/distance',
      value: 9,
      actor: 'human',
    });
    session.stage(BLEND_PATH);

    const staged = session.buildStagedDocument();
    expect(getAtPath(staged, BLEND_PATH)).toBe(0.09);
    expect(getAtPath(staged, '/camera/distance')).toBe(5.5);
  });

  it('requires saving again after a staged value is edited', () => {
    session.setPreviewValue({ path: BLEND_PATH, value: 0.09, actor: 'human' });
    session.stage(BLEND_PATH);
    session.setPreviewValue({ path: BLEND_PATH, value: 0.07, actor: 'human' });

    expect(session.fieldView(BLEND_PATH)).toMatchObject({
      staged: false,
      needsSave: true,
    });
    expect(getAtPath(session.buildStagedDocument(), BLEND_PATH)).toBe(0.09);

    session.stage(BLEND_PATH);
    expect(session.fieldView(BLEND_PATH)).toMatchObject({
      staged: true,
      needsSave: false,
    });
    expect(getAtPath(session.buildStagedDocument(), BLEND_PATH)).toBe(0.07);

    session.resetToRepository(BLEND_PATH);
    expect(session.fieldView(BLEND_PATH)).toMatchObject({
      staged: false,
      needsSave: true,
    });
    session.stage(BLEND_PATH);
    expect(session.stagedPaths).not.toContain(BLEND_PATH);
  });

  it('stage all keeps a recovery clip when adding its timing curve', () => {
    session.setPreviewValue({
      path: '/clips/unarmed-attack-01-recovery/timeCurve',
      value: { x1: 0.42, y1: 0, x2: 0.58, y2: 1 },
      actor: 'human',
    });
    session.stageAll();

    const staged = session.buildStagedDocument();
    expect(staged.clips.some((clip) => clip.id === 'unarmed-attack-01-recovery')).toBe(true);
    expect(analyzeDiff(session.repositoryProject, staged).findings).not.toContainEqual(
      expect.objectContaining({ rule: 'clip-removed' }),
    );
  });

  it('supports undo, redo and revert', () => {
    session.setPreviewValue({ path: BLEND_PATH, value: 0.09, actor: 'human' });
    session.setPreviewValue({ path: BLEND_PATH, value: 0.07, actor: 'human' });

    expect(session.undo()).toBe(true);
    expect(getAtPath(session.previewProject, BLEND_PATH)).toBe(0.09);
    expect(session.redo()).toBe(true);
    expect(getAtPath(session.previewProject, BLEND_PATH)).toBe(0.07);

    session.revertSession();
    expect(getAtPath(session.previewProject, BLEND_PATH)).toBe(0.11);
    expect(session.hasUncommittedChanges).toBe(false);
  });
});

describe('protection through the whole stack', () => {
  it('refuses a locked value, then allows it after an explicit unlock', () => {
    const { session } = newSession();

    const refused = session.setPreviewValue({
      path: LOCKED_PATH,
      value: 3,
      actor: 'human',
    });
    expect(refused.applied).toBe(false);
    expect(refused.reason).toContain('locked');
    expect(getAtPath(session.previewProject, LOCKED_PATH)).toBe(1.15);

    session.unlock(LOCKED_PATH);
    const allowed = session.setPreviewValue({
      path: LOCKED_PATH,
      value: 3,
      actor: 'human',
    });
    expect(allowed.applied).toBe(true);
  });

  it('refuses an AI patch to an approval-required value, and accepts an approved one', () => {
    const { session } = newSession();

    const refused = session.setPreviewValue({
      path: BLEND_PATH,
      value: 0.06,
      actor: 'ai',
    });
    expect(refused.applied).toBe(false);
    expect(refused.requiresApproval).toBe(true);

    const approved = session.setPreviewValue({
      path: BLEND_PATH,
      value: 0.06,
      actor: 'ai',
      approved: true,
    });
    expect(approved.applied).toBe(true);
  });

  it('blocks a commit whose diff touches a protected value', () => {
    const { session } = newSession();
    session.unlock(LOCKED_PATH);
    session.setPreviewValue({ path: LOCKED_PATH, value: 3, actor: 'human' });
    session.stage(LOCKED_PATH);
    // The session allowed the edit; the diff policy still flags it for review.
    expect(session.diff().commitAllowed).toBe(false);
  });
});

describe('AI proposals feeding the edit session', () => {
  it('records proposals so a human can return to them', async () => {
    const { project, session } = newSession();
    const provider = new RuleBasedProvider();

    const proposals = await provider.proposeAdjustments({
      project,
      request: '攻撃の初動を速くし、重量感は残す',
      targetPath: '/graph/transitions/run-to-attack-01',
    });

    // The proposal is recorded as it is applied, so "reset to AI proposal"
    // returns the variant the human actually took.
    const chosen = proposals[0]!;
    for (const change of chosen.changes) {
      session.recordAiProposal(change.path, change.after);
      session.setPreviewValue({
        path: change.path,
        value: change.after,
        actor: 'ai',
        approved: true,
      });
    }

    const blendChange = chosen.changes.find((change) => change.path === BLEND_PATH)!;
    expect(getAtPath(session.previewProject, BLEND_PATH)).toBe(blendChange.after);

    // The human then nudges it themselves, and the provenance records both.
    session.setPreviewValue({ path: BLEND_PATH, value: 0.075, actor: 'human' });
    session.stage(BLEND_PATH);
    const staged = session.buildStagedDocument();
    const provenance = getAtPath(staged, '/graph/transitions/run-to-attack-01/provenance') as {
      basedOnAiProposal: number;
      humanFinal: number;
    };
    expect(provenance.basedOnAiProposal).toBe(blendChange.after);
    expect(provenance.humanFinal).toBe(0.075);

    // And they can jump back to what the AI suggested.
    session.resetToAiProposal(BLEND_PATH);
    expect(getAtPath(session.previewProject, BLEND_PATH)).toBe(blendChange.after);
  });
});

describe('git safety', () => {
  it('refuses to commit directly to the protected branch', async () => {
    const { project } = newSession();
    const git = newGit(project);
    const head = await git.getHead('main');
    await expect(
      git.commit({
        branch: 'main',
        baseSha: head.sha,
        message: 'x',
        body: '',
        files: [{ path: PROJECT_PATH, content: '{}' }],
      }),
    ).rejects.toBeInstanceOf(ProtectedBranchError);
  });

  it('detects a stale base SHA and reports per-field conflicts', async () => {
    const { project } = newSession();
    const git = newGit(project);
    const branch = 'chamber/demo-character/sess1';

    const head = await git.getHead(branch);
    await git.commit({
      branch,
      baseSha: head.sha,
      message: 'first',
      body: '',
      files: [
        {
          path: PROJECT_PATH,
          content: `${JSON.stringify(project, null, 2)}\n`,
        },
      ],
    });

    // Someone else pushes to the same branch.
    const theirs = structuredClone(project);
    theirs.camera.distance = 12;
    git.forcePush(branch, {
      [PROJECT_PATH]: `${JSON.stringify(theirs, null, 2)}\n`,
    });

    const ours = structuredClone(project);
    ours.camera.distance = 7;

    await expect(
      git.commit({
        branch,
        // Deliberately stale.
        baseSha: head.sha,
        message: 'second',
        body: '',
        files: [{ path: PROJECT_PATH, content: `${JSON.stringify(ours, null, 2)}\n` }],
      }),
    ).rejects.toSatisfy((error: unknown) => {
      if (!(error instanceof GitConflictError)) return false;
      const conflict = error.conflicts.find((entry) => entry.path === '/camera/distance');
      return conflict?.ours === 7 && conflict?.theirs === 12;
    });
  });

  it('opens a pull request against the protected branch', async () => {
    const { project } = newSession();
    const git = newGit(project);
    const branch = 'chamber/demo-character/sess1';
    const head = await git.getHead(branch);
    await git.commit({
      branch,
      baseSha: head.sha,
      message: 'tuning',
      body: '',
      files: [{ path: PROJECT_PATH, content: '{}' }],
    });

    const pr = await git.createPullRequest({
      branch,
      baseBranch: 'main',
      title: 'Chamber tuning',
      body: 'body',
    });
    expect(pr.number).toBe(1);
    expect(git.listPullRequests()[0]!.baseBranch).toBe('main');
  });

  it('names session branches under chamber/<project>/<session>', () => {
    expect(sessionBranchName('demo-character', 'Session 1!')).toBe('chamber/demo-character/session-1');
  });
});

describe('commit messages', () => {
  it('records the before and after of every change in the body', () => {
    const { session } = newSession();
    session.setPreviewValue({ path: BLEND_PATH, value: 0.085, actor: 'human' });
    session.stageAll();

    // The committed file is the canonical project, not the resolved document:
    // the resolved graph is derived, and writing it back would re-embed exactly
    // what the asset split took out.
    const canonical = loadDemoProject();
    const draft = buildCommitDraft({
      document: session.buildStagedProjectDocument(canonical),
      diff: session.diff(),
      author: 'tester',
      intent: 'faster startup, same weight',
      parentRevisionId: session.repositoryProject.revisionId,
    });

    expect(draft.message).toContain('tune(graph)');
    expect(draft.body).toContain('faster startup, same weight');
    expect(draft.body).toContain('0.11 -> 0.085');
    // The approval-required warning travels with the commit, not just the UI.
    expect(draft.body).toContain('approval-required-changed');
  });
});

describe('unity export', () => {
  it('produces the full bundle described in the plan', () => {
    const { project } = newSession();
    const files = buildUnityBundle(project, REPLAY_FIXTURES, '2026-01-01T00:00:00.000Z');
    const paths = files.map((file) => file.path);

    for (const expected of [
      'project.json',
      'animation-graph.json',
      'input-map.json',
      'movement-profile.json',
      'terrain-profile.json',
      'haptic-profile.json',
      'assets-manifest.json',
      'AnimationTestChamberAdapter/Runtime/Generated/ChamberDtos.cs',
      'AnimationTestChamberAdapter/Editor/ChamberImporter.cs',
      'AnimationTestChamberAdapter/README.md',
    ]) {
      expect(paths).toContain(expected);
    }
    expect(paths.filter((path) => path.startsWith('replays/'))).toHaveLength(REPLAY_FIXTURES.length);
  });

  it('marks every JSON file as generated, not canonical', () => {
    const { project } = newSession();
    const files = buildUnityBundle(project, []);
    for (const file of files.filter((entry) => entry.path.endsWith('.json'))) {
      const parsed = JSON.parse(file.content) as { _generated?: boolean };
      expect(parsed._generated).toBe(true);
    }
  });

  it('generates C# DTOs matching the schema field names', () => {
    const { project } = newSession();
    const dtos = buildUnityBundle(project, []).find((file) => file.path.endsWith('ChamberDtos.cs'))!;

    expect(dtos.content).toContain('namespace AnimationTestChamber.Generated');
    expect(dtos.content).toContain('public class TransitionDefinition');
    expect(dtos.content).toContain('public float blendDurationSec;');
    expect(dtos.content).toContain('public float inputBufferMs;');
    // Type.Integer maps to int, Type.Number to float.
    expect(dtos.content).toContain('public int priority;');
    expect(dtos.content).toContain('public List<TransitionCondition> conditions;');
    expect(dtos.content).toContain('auto-generated');
  });

  it('states its limitations rather than implying full Unity parity', () => {
    const { project } = newSession();
    const readme = buildUnityBundle(project, []).find((file) => file.path.endsWith('README.md'))!;
    expect(readme.content).toContain('LIMITATIONS');
    expect(readme.content).toContain('No Animator Controller is generated');
  });

  it('carries licence terms into the asset manifest', () => {
    const { project } = newSession();
    const manifest = buildUnityBundle(project, []).find((file) => file.path.endsWith('assets-manifest.json'))!;
    expect(JSON.parse(manifest.content)).toHaveProperty('candidates');
  });
});

describe('canonical data integrity', () => {
  it('keeps the committed demo project schema-valid after a round trip', () => {
    const { session } = newSession();
    session.setPreviewValue({ path: BLEND_PATH, value: 0.085, actor: 'human' });
    session.stageAll();
    expect(validateResolvedProject(session.buildStagedDocument()).issues).toEqual([]);
  });

  /**
   * Staging attaches provenance to the object owning the edited value, so any
   * type with an editable field must be able to hold it. States were the last
   * one that could not: nothing edited a state until the timing panel grew a
   * speed slider, and the mismatch only surfaced at "Apply to repository",
   * long after the edit. One staged field per editable owner catches that at
   * the point the owner becomes editable.
   */
  it.each([
    ['state', '/graph/states/guard/speed', 1.5],
    ['clip', '/clips/dodge/durationSec', 1.2],
    ['transition', '/graph/transitions/idle-to-walk/blendDurationSec', 0.09],
  ])('stays valid after staging a %s field', (_label, path, value) => {
    const { session } = newSession();
    session.setPreviewValue({ path, value, actor: 'human', intent: 'tune' });
    session.stage(path);

    const document = session.buildStagedDocument();
    expect(validateResolvedProject(document).issues).toEqual([]);
    // Provenance must survive, not be quietly dropped to keep the schema happy.
    const owner = path.slice(0, path.lastIndexOf('/'));
    expect(getAtPath(document, `${owner}/provenance`)).toMatchObject({
      source: 'human-adjustment',
    });
  });
});
