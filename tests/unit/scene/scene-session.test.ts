/**
 * Scene operations and the generic document session.
 *
 * The properties under test are the ones the whole editing model rests on:
 * preview is not stage, stage is not apply, paths are ID-keyed, and a human and
 * a machine reach canonical data through the same typed operation.
 */
import { describe, expect, it } from 'vitest';
import type { SceneDefinition } from '@atc/schema';
import { validateSceneReferences } from '@atc/schema';
import {
  DocumentEditSession,
  applySceneOperation,
  defaultPlacementTransform,
  draftKey,
  targetKey,
  uniqueEntityId,
  type SceneOperation,
} from '@atc/editor-core';
import { acceptanceScene, CONTROLLED_ENTITY, SCRIPTED_ENTITY } from '../../fixtures/scene.ts';
import { loadDemoProject } from '../../fixtures/project.ts';

const project = loadDemoProject();
const characterIds = new Set(project.characters.map((entry) => entry.id));

function session(scene: SceneDefinition = acceptanceScene()) {
  return new DocumentEditSession<SceneDefinition, SceneOperation>({
    target: { kind: 'scene', id: scene.id },
    baseRevisionId: project.revisionId,
    document: scene,
    apply: (document, operation) => applySceneOperation(document, operation, project),
    validate: (document) => validateSceneReferences(document, characterIds),
  });
}

describe('scene.place_asset', () => {
  it('places a character entity unbound rather than stealing player 0', () => {
    const s = session();
    const result = s.dispatch({
      type: 'scene.place_asset',
      entityId: 'placed-humanoid',
      displayName: 'Placed humanoid',
      asset: { kind: 'character', characterId: 'demo-humanoid' },
      transform: defaultPlacementTransform(),
    });

    expect(result.ok).toBe(true);
    const placed = result.document!.entities.find((entity) => entity.id === 'placed-humanoid')!;
    expect(placed.kind).toBe('character');
    expect((placed as { controller: { kind: string } }).controller).toEqual({ kind: 'none' });
    // The entity that already held player 0 keeps it.
    const existing = result.document!.entities.find((entity) => entity.id === CONTROLLED_ENTITY)!;
    expect((existing as { controller: { kind: string } }).controller.kind).toBe('human');
  });

  it('refuses an unknown character with a structured issue, not a throw', () => {
    const result = session().dispatch({
      type: 'scene.place_asset',
      entityId: 'ghost',
      displayName: 'Ghost',
      asset: { kind: 'character', characterId: 'no-such-character' },
    });
    expect(result.ok).toBe(false);
    expect(result.issues[0]!.keyword).toBe('reference');
  });

  it('refuses a duplicate entity id', () => {
    const result = session().dispatch({
      type: 'scene.place_asset',
      entityId: CONTROLLED_ENTITY,
      displayName: 'Clash',
      asset: { kind: 'camera' },
    });
    expect(result.ok).toBe(false);
    expect(result.issues[0]!.keyword).toBe('unique');
  });

  it('refuses a non-finite transform', () => {
    const result = session().dispatch({
      type: 'scene.place_asset',
      entityId: 'nan-prop',
      displayName: 'NaN prop',
      asset: { kind: 'camera' },
      transform: {
        position: { x: Number.NaN, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        scale: { x: 1, y: 1, z: 1 },
      },
    });
    expect(result.ok).toBe(false);
    expect(result.issues[0]!.keyword).toBe('finite');
  });

  it('refuses a browser-only object URL as a prop asset', () => {
    const result = session().dispatch({
      type: 'scene.place_asset',
      entityId: 'blob-prop',
      displayName: 'Blob prop',
      asset: { kind: 'prop', asset: { kind: 'model', assetPath: 'blob:http://localhost/9f2a' } },
    });
    expect(result.ok).toBe(false);
  });

  it('reports an ID-keyed changed path, never an index', () => {
    const result = session().dispatch({
      type: 'scene.place_asset',
      entityId: 'placed-light',
      displayName: 'Key light',
      asset: { kind: 'light', lightType: 'directional' },
    });
    expect(result.changedPaths).toEqual(['/entities/placed-light']);
  });
});

describe('scene.delete_entity', () => {
  /*
   * A camera left pointing at a deleted entity would fail validation at Apply —
   * long after the human pressed Delete, and with no obvious connection to it.
   */
  it('repairs a camera that targeted the deleted entity', () => {
    const s = session();
    const result = s.dispatch({ type: 'scene.delete_entity', entityId: CONTROLLED_ENTITY });
    expect(result.ok).toBe(true);
    const camera = result.document!.entities.find((entity) => entity.kind === 'camera')!;
    expect((camera as { targetEntityId?: string }).targetEntityId).toBeUndefined();
    expect(result.document!.activeCameraEntityId).toBe(camera.id);
  });

  it('does not remove the referenced Character Definition', () => {
    const result = session().dispatch({ type: 'scene.delete_entity', entityId: CONTROLLED_ENTITY });
    expect(result.ok).toBe(true);
    expect(project.characters.some((entry) => entry.id === 'demo-humanoid')).toBe(true);
  });

  it('refuses an unknown entity', () => {
    expect(session().dispatch({ type: 'scene.delete_entity', entityId: 'nope' }).ok).toBe(false);
  });
});

describe('scene.duplicate_entity', () => {
  it('produces a deterministic, collision-free id', () => {
    const first = session().dispatch({ type: 'scene.duplicate_entity', entityId: CONTROLLED_ENTITY });
    const second = session().dispatch({ type: 'scene.duplicate_entity', entityId: CONTROLLED_ENTITY });
    expect(first.changedPaths).toEqual(second.changedPaths);
    expect(first.changedPaths).toEqual([`/entities/${CONTROLLED_ENTITY}-copy`]);
  });

  it('keeps referencing the same shared character', () => {
    const result = session().dispatch({ type: 'scene.duplicate_entity', entityId: CONTROLLED_ENTITY });
    const copy = result.document!.entities.find((entity) => entity.id === `${CONTROLLED_ENTITY}-copy`)!;
    expect((copy as { characterId: string }).characterId).toBe('demo-humanoid');
  });

  it('avoids collisions with a stable counter rather than a random suffix', () => {
    expect(uniqueEntityId('a', [{ id: 'a' }, { id: 'a-2' }])).toBe('a-3');
    expect(uniqueEntityId('a', [])).toBe('a');
  });
});

describe('scene.reorder_entity', () => {
  it('changes tick order deterministically and stages the list path', () => {
    const result = session().dispatch({
      type: 'scene.reorder_entity',
      entityId: SCRIPTED_ENTITY,
      toIndex: 0,
    });
    expect(result.ok).toBe(true);
    expect(result.document!.entities[0]!.id).toBe(SCRIPTED_ENTITY);
    expect(result.changedPaths).toEqual(['/entities']);
  });

  it('refuses an out-of-range index', () => {
    expect(
      session().dispatch({ type: 'scene.reorder_entity', entityId: SCRIPTED_ENTITY, toIndex: 99 }).ok,
    ).toBe(false);
  });
});

describe('scene.bind_controller', () => {
  it('binds an AI channel through the same operation a human drag uses', () => {
    const result = session().dispatch({
      type: 'scene.bind_controller',
      entityId: CONTROLLED_ENTITY,
      controller: { kind: 'ai', channelId: 'planner-a' },
    });
    expect(result.ok).toBe(true);
    expect(result.changedPaths).toEqual([`/entities/${CONTROLLED_ENTITY}/controller`]);
  });

  it('refuses to bind a controller on a camera', () => {
    const s = session();
    const cameraId = s.previewDocument.entities.find((entity) => entity.kind === 'camera')!.id;
    const result = s.dispatch({
      type: 'scene.bind_controller',
      entityId: cameraId,
      controller: { kind: 'none' },
    });
    expect(result.ok).toBe(false);
    expect(result.issues[0]!.keyword).toBe('kind');
  });

  it('refuses a script binding naming an unknown track', () => {
    const result = session().dispatch({
      type: 'scene.bind_controller',
      entityId: CONTROLLED_ENTITY,
      controller: { kind: 'script', trackId: 'no-such-track' },
    });
    expect(result.ok).toBe(false);
  });
});

describe('preview is not stage', () => {
  it('changes the preview and leaves the repository document alone', () => {
    const s = session();
    const before = s.repositoryDocument;
    s.dispatch({ type: 'scene.rename', displayName: 'Renamed' });

    expect(s.previewDocument.displayName).toBe('Renamed');
    expect(s.repositoryDocument).toBe(before);
    expect(s.repositoryDocument.displayName).not.toBe('Renamed');
    expect(s.isDirty).toBe(true);
    // Dispatching does not stage.
    expect(s.stagedPaths).toEqual([]);
    expect(s.staged).toEqual([]);
  });
});

describe('stage is not apply', () => {
  it('records paths against the baseline without changing the repository', () => {
    const s = session();
    const before = s.repositoryDocument;
    s.dispatch({ type: 'scene.rename', displayName: 'Renamed' });
    s.stageAll();

    expect(s.stagedPaths).toEqual(['/displayName']);
    expect(s.repositoryDocument).toBe(before);
  });

  it('builds a staged document holding only the staged operations', () => {
    const s = session();
    s.dispatch({ type: 'scene.rename', displayName: 'Staged name' });
    s.stageAll();
    s.dispatch({ type: 'scene.rename_entity', entityId: CONTROLLED_ENTITY, displayName: 'Unstaged' });

    const staged = s.buildStagedDocument();
    expect(staged.document!.displayName).toBe('Staged name');
    const entity = staged.document!.entities.find((entry) => entry.id === CONTROLLED_ENTITY)!;
    expect(entity.displayName).not.toBe('Unstaged');
    // …while the preview still shows both.
    expect(
      s.previewDocument.entities.find((entry) => entry.id === CONTROLLED_ENTITY)!.displayName,
    ).toBe('Unstaged');
  });

  it('carries the observed baseline revision into the apply request', () => {
    const s = session();
    s.dispatch({ type: 'scene.rename', displayName: 'Renamed' });
    s.stageAll();

    const request = s.buildApplyRequest('rename the scene');
    expect(request.expected.projectRevisionId).toBe(project.revisionId);
    expect(request.target).toEqual({ kind: 'scene', id: acceptanceScene().id });
    expect(request.operations).toHaveLength(1);
    expect(request.intent).toBe('rename the scene');
  });

  it('keeps staged work after a failed validate', () => {
    const s = session();
    s.dispatch({ type: 'scene.rename', displayName: 'Renamed' });
    s.stageAll();
    expect(s.validate().valid).toBe(true);
    expect(s.staged).toHaveLength(1);
  });
});

describe('apply', () => {
  it('adopts the applied document as the new baseline and clears staging', () => {
    const s = session();
    s.dispatch({ type: 'scene.rename', displayName: 'Applied' });
    s.stageAll();
    const applied = s.buildStagedDocument().document!;

    s.acceptApplied(applied, 'rev-applied-0001');
    expect(s.baseRevisionId).toBe('rev-applied-0001');
    expect(s.repositoryDocument.displayName).toBe('Applied');
    expect(s.previewDocument.displayName).toBe('Applied');
    expect(s.stagedPaths).toEqual([]);
    expect(s.isDirty).toBe(false);
    expect(s.canUndo).toBe(false);
  });
});

/**
 * An operation that resolves to the value already there changed nothing, and a
 * session that recorded it would be claiming otherwise to everything
 * downstream: the dirty indicator, the undo stack, and — the one that actually
 * writes — the operation list Apply replays.
 */
describe('an operation that changes nothing is not history', () => {
  it('reports success with no changed paths when a rename is a no-op', () => {
    const s = session();
    const result = s.dispatch({ type: 'scene.rename', displayName: s.previewDocument.displayName });

    expect(result.ok).toBe(true);
    expect(result.changedPaths).toEqual([]);
  });

  it('creates no history, no pending operation and no dirty state', () => {
    const s = session();
    s.dispatch({ type: 'scene.rename', displayName: s.previewDocument.displayName });

    expect(s.isDirty).toBe(false);
    expect(s.canUndo).toBe(false);
    expect(s.pending).toEqual([]);
    expect(s.staged).toEqual([]);
    expect(s.stagedPaths).toEqual([]);
  });

  it('stages nothing, so Apply would carry no operation at all', () => {
    const s = session();
    s.dispatch({ type: 'scene.rename', displayName: s.previewDocument.displayName });
    s.stageAll();

    expect(s.buildApplyRequest('a rename to the same name').operations).toEqual([]);
  });

  it('treats setting a transform to its current value as a no-op', () => {
    const s = session();
    const entity = s.previewDocument.entities.find((entry) => entry.id === CONTROLLED_ENTITY)!;

    // A structurally fresh object carrying identical numbers. Reference
    // comparison would call this a change; the document did not move.
    const result = s.dispatch({
      type: 'scene.set_transform',
      entityId: CONTROLLED_ENTITY,
      transform: JSON.parse(JSON.stringify(entity.transform)) as typeof entity.transform,
    });

    expect(result.ok).toBe(true);
    expect(result.changedPaths).toEqual([]);
    expect(s.isDirty).toBe(false);
    expect(s.canUndo).toBe(false);
  });

  it('still records a transform edit that genuinely moves the entity', () => {
    const s = session();
    const entity = s.previewDocument.entities.find((entry) => entry.id === CONTROLLED_ENTITY)!;
    const result = s.dispatch({
      type: 'scene.set_transform',
      entityId: CONTROLLED_ENTITY,
      transform: {
        ...entity.transform,
        position: { ...entity.transform.position, x: entity.transform.position.x + 1 },
      },
    });

    expect(result.changedPaths).toEqual([`/entities/${CONTROLLED_ENTITY}/transform`]);
    expect(s.isDirty).toBe(true);
    expect(s.canUndo).toBe(true);
  });
});

/**
 * Undo, redo and the staged operation list have to describe the same edits.
 * The preview is what the human reads; the operation list is what Apply
 * replays. Any disagreement between them writes something nobody saw.
 */
describe('undo, redo and staging agree', () => {
  it('unstages an operation that is undone', () => {
    const s = session();
    s.dispatch({ type: 'scene.rename', displayName: 'Staged then undone' });
    s.stageAll();
    expect(s.staged).toHaveLength(1);

    s.undo();
    expect(s.staged).toHaveLength(0);
    expect(s.stagedPaths).toEqual([]);
    expect(s.buildStagedDocument().document!.displayName).not.toBe('Staged then undone');
  });

  /*
   * Redo restores the staged status the operation had before the Undo. Both
   * halves matter, and the pair of tests below is the whole point:
   *
   * An edit that was never staged comes back unstaged, because staging it would
   * add work to an Apply the human never approved.
   *
   * An edit that *was* staged comes back staged, because silently demoting it
   * turns Undo/Redo into a way to drop approved work out of an Apply — and the
   * human has no reason to re-check a staging decision they already made and
   * then visibly reversed and reinstated.
   */
  it('restores an unstaged operation on redo as unstaged', () => {
    const s = session();
    s.dispatch({ type: 'scene.rename', displayName: 'Round trip' });
    s.undo();
    s.redo();

    expect(s.previewDocument.displayName).toBe('Round trip');
    expect(s.staged).toHaveLength(0);
    expect(s.pending).toHaveLength(1);

    s.stageAll();
    expect(s.buildStagedDocument().document!.displayName).toBe('Round trip');
  });

  it('restores a staged operation on redo as staged', () => {
    const s = session();
    s.dispatch({ type: 'scene.rename', displayName: 'Staged round trip' });
    s.stageAll();
    expect(s.staged).toHaveLength(1);

    s.undo();
    // Undone means gone from the Apply, whatever it was before.
    expect(s.staged).toHaveLength(0);

    s.redo();
    expect(s.previewDocument.displayName).toBe('Staged round trip');
    expect(s.staged).toHaveLength(1);
    expect(s.pending).toHaveLength(0);
    expect(s.stagedPaths).toEqual(['/displayName']);
    expect(s.buildStagedDocument().document!.displayName).toBe('Staged round trip');
  });

  it('appears exactly once after undo, redo and stage all', () => {
    const s = session();
    s.dispatch({ type: 'scene.rename', displayName: 'Once' });
    s.undo();
    s.redo();
    s.stageAll();

    expect(s.staged).toHaveLength(1);
    expect(s.buildStagedDocument().document!.displayName).toBe('Once');
  });

  it('preserves an unrelated staged operation when a later edit is undone', () => {
    const s = session();
    s.dispatch({ type: 'scene.rename', displayName: 'A stays' });
    s.stageAll();
    s.dispatch({ type: 'scene.rename_entity', entityId: CONTROLLED_ENTITY, displayName: 'B goes' });
    s.undo();

    // Undoing B must not clear A. Clearing every staged operation on any Undo
    // would make the invariant hold for the wrong reason.
    expect(s.staged).toHaveLength(1);
    const staged = s.buildStagedDocument().document!;
    expect(staged.displayName).toBe('A stays');
    expect(staged.entities.find((entry) => entry.id === CONTROLLED_ENTITY)!.displayName).not.toBe(
      'B goes',
    );
  });

  it('discards the redo branch on a new edit without touching staged work', () => {
    const s = session();
    s.dispatch({ type: 'scene.rename', displayName: 'A staged' });
    s.stageAll();
    s.dispatch({ type: 'scene.rename_entity', entityId: CONTROLLED_ENTITY, displayName: 'B undone' });
    s.undo();
    expect(s.canRedo).toBe(true);

    s.dispatch({ type: 'scene.rename_entity', entityId: CONTROLLED_ENTITY, displayName: 'C new' });
    expect(s.canRedo).toBe(false);
    expect(s.staged).toHaveLength(1);
    expect(s.buildStagedDocument().document!.displayName).toBe('A staged');
  });

  /*
   * A single semantic edit can touch several paths. Staging one of them stages
   * the whole operation, because half an operation is not something the Apply
   * request can describe.
   */
  it('stages a multi-path operation atomically from any one of its paths', () => {
    const s = session();
    s.dispatch({
      type: 'scene.place_asset',
      entityId: 'atomic-light',
      displayName: 'Atomic light',
      asset: { kind: 'light', lightType: 'point' },
    });
    s.stage('/entities/atomic-light');

    expect(s.staged).toHaveLength(1);
    expect(s.stagedPaths).toEqual(['/entities/atomic-light']);
  });

  it('never stages an operation the preview no longer contains', () => {
    const s = session();
    s.dispatch({ type: 'scene.rename', displayName: 'Kept' });
    s.dispatch({ type: 'scene.rename_entity', entityId: CONTROLLED_ENTITY, displayName: 'Undone' });
    s.undo();
    s.stageAll();

    const staged = s.buildStagedDocument().document!;
    expect(staged.displayName).toBe('Kept');
    expect(staged.entities.find((entry) => entry.id === CONTROLLED_ENTITY)!.displayName).not.toBe(
      'Undone',
    );
    expect(staged).toEqual(s.previewDocument);
  });
});

describe('undo and redo', () => {
  it('removes and restores a placed entity with the same id and transform', () => {
    const s = session();
    const transform = defaultPlacementTransform();
    s.dispatch({
      type: 'scene.place_asset',
      entityId: 'undoable',
      displayName: 'Undoable',
      asset: { kind: 'camera' },
      transform,
    });
    expect(s.previewDocument.entities.some((entity) => entity.id === 'undoable')).toBe(true);

    expect(s.undo()).toBe(true);
    expect(s.previewDocument.entities.some((entity) => entity.id === 'undoable')).toBe(false);

    expect(s.redo()).toBe(true);
    const restored = s.previewDocument.entities.find((entity) => entity.id === 'undoable')!;
    expect(restored.transform).toEqual(transform);
  });

  it('reports nothing to undo on a fresh session', () => {
    expect(session().undo()).toBe(false);
  });
});

describe('revert and discard', () => {
  it('revert throws away preview and staged work alike', () => {
    const s = session();
    s.dispatch({ type: 'scene.rename', displayName: 'Gone' });
    s.stageAll();
    s.revert();
    expect(s.isDirty).toBe(false);
    expect(s.stagedPaths).toEqual([]);
  });

  it('discardStaged keeps the preview', () => {
    const s = session();
    s.dispatch({ type: 'scene.rename', displayName: 'Kept' });
    s.stageAll();
    s.discardStaged();
    expect(s.previewDocument.displayName).toBe('Kept');
    expect(s.stagedPaths).toEqual([]);
  });
});

describe('target isolation', () => {
  it('keys drafts by project, revision, target kind and target id', () => {
    const base = { projectId: 'demo', repositoryRevisionId: 'r1' };
    const sceneDraft = draftKey({ ...base, target: { kind: 'scene', id: 'a' } });
    expect(sceneDraft).not.toBe(draftKey({ ...base, target: { kind: 'scene', id: 'b' } }));
    expect(sceneDraft).not.toBe(draftKey({ ...base, target: { kind: 'character', id: 'a' } }));
    /*
     * A draft keyed on the target alone survives a repository change and is
     * then reapplied on top of a document it was never based on — silently, and
     * looking exactly like a successful restore.
     */
    expect(sceneDraft).not.toBe(
      draftKey({ ...base, repositoryRevisionId: 'r2', target: { kind: 'scene', id: 'a' } }),
    );
  });

  it('does not let one scene session touch another scene', () => {
    const sceneA = acceptanceScene();
    const sceneB: SceneDefinition = { ...acceptanceScene(), id: 'other-scene', entities: [] };
    const a = session(sceneA);
    a.dispatch({ type: 'scene.rename', displayName: 'Only A' });
    a.stageAll();

    const b = session(sceneB);
    expect(b.isDirty).toBe(false);
    expect(b.stagedPaths).toEqual([]);
    expect(b.previewDocument.displayName).toBe(sceneB.displayName);
    expect(targetKey(a.target)).not.toBe(targetKey(b.target));
  });
});

describe('actor parity', () => {
  /*
   * A UI drag and an AI command that perform the same authored change must
   * dispatch the same typed operation. Anything else means the AI path and the
   * human path can disagree, and only one of them is exercised by the tests.
   */
  it('produces the same document for a human and an AI actor', () => {
    const operation: SceneOperation = {
      type: 'scene.set_transform',
      entityId: CONTROLLED_ENTITY,
      transform: {
        position: { x: 3, y: 0, z: 4 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        scale: { x: 1, y: 1, z: 1 },
      },
    };
    const human = session().dispatch(operation, { actor: 'human' });
    const ai = session().dispatch(operation, { actor: 'ai' });
    expect(JSON.stringify(ai.document)).toBe(JSON.stringify(human.document));
  });
});

describe('protection', () => {
  function lockedScene(): SceneDefinition {
    const scene = acceptanceScene();
    return {
      ...scene,
      entities: scene.entities.map((entity) =>
        entity.id === CONTROLLED_ENTITY
          ? { ...entity, protection: { level: 'locked' as const, reason: 'tuned by hand' } }
          : entity,
      ),
    };
  }

  const move: SceneOperation = {
    type: 'scene.set_transform',
    entityId: CONTROLLED_ENTITY,
    transform: {
      position: { x: 9, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      scale: { x: 1, y: 1, z: 1 },
    },
  };

  it.each(['human', 'ai'] as const)('refuses a locked entity for a %s actor', (actor) => {
    const result = session(lockedScene()).dispatch(move, { actor });
    expect(result.ok).toBe(false);
    expect(result.issues[0]!.keyword).toBe('protection');
  });

  it('allows the edit once a human explicitly unlocks the path', () => {
    const s = session(lockedScene());
    s.unlock(`/entities/${CONTROLLED_ENTITY}/transform`);
    expect(s.dispatch(move, { actor: 'human' }).ok).toBe(true);
  });

  it('leaves an unprotected entity editable', () => {
    expect(session().dispatch(move).ok).toBe(true);
  });
});
