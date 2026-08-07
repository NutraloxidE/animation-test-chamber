/**
 * Publishing an animation edit from the native workspace.
 *
 * Every assertion here exists because of one specific way a save can be
 * plausible and wrong: it writes somewhere nobody named. The legacy path could
 * not have this bug because it had one destination; the native path has
 * several, and the whole design is arranged so that the destination is a thing
 * the human chose and the server re-derived from the same request.
 *
 * So the tests are about equality and refusal, not about happy paths:
 *
 *   - displayed targets === request.targetPrefabIds === response changedPrefabIds
 *   - nothing is selected until somebody selects it
 *   - every refusal proves zero writes
 */
import { describe, expect, it } from 'vitest';
import type { PublishAnimationAndUpdatePrefabsRequest } from '@atc/schema';
import {
  AnimationPublicationController,
  publicationDraft,
  currentHolders,
  publicationPlan,
  publicationRequest,
  publicationSource,
  type PublicationResponse,
} from '../../../apps/web/src/animation-chamber/AnimationPublicationController.ts';
import {
  blockingFindings,
  classifyStagedPath,
  summarizeStagedDomains,
} from '../../../apps/web/src/animation-chamber/animation-publication-state.ts';
import { chamber, firstTransitionPath, materialize, subjectFixture } from './fixtures.ts';

/**
 * A controller over a live session, with the network replaced by a recorder.
 *
 * The submit seam is injected rather than stubbed globally so a test can assert
 * on the exact request object that would have gone over the wire — which is the
 * thing the equality claim is actually about.
 */
function controllerOver(options: {
  respond?: (request: PublishAnimationAndUpdatePrefabsRequest) => PublicationResponse;
  online?: boolean;
} = {}) {
  const fixture = chamber();
  const { registry, animationRegistry } = subjectFixture();
  const sent: PublishAnimationAndUpdatePrefabsRequest[] = [];
  const session = fixture.store.getState().session;

  const controller = new AnimationPublicationController({
    session,
    prefabRegistry: registry,
    animationRegistry,
    projectRevisionId: fixture.store.getState().project.revisionId,
    backendAvailable: async () => options.online ?? true,
    submit: async (request) => {
      sent.push(request);
      return (
        options.respond?.(request) ?? {
          status: 200,
          body: {
            ok: true,
            changedTargets: { prefabIds: [...request.targetPrefabIds].sort() },
            published: {
              animation: { ...request.source, version: '1.0.1', contentHash: 'a'.repeat(64) },
              prefabs: request.targetPrefabIds.map((assetId) => ({
                assetId,
                version: '1.0.1',
                contentHash: 'b'.repeat(64),
              })),
            },
          },
        }
      );
    },
  });
  return { ...fixture, controller, sent, session };
}

function stageAGraphEdit(fixture: ReturnType<typeof controllerOver>): string {
  const path = firstTransitionPath(fixture.store);
  fixture.store.getState().setPreviewValue(path, 0.37);
  fixture.store.getState().stage(path);
  return path;
}

describe('classifying a staged path', () => {
  const document = materialize();

  it('sends a graph change to the Behavior asset the Animator names', () => {
    const ownership = classifyStagedPath('/graph/transitions/idle-to-walk/blendDurationSec', document);
    expect(ownership.domain).toBe('behavior');
    expect(ownership.owner).toEqual({
      kind: 'animation-asset',
      reference: document.subject.animator.assignment.behavior,
    });
  });

  it('sends a binding change to the Motion Set', () => {
    expect(classifyStagedPath('/motionBindings/locomotion.idle', document).domain).toBe('motion-set');
  });

  it('sends a presentation change to the exact Prefab Component, never a Character', () => {
    const ownership = classifyStagedPath('/presentation/equipmentSockets/grip', document);
    expect(ownership.domain).toBe('prefab-presentation');
    expect(ownership.owner).toEqual({
      kind: 'prefab-component',
      prefab: document.subject.source.prefab,
      nodeId: document.subject.source.nodeId,
      componentId: document.subject.source.componentId,
    });
  });

  it('sends tuning to the Animator’s tuning profile when it has one', () => {
    const ownership = classifyStagedPath('/movement/runSpeed', document);
    expect(ownership.domain).toBe('tuning');
    expect(ownership.owner).toEqual({
      kind: 'animation-asset',
      reference: document.subject.animator.assignment.tuning,
    });
  });

  it('blocks a path nothing owns rather than guessing from its shape', () => {
    const ownership = classifyStagedPath('/somethingInvented/value', document);
    expect(ownership.domain).toBe('unowned');
    expect(ownership.blockedReason).toContain('no exact owning domain');
  });

  it('blocks resolved state, which is derived and has no author', () => {
    expect(classifyStagedPath('/resolution/0/value', document).blockedReason).toContain(
      'resolved state',
    );
    expect(blockingFindings(['/subject/subjectId'], document)).toHaveLength(1);
  });

  it('groups paths by owner for the destination surface', () => {
    const domains = summarizeStagedDomains(
      ['/graph/transitions/a/blendDurationSec', '/graph/states/idle/speed', '/movement/runSpeed'],
      document,
    );
    expect(domains.map((domain) => domain.domain)).toEqual(['behavior', 'tuning']);
    expect(domains[0]!.paths).toHaveLength(2);
  });

  it('refuses to name one source when staged changes span two assets', () => {
    const { source, reason } = publicationSource(
      ['/graph/states/idle/speed', '/movement/runSpeed'],
      document,
    );
    // Two assets is two publications. Picking one would silently drop the other.
    expect(source).toBeNull();
    expect(reason).toContain('published separately');
  });
});

describe('the draft a publication would seal', () => {
  it('carries the preview graph into the stored Behavior asset', () => {
    const fixture = controllerOver();
    stageAGraphEdit(fixture);
    const { animationRegistry } = subjectFixture();
    const document = fixture.store.getState().previewDocument;

    const { draft } = publicationDraft({
      source: document.subject.animator.assignment.behavior,
      animationRegistry,
      preview: document,
    });
    expect(draft).toBeDefined();
    expect((draft as { graph: unknown }).graph).toBe(document.graph);
  });
});

describe('choosing a destination', () => {
  it('selects nothing when the plan opens', () => {
    const fixture = controllerOver();
    stageAGraphEdit(fixture);
    fixture.controller.openPublication();

    const view = fixture.controller.snapshot();
    // Not an empty array that happens to mean publish-only: a distinct state
    // that cannot submit at all.
    expect(view.stage).toBe('choosing');
    expect(view.selectedPrefabIds).toEqual([]);
    expect(view.plan).toBeNull();
  });

  it('refuses to submit before a destination is chosen', async () => {
    const fixture = controllerOver();
    stageAGraphEdit(fixture);
    fixture.controller.openPublication();

    await fixture.controller.submitPublication('no destination yet');

    expect(fixture.sent).toEqual([]);
    expect(fixture.controller.snapshot().log.at(-1)).toContain('Choose a destination first');
  });

  it('lists every current holder without selecting one', () => {
    const fixture = controllerOver();
    stageAGraphEdit(fixture);
    fixture.controller.openPublication();

    const view = fixture.controller.snapshot();
    expect(view.holders.length).toBeGreaterThan(0);
    expect(view.selectedPrefabIds).toEqual([]);
  });

  it('treats publish-only as an explicit decision', async () => {
    const fixture = controllerOver();
    stageAGraphEdit(fixture);
    fixture.controller.openPublication();
    fixture.controller.choosePublishOnly();

    expect(fixture.controller.snapshot().stage).toBe('publish-only');
    await fixture.controller.submitPublication('new version, nobody adopts it');

    expect(fixture.sent).toHaveLength(1);
    expect(fixture.sent[0]!.targetPrefabIds).toEqual([]);
    expect(fixture.controller.snapshot().result?.ok).toBe(true);
    expect(fixture.controller.snapshot().result?.changedPrefabIds).toEqual([]);
  });

  it('returns to "choosing" when the last target is deselected', () => {
    const fixture = controllerOver();
    stageAGraphEdit(fixture);
    fixture.controller.openPublication();
    const holder = fixture.controller.snapshot().holders[0]!.assetId;

    fixture.controller.togglePublicationTarget(holder);
    expect(fixture.controller.snapshot().stage).toBe('targets-chosen');
    fixture.controller.togglePublicationTarget(holder);
    // Not publish-only: those are different decisions and must not be reachable
    // by unticking a box.
    expect(fixture.controller.snapshot().stage).toBe('choosing');
  });
});

describe('what is displayed is what is sent is what changed', () => {
  it('keeps the three lists equal for one exact holder', async () => {
    const fixture = controllerOver();
    stageAGraphEdit(fixture);
    fixture.controller.openPublication();
    const holder = fixture.controller.snapshot().holders[0]!.assetId;
    fixture.controller.togglePublicationTarget(holder);

    const displayed = fixture.controller
      .snapshot()
      .plan!.selectedTargets.map((target) => target.assetId);
    await fixture.controller.submitPublication('adopt it here');

    expect(displayed).toEqual([holder]);
    expect(fixture.sent[0]!.targetPrefabIds).toEqual([holder]);
    expect(fixture.controller.snapshot().result?.changedPrefabIds).toEqual([holder]);
  });

  it('shows explicit non-targets, and leaves them alone', async () => {
    const fixture = controllerOver();
    stageAGraphEdit(fixture);
    fixture.controller.openPublication();
    fixture.controller.choosePublishOnly();

    const plan = fixture.controller.snapshot().plan!;
    // Every holder that was deliberately not named is shown as such, rather
    // than being absent and therefore invisible.
    expect(plan.nonTargets.map((target) => target.assetId)).toEqual(
      fixture.controller.snapshot().holders.map((holder) => holder.assetId),
    );
    await fixture.controller.submitPublication('publish only');
    expect(fixture.controller.snapshot().result?.changedPrefabIds).toEqual([]);
  });

  it('refuses a success whose changed set is not the approved set', async () => {
    const fixture = controllerOver({
      respond: (request) => ({
        status: 200,
        body: {
          ok: true,
          // The server reports a Prefab the plan never named. A 200 is not
          // enough: the write is not the write that was approved.
          changedTargets: { prefabIds: [...request.targetPrefabIds, 'something-else'] },
        },
      }),
    });
    stageAGraphEdit(fixture);
    fixture.controller.openPublication();
    fixture.controller.togglePublicationTarget(fixture.controller.snapshot().holders[0]!.assetId);

    await fixture.controller.submitPublication('adopt');

    const result = fixture.controller.snapshot().result!;
    expect(result.ok).toBe(false);
    expect(result.conflicts[0]!.code).toBe('target-mismatch');
  });

  it('builds the request from the selection verbatim, never widened', () => {
    const document = materialize();
    const source = document.subject.animator.assignment.behavior;
    const holders = currentHolders(subjectFixture().registry, source);
    expect(holders.length).toBeGreaterThan(0);

    const request = publicationRequest({
      source,
      draft: { metadata: {} } as never,
      holders,
      selectedPrefabIds: [],
      projectRevisionId: document.revisionId,
    });

    // A holder set of one and a selection of none stay different things. The
    // failure this rules out is "no selection means everything".
    expect(request.targetPrefabIds).toEqual([]);
    expect(request.expected.holderPrefabReferences).toEqual(holders);
    expect(request.expected.sourceContentHash).toBe(source.contentHash);
  });
});

describe('refusals write nothing', () => {
  it('refuses a target that does not hold the source', async () => {
    const fixture = controllerOver();
    stageAGraphEdit(fixture);
    fixture.controller.openPublication();
    fixture.controller.togglePublicationTarget('a-prefab-that-holds-nothing');

    await fixture.controller.submitPublication('adopt somewhere wrong');

    expect(fixture.sent).toEqual([]);
    const result = fixture.controller.snapshot().result!;
    expect(result.ok).toBe(false);
    expect(result.changedPrefabIds).toEqual([]);
    expect(result.conflicts.map((conflict) => conflict.code)).toContain(
      'target-does-not-hold-source',
    );
  });

  it('refuses when a staged path has no exact owner', async () => {
    const fixture = controllerOver();
    stageAGraphEdit(fixture);
    // Staged, but nothing owns it — the case that used to be written into
    // project.json without anybody noticing.
    fixture.session.setPreviewValue({ path: '/revisionId', value: 'moved', actor: 'human' });
    fixture.session.stage('/revisionId');

    fixture.controller.openPublication();
    fixture.controller.choosePublishOnly();
    await fixture.controller.submitPublication('should refuse');

    expect(fixture.sent).toEqual([]);
    expect(fixture.controller.snapshot().stage).toBe('refused');
  });

  it('refuses a server error without claiming a partial write', async () => {
    const fixture = controllerOver({
      respond: () => ({
        status: 409,
        body: {
          ok: false,
          issues: [{ message: 'the project moved since the targets were chosen', keyword: 'stale-holder-snapshot' }],
          changedTargets: { prefabIds: [] },
        },
      }),
    });
    stageAGraphEdit(fixture);
    fixture.controller.openPublication();
    fixture.controller.choosePublishOnly();

    await fixture.controller.submitPublication('stale');

    const result = fixture.controller.snapshot().result!;
    expect(result.ok).toBe(false);
    expect(result.changedPrefabIds).toEqual([]);
    expect(result.conflicts[0]!.code).toBe('stale-holder-snapshot');
  });

  it('refuses a transport failure without claiming a write', async () => {
    const fixture = controllerOver({
      respond: () => {
        throw new Error('socket closed');
      },
    });
    stageAGraphEdit(fixture);
    fixture.controller.openPublication();
    fixture.controller.choosePublishOnly();

    await fixture.controller.submitPublication('network gone');

    expect(fixture.controller.snapshot().result?.ok).toBe(false);
    expect(fixture.controller.snapshot().log.at(-1)).toContain('Nothing was written');
  });

  it('never claims a repository write with no API server', async () => {
    const fixture = controllerOver({ online: false });
    stageAGraphEdit(fixture);
    fixture.controller.openPublication();
    fixture.controller.choosePublishOnly();

    await fixture.controller.submitPublication('offline');

    expect(fixture.sent).toEqual([]);
    const log = fixture.controller.snapshot().log.join(' ');
    expect(log).toContain('No repository file and no Prefab was changed');
    expect(log).not.toContain('Published');
  });

  it('refuses a stale repository revision with no writes', () => {
    const document = materialize();
    const { registry } = subjectFixture();
    const source = document.subject.animator.assignment.behavior;
    const holders = currentHolders(registry, source);

    const plan = publicationPlan({
      prefabRegistry: registry,
      request: publicationRequest({
        source,
        draft: { metadata: {} } as never,
        holders,
        selectedPrefabIds: [],
        // The snapshot the human's decision was drawn from.
        projectRevisionId: 'revision-the-human-saw',
      }),
      // What the repository is now. Silently including or excluding the
      // difference are both wrong answers to a question only a human can
      // settle, so the plan refuses instead.
      projectRevisionId: 'revision-the-repository-has-now',
    });

    expect(plan.conflicts.map((conflict) => conflict.code)).toContain('stale-holder-snapshot');
    expect(plan.expectedWrites.every((path) => path.startsWith('assets/'))).toBe(true);
  });

  it('refuses a stale holder snapshot with no writes', () => {
    const document = materialize();
    const { registry } = subjectFixture();
    const source = document.subject.animator.assignment.behavior;

    const plan = publicationPlan({
      prefabRegistry: registry,
      request: publicationRequest({
        source,
        draft: { metadata: {} } as never,
        // The human approved a blast radius drawn from an empty holder list;
        // the repository says otherwise.
        holders: [],
        selectedPrefabIds: [],
        projectRevisionId: document.revisionId,
      }),
      projectRevisionId: document.revisionId,
    });

    expect(plan.conflicts.map((conflict) => conflict.code)).toContain('stale-holder-snapshot');
  });
});

describe('after a successful publication', () => {
  it('shows the new exact references and does not move the route', async () => {
    const fixture = controllerOver();
    stageAGraphEdit(fixture);
    const subjectBefore = fixture.store.getState().subject;
    fixture.controller.openPublication();
    fixture.controller.togglePublicationTarget(fixture.controller.snapshot().holders[0]!.assetId);

    await fixture.controller.submitPublication('adopt');

    const view = fixture.controller.snapshot();
    expect(view.stage).toBe('published');
    expect(view.result!.publishedAnimation!.version).toBe('1.0.1');
    expect(view.result!.publishedPrefabs).toHaveLength(1);
    // The session stays on the version it opened. Jumping to "latest" would
    // discard unrelated local edits nobody asked to lose.
    expect(fixture.store.getState().subject).toBe(subjectBefore);
  });
});
