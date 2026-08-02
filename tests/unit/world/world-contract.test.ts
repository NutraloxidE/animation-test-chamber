/**
 * The definition/instance split, asserted rather than asserted-about.
 *
 * These are the tests that would fail if two instances ever came to share a
 * mutable object, or if the world stopped ticking in a stable order — the two
 * failure modes the whole contract exists to prevent.
 */
import { describe, expect, it } from 'vitest';
import {
  ScriptedTrackIntentSource,
  hashWorldTrace,
  neutralIntent,
  observeWorld,
  flattenObservations,
  recordWorldTrace,
  animationResolutionKey,
  synthesizeLegacyWorld,
  worldOf,
  WorldRuntime,
} from '@atc/world-runtime';
import { validateAgainst, validateProjectReferences } from '@atc/schema';
import { demoRegistry, loadDemoProject } from '../../fixtures/project.ts';
import {
  CONTROLLED,
  SCRIPTED,
  createWorldRuntime,
  legacyDemoProject,
  loadWorldFixture,
  projectWithWorldFixture,
} from '../../fixtures/world.ts';

describe('world contract', () => {
  it('validates the acceptance fixture against the canonical schema', () => {
    expect(validateAgainst('WorldDefinition', loadWorldFixture()).issues).toEqual([]);
  });

  it('accepts a project carrying the acceptance world', () => {
    const result = validateProjectReferences(projectWithWorldFixture());
    expect(result.issues).toEqual([]);
    expect(result.valid).toBe(true);
  });

  /*
   * This test used to assert `controlled.resolved === scripted.resolved`.
   * That assertion encoded a bug: a `ResolvedProject` carries the character's
   * own id, display name, model path and capsule dimensions, so sharing the
   * whole object means two *different* characters on one animation set receive
   * each other's body. The corrected invariant is narrower and is the one that
   * was actually intended — share the immutable animation bundle, never the
   * character wrapper. See reports/pr14-critical-fixes.md.
   */
  it('shares immutable animation bundle members without sharing resolved project wrappers', () => {
    const runtime = createWorldRuntime();
    const controlled = runtime.instance(CONTROLLED)!;
    const scripted = runtime.instance(SCRIPTED)!;

    expect(controlled.definition.source.characterId).toBe(scripted.definition.source.characterId);
    expect(controlled.animationResolutionKey).toBe(scripted.animationResolutionKey);

    // Distinct wrappers, distinct characters.
    expect(controlled.resolved).not.toBe(scripted.resolved);
    expect(controlled.resolved.character).not.toBe(scripted.resolved.character);

    // The same objects, not merely equal ones: sharing by value would mean two
    // copies of every clip, which is what the asset references replaced.
    expect(controlled.resolved.graph).toBe(scripted.resolved.graph);
    expect(controlled.resolved.clips).toBe(scripted.resolved.clips);
    expect(controlled.resolved.character.skeleton).toBe(scripted.resolved.character.skeleton);
    expect(controlled.resolved.motionBindings).toBe(scripted.resolved.motionBindings);
  });

  it('gives each instance its own mutable simulation', () => {
    const runtime = createWorldRuntime();
    const controlled = runtime.instance(CONTROLLED)!;
    const scripted = runtime.instance(SCRIPTED)!;
    expect(controlled.simulation).not.toBe(scripted.simulation);
    expect(controlled.intentSource).not.toBe(scripted.intentSource);
  });

  it('routes local input to the bound instance only', () => {
    const runtime = createWorldRuntime();
    const forward = { ...neutralIntent(), moveY: 1 };
    for (let tick = 0; tick < 60; tick += 1) {
      runtime.injectLocalIntent(0, forward);
      runtime.step();
    }
    const controlled = runtime.instance(CONTROLLED)!;
    const scripted = runtime.instance(SCRIPTED)!;

    expect(controlled.lastIntent.moveY).toBe(1);
    // The scripted instance is on its own track; it must never see the frame
    // that was injected for player 0.
    expect(scripted.intentSource.kind).toBe('scripted-track');
    expect(controlled.lastRecord!.position).not.toEqual(scripted.lastRecord!.position);
  });

  it('keeps a neutral source neutral no matter what is injected', () => {
    const world = loadWorldFixture();
    world.instances[1]!.intentSource = { kind: 'none' };
    const runtime = createWorldRuntime(world);
    for (let tick = 0; tick < 30; tick += 1) {
      runtime.injectLocalIntent(0, { ...neutralIntent(), moveY: 1 });
      runtime.step();
    }
    const scripted = runtime.instance(SCRIPTED)!;
    expect(scripted.lastIntent).toEqual(neutralIntent());
  });

  it('ticks instances in declaration order', () => {
    const runtime = createWorldRuntime();
    expect([...runtime.instanceIds]).toEqual([CONTROLLED, SCRIPTED]);

    const reversed = loadWorldFixture();
    reversed.instances.reverse();
    expect([...createWorldRuntime(reversed).instanceIds]).toEqual([SCRIPTED, CONTROLLED]);
  });

  it('produces the same world hash on repeated runs from the same start state', () => {
    const first = hashWorldTrace(recordWorldTrace(createWorldRuntime(), 120));
    const second = hashWorldTrace(recordWorldTrace(createWorldRuntime(), 120));
    expect(second).toBe(first);
  });

  it('reproduces the initial hash after a reset', () => {
    const runtime = createWorldRuntime();
    const before = hashWorldTrace(recordWorldTrace(runtime, 90));
    const after = hashWorldTrace(recordWorldTrace(runtime.reset(), 90));
    expect(after).toBe(before);
  });

  it('does not tick a disabled instance but keeps it inspectable', () => {
    const world = loadWorldFixture();
    world.instances[1]!.enabled = false;
    const runtime = createWorldRuntime(world);
    runtime.run(30);
    expect(runtime.instance(SCRIPTED)!.lastRecord).toBeNull();
    expect(observeWorld(runtime).instances.map((entry) => entry.instanceId)).toContain(SCRIPTED);
  });

  it('uses instance ids, never array indices, in observation paths', () => {
    const runtime = createWorldRuntime();
    runtime.run(5);
    const paths = flattenObservations(observeWorld(runtime)).map((entry) => entry.path);
    expect(paths).toContain(`/world/instances/${SCRIPTED}/animation/layers/locomotion/stateId`);
    expect(paths.some((path) => /\/instances\/\d+\//.test(path))).toBe(false);
  });
});

describe('scripted intent tracks', () => {
  const track = loadWorldFixture().intentTracks[0]!;

  it('holds each authored value until the next keyframe', () => {
    const source = new ScriptedTrackIntentSource(track);
    expect(source.sample(0).moveY).toBe(0);
    expect(source.sample(29).moveY).toBe(0);
    expect(source.sample(30).moveY).toBe(1);
    expect(source.sample(119).moveY).toBe(1);
    expect(source.sample(120).moveY).toBe(0);
  });

  it('opens and closes the button edge on the exact authored ticks', () => {
    const source = new ScriptedTrackIntentSource(track);
    expect(source.sample(149).buttons.Dodge).toBe(false);
    expect(source.sample(150).buttons.Dodge).toBe(true);
    expect(source.sample(151).buttons.Dodge).toBe(true);
    expect(source.sample(152).buttons.Dodge).toBe(false);
  });

  it('is independent of authored keyframe order', () => {
    const shuffled = { ...track, keyframes: [...track.keyframes].reverse() };
    const ordered = new ScriptedTrackIntentSource(track);
    const scrambled = new ScriptedTrackIntentSource(shuffled);
    for (const tick of [0, 15, 30, 119, 120, 150, 151, 152, 239]) {
      expect(scrambled.sample(tick)).toEqual(ordered.sample(tick));
    }
  });

  it('gives two instances of the same track independent cursors at different start ticks', () => {
    const early = new ScriptedTrackIntentSource(track, 0);
    const late = new ScriptedTrackIntentSource(track, 60);
    // Tick 40: the early copy is 40 ticks in and already moving; the late one
    // has not started, so it is still neutral.
    expect(early.sample(40).moveY).toBe(1);
    expect(late.sample(40).moveY).toBe(0);
    expect(late.localTick(40)).toBe(-1);
    expect(late.localTick(90)).toBe(30);
    expect(early.localTick(90)).toBe(90);
  });

  it('loops on its authored duration', () => {
    const source = new ScriptedTrackIntentSource(track);
    expect(source.localTick(240)).toBe(0);
    expect(source.sample(240 + 30).moveY).toBe(1);
  });
});

describe('legacy compatibility', () => {
  it('synthesizes one instance from activeCharacterId', () => {
    const project = legacyDemoProject();
    expect(project.world).toBeUndefined();
    const world = worldOf(project);
    expect(world.instances).toHaveLength(1);
    expect(world.instances[0]!.source.characterId).toBe(project.activeCharacterId);
    expect(world.focusedInstanceId).toBe(world.instances[0]!.id);
    expect(validateAgainst('WorldDefinition', world).issues).toEqual([]);
  });

  it('runs a legacy project without an explicit world', () => {
    const project = legacyDemoProject();
    const runtime = new WorldRuntime({ registry: demoRegistry(), project });
    runtime.run(30);
    expect(runtime.instanceIds).toHaveLength(1);
    expect(runtime.instance(runtime.instanceIds[0]!)!.lastRecord!.tick).toBe(29);
  });

  it('does not rewrite the project on load', () => {
    const project = legacyDemoProject();
    synthesizeLegacyWorld(project);
    expect(project.world).toBeUndefined();
  });

  it('keys resolution on asset references rather than on the character id', () => {
    const project = loadDemoProject();
    const [first, second] = project.characters;
    expect(animationResolutionKey(first!)).not.toBe(animationResolutionKey(second!));
    expect(animationResolutionKey(first!)).toContain(first!.animation.behavior.assetId);
    // Renaming a character must not change what it resolves to. If the key were
    // built from the id, a duplicated character would miss the cache and get a
    // second copy of a document it is supposed to share.
    const renamed = { ...first!, id: 'renamed-character' };
    expect(animationResolutionKey(renamed)).toBe(animationResolutionKey(first!));
  });
});
