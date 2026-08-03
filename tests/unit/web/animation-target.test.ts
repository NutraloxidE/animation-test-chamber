/**
 * The animation target model, on its own.
 *
 * These assert the properties the Animation and Graph workspaces are built on:
 * that Follow Selection derives rather than stores, that Pin survives a
 * selection change, that a deleted pinned target is *reported* rather than
 * silently replaced, and — the one the old global state list could not
 * satisfy — that two instances on different Character Definitions resolve to
 * their own behaviours and their own clips.
 */
import { describe, expect, it } from 'vitest';
import type { ProjectDefinition, ResolvedProject, WorldDefinition } from '@atc/schema';
import {
  FOLLOW_SELECTION,
  effectiveAnimationTarget,
  resolveAnimationTargetMode,
} from '../../../apps/web/src/animation/target/animation-target.ts';
import {
  reachableClips,
  resolveAnimationTarget,
  resolveStateClip,
  statesOnLayer,
  type AnimationTargetSource,
} from '../../../apps/web/src/animation/target/resolve-animation-target.ts';
import { loadDemoProject, loadResolvedDemoProject } from '../../fixtures/project.ts';
import { CONTROLLED, SCRIPTED, loadWorldFixture } from '../../fixtures/world.ts';

const world = loadWorldFixture();

describe('animation target mode', () => {
  it('follows the scene selection by default', () => {
    expect(
      effectiveAnimationTarget(
        FOLLOW_SELECTION,
        { kind: 'instance', instanceId: CONTROLLED },
        world,
      ),
    ).toBe(CONTROLLED);
    expect(
      effectiveAnimationTarget(FOLLOW_SELECTION, { kind: 'instance', instanceId: SCRIPTED }, world),
    ).toBe(SCRIPTED);
  });

  it('resolves an attachment selection to its parent instance', () => {
    expect(
      effectiveAnimationTarget(
        FOLLOW_SELECTION,
        { kind: 'attachment', instanceId: CONTROLLED, slotId: 'shield' },
        world,
      ),
    ).toBe(CONTROLLED);
  });

  it('has no target for world, terrain or camera selections', () => {
    for (const selection of [{ kind: 'world' }, { kind: 'terrain' }, { kind: 'camera' }] as const) {
      const resolution = resolveAnimationTargetMode(FOLLOW_SELECTION, selection, world);
      expect(resolution.instanceId).toBeNull();
      expect(resolution.issue).not.toBeNull();
    }
  });

  it('keeps a pinned target while the scene selection moves', () => {
    const pinned = { kind: 'pinned', instanceId: CONTROLLED } as const;
    // The scene selection is somewhere else entirely; the target is not.
    expect(
      effectiveAnimationTarget(pinned, { kind: 'instance', instanceId: SCRIPTED }, world),
    ).toBe(CONTROLLED);
    expect(resolveAnimationTargetMode(pinned, { kind: 'world' }, world).pinned).toBe(true);
  });

  it('reports a deleted pinned target instead of silently choosing another', () => {
    const withoutControlled: WorldDefinition = {
      ...world,
      instances: world.instances.filter((instance) => instance.id !== CONTROLLED),
    };
    const resolution = resolveAnimationTargetMode(
      { kind: 'pinned', instanceId: CONTROLLED },
      { kind: 'instance', instanceId: SCRIPTED },
      withoutControlled,
    );
    // The failure mode this exists to prevent: falling back to whatever else
    // is in the world, so the user previews a character they never chose.
    expect(resolution.instanceId).toBeNull();
    expect(resolution.issue).toEqual({ kind: 'pinned-target-missing', instanceId: CONTROLLED });
  });
});

/**
 * Two instances, two Character Definitions, two Behaviors.
 *
 * The behaviours differ by at least one state id, which is the whole assertion:
 * the previous implementation listed states from one globally resolved project,
 * so target A was offered target B's states and previewing one produced an
 * empty pose rather than an error.
 */
function twoCharacterSource(): {
  source: AnimationTargetSource;
  world: WorldDefinition;
} {
  const demo = loadDemoProject();
  const base = demo.characters[0]!;
  const characterA = { ...base, id: 'character-a' };
  const characterB = { ...base, id: 'character-b' };

  const project: ProjectDefinition = {
    ...demo,
    characters: [characterA, characterB],
  };

  const twoInstanceWorld: WorldDefinition = {
    ...world,
    instances: [
      { ...world.instances[0]!, id: 'instance-a', source: { kind: 'character', characterId: 'character-a' } },
      { ...world.instances[1]!, id: 'instance-b', source: { kind: 'character', characterId: 'character-b' } },
    ],
  };

  // Two resolved documents that genuinely differ, standing in for two resolved
  // Behavior assets. The seam under test is "resolution starts at the
  // instance", and that is exactly what this exercises.
  const resolvedA = resolvedWith('a-only-state', 'clip-a', 0.4);
  const resolvedB = resolvedWith('b-only-state', 'clip-b', 1.2);

  return {
    world: twoInstanceWorld,
    source: {
      world: twoInstanceWorld,
      project,
      resolvedProjectFor: (instanceId) =>
        instanceId === 'instance-a' ? resolvedA : instanceId === 'instance-b' ? resolvedB : null,
      loadoutFor: () => ({ weaponModeId: 'unarmed', equipment: {} }),
    },
  };
}

function resolvedWith(stateId: string, clipId: string, durationSec: number): ResolvedProject {
  // Derived from the real resolved demo document rather than hand-built, so
  // the shape under test is the shape the app actually resolves.
  const demo = loadResolvedDemoProject();
  const template = demo.graph.states.find((state) => state.layer === 'locomotion')!;
  const clipTemplate = demo.clips[0]!;
  return {
    ...demo,
    graph: {
      ...demo.graph,
      states: [{ ...template, id: stateId, layer: 'locomotion', motionSlot: 'locomotion.only' }],
      transitions: [],
    },
    clips: [{ ...clipTemplate, id: clipId, durationSec, loop: true, events: [] }],
    motionBindings: { 'locomotion.only': clipId },
    contextualMotionBindings: {},
  };
}

describe('target-specific resolution', () => {
  it('offers each target only its own behaviour states', () => {
    const { source } = twoCharacterSource();
    const a = resolveAnimationTarget(source, 'instance-a');
    const b = resolveAnimationTarget(source, 'instance-b');
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    const statesA = statesOnLayer(a.target, 'locomotion').map((state) => state.id);
    const statesB = statesOnLayer(b.target, 'locomotion').map((state) => state.id);

    expect(statesA).toContain('a-only-state');
    expect(statesA).not.toContain('b-only-state');
    expect(statesB).toContain('b-only-state');
    expect(statesB).not.toContain('a-only-state');
  });

  it('resolves each target to its own clip and its own authored duration', () => {
    const { source } = twoCharacterSource();
    const a = resolveAnimationTarget(source, 'instance-a');
    const b = resolveAnimationTarget(source, 'instance-b');
    if (!a.ok || !b.ok) throw new Error('expected both targets to resolve');

    expect(resolveStateClip(a.target, 'a-only-state')).toMatchObject({
      clipId: 'clip-a',
      durationSec: 0.4,
    });
    expect(resolveStateClip(b.target, 'b-only-state')).toMatchObject({
      clipId: 'clip-b',
      durationSec: 1.2,
    });
    // The two are not the same document: a global shortcut would make them so.
    expect(a.target.resolvedProject).not.toBe(b.target.resolvedProject);
  });

  it('lists clips reachable through the target motion set, not the repository', () => {
    const { source } = twoCharacterSource();
    const a = resolveAnimationTarget(source, 'instance-a');
    if (!a.ok) throw new Error('expected instance-a to resolve');
    expect(reachableClips(a.target).map((clip) => clip.id)).toEqual(['clip-a']);
  });

  it('reports an explicit failure rather than returning a blank target', () => {
    const { source } = twoCharacterSource();
    expect(resolveAnimationTarget(source, 'no-such-instance')).toEqual({
      ok: false,
      failure: { code: 'unknown-instance', instanceId: 'no-such-instance' },
    });
  });
});
