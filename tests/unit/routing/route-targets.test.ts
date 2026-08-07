/**
 * Route identity.
 *
 * The assertions here are mostly *negative*, and that is the point: the failure
 * this layer exists to prevent is a page that renders perfectly while editing a
 * document the URL did not name. A resolver that falls back to the first item
 * produces exactly that, and no visual test would catch it.
 *
 * Pure resolver tests rather than rendered-router tests: "this id resolves to
 * this character, or to nothing" needs no DOM, and a test that needed one would
 * be the first thing skipped in an environment without browsers.
 */
import { describe, expect, it } from 'vitest';
import type { ProjectDefinition } from '@atc/schema';
import {
  defaultRigEditorCharacterId,
  resolveRigEditorTarget,
} from '../../../apps/web/src/rig-editor/resolve-rig-editor-target.ts';
import {
  defaultSceneEditorSceneId,
  resolveSceneEditorTarget,
} from '../../../apps/web/src/scene-editor/resolve-scene-editor-target.ts';
import { rigEditorPath, routeId, sceneEditorPath } from '../../../apps/web/src/app/routes.ts';
import { loadDemoProject } from '../../fixtures/project.ts';

const project = loadDemoProject();

describe('rig route identity', () => {
  it('resolves the exact character the route names', () => {
    const target = resolveRigEditorTarget(project, 'demo-humanoid');
    expect(target.status).toBe('resolved');
    expect(target.status === 'resolved' && target.character.id).toBe('demo-humanoid');
  });

  /*
   * The single most plausible-looking way to break route identity: the page
   * renders, the panels render, and the human tunes the wrong character.
   */
  it('does not fall back to the first character for an unknown id', () => {
    const target = resolveRigEditorTarget(project, 'no-such-character');
    expect(target.status).toBe('missing');
    expect(target.status === 'missing' && target.characterId).toBe('no-such-character');
  });

  it('reports a missing route parameter differently from an unknown id', () => {
    expect(resolveRigEditorTarget(project, null).status).toBe('no-target');
  });

  it('offers the ids that do exist, so the error is actionable', () => {
    const target = resolveRigEditorTarget(project, 'nope');
    expect(target.status === 'missing' && target.available.length).toBe(project.characters.length);
  });

  it('matches exactly — no case folding, no prefix matching', () => {
    expect(resolveRigEditorTarget(project, 'DEMO-HUMANOID').status).toBe('missing');
    expect(resolveRigEditorTarget(project, 'demo').status).toBe('missing');
    expect(resolveRigEditorTarget(project, 'demo-humanoid ').status).toBe('missing');
  });

  it('uses activeCharacterId only to answer where "/" should go', () => {
    expect(defaultRigEditorCharacterId(project)).toBe(project.activeCharacterId);
    // …and a stale preference never redirects an explicit route.
    const stale = { ...project, activeCharacterId: 'gone' } as ProjectDefinition;
    expect(resolveRigEditorTarget(stale, 'demo-humanoid').status).toBe('resolved');
    expect(defaultRigEditorCharacterId(stale)).toBe(project.characters[0]!.id);
  });
});

describe('scene route identity', () => {
  const sceneId = project.scenes[0]!.id;

  it('resolves the exact scene the route names', () => {
    const target = resolveSceneEditorTarget(project, sceneId);
    expect(target.status).toBe('resolved');
    expect(target.status === 'resolved' && target.scene.id).toBe(sceneId);
  });

  it('does not fall back to the first scene for an unknown id', () => {
    expect(resolveSceneEditorTarget(project, 'no-such-scene').status).toBe('missing');
  });

  it('does not consult activeSceneId when the route is explicit', () => {
    const stale = { ...project, activeSceneId: 'no-such-scene' } as ProjectDefinition;
    expect(resolveSceneEditorTarget(stale, sceneId).status).toBe('resolved');
  });

  /*
   * A project with no scenes is a legitimate shape, not an error: the Rig
   * Editor needs no Scene, and creating one so a link had a destination would
   * persist a Scene nobody composed.
   */
  it('reports no default scene rather than inventing one', () => {
    const characterOnly = { ...project, scenes: [], activeSceneId: undefined } as ProjectDefinition;
    expect(defaultSceneEditorSceneId(characterOnly)).toBeNull();
    expect(resolveSceneEditorTarget(characterOnly, 'anything').status).toBe('missing');
  });
});

describe('route paths', () => {
  it('uses path segments, never query parameters, for resource identity', () => {
    expect(rigEditorPath('honoka')).toBe('/edit/rig/honoka');
    expect(sceneEditorPath('test-room')).toBe('/edit/scene/test-room');
    expect(rigEditorPath('honoka')).not.toContain('?');
  });

  /*
   * Encoded once. Encoding at both the builder and the reader produces %2520,
   * and encoding at neither breaks the first id that needs it.
   */
  it('encodes the id exactly once', () => {
    expect(rigEditorPath('a b')).toBe('/edit/rig/a%20b');
    expect(routeId(decodeURIComponent('a%20b'))).toBe('a b');
  });

  it('treats an absent or blank parameter as no target', () => {
    expect(routeId(undefined)).toBeNull();
    expect(routeId('')).toBeNull();
    expect(routeId('   ')).toBeNull();
  });
});
