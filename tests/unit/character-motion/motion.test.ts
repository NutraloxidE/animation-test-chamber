import { describe, expect, it } from 'vitest';
import { ControllableCharacter, NeutralCharacterIntentSource, seedOf } from '@atc/character-control-runtime';
import { resolveCharacterAnimationBundle, materializeResolvedProject } from '@atc/animation-asset-runtime';
import { findTerrainPreset } from '@atc/terrain-runtime';
import { UNIT_SCALE, yawToQuaternion } from '@atc/schema';
import { demoRegistry, loadDemoProject } from '../../fixtures/project.ts';

function character(id = 'motion-test') {
  const project = loadDemoProject();
  const definition = project.characters.find((entry) => entry.id === 'demo-humanoid')!;
  const { bundle } = resolveCharacterAnimationBundle({ registry: demoRegistry(), project, characterId: definition.id });
  return new ControllableCharacter({ instanceId: id, resolvedProject: materializeResolvedProject({ project, character: definition, bundle }), initialTransform: { position: { x: 0, y: 2, z: 0 }, rotation: yawToQuaternion(0), scale: { ...UNIT_SCALE } }, terrain: findTerrainPreset(project.defaultTerrainPresetId), intentSource: new NeutralCharacterIntentSource(), seed: seedOf(id) });
}

describe('Character Motion Command ABI', () => {
  it('consumes an impulse on the next character step and resolves camera space', () => {
    const subject = character();
    const before = subject.step(0, { cameraYawRad: Math.PI / 2 }).record;
    expect(subject.enqueueCommand({ type: 'impulse', deltaVelocity: { x: 0, y: 0, z: 6 }, space: 'camera' }, 'script')).toEqual({ ok: true });
    expect(subject.lastRecord).toBe(before);
    const after = subject.step(1, { cameraYawRad: Math.PI / 2 }).record;
    expect(after.velocity.x).toBeGreaterThan(5);
  });

  it('keeps an override for exactly its authored duration and clears it on reset', () => {
    const subject = character();
    subject.enqueueCommand({ type: 'motion-override', key: 'dash', velocity: { x: 0, y: 0, z: 8 }, space: 'world', durationTicks: 2, horizontal: 'replace', vertical: 'preserve' }, 'dash-script');
    subject.step(0, { cameraYawRad: 0 });
    expect(subject.gameplaySnapshot().activeMotionOverrides[0]?.remainingTicks).toBe(1);
    subject.step(1, { cameraYawRad: 0 });
    expect(subject.gameplaySnapshot().activeMotionOverrides).toEqual([]);
    expect(subject.reset().gameplaySnapshot().activeMotionOverrides).toEqual([]);
  });

  it('exposes only namespaced, expiring gameplay parameters', () => {
    const subject = character();
    expect(subject.setGameplayParameter('grounded', true, 1).ok).toBe(false);
    expect(subject.setGameplayParameter('gameplay.dashing', true, 1).ok).toBe(true);
    expect(subject.gameplaySnapshot().gameplayParameters).toEqual({ 'gameplay.dashing': true });
    subject.step(0, { cameraYawRad: 0 });
    expect(subject.gameplaySnapshot().gameplayParameters).toEqual({});
  });

  it('rejects invalid commands and enforces a finite queue budget', () => {
    const subject = character();
    expect(subject.enqueueCommand({ type: 'impulse', deltaVelocity: { x: Number.NaN, y: 0, z: 0 }, space: 'world' }, 'bad').ok).toBe(false);
    for (let index = 0; index < 64; index += 1) expect(subject.enqueueCommand({ type: 'impulse', deltaVelocity: { x: 0, y: 0, z: 0 }, space: 'world' }, 'script').ok).toBe(true);
    expect(subject.enqueueCommand({ type: 'impulse', deltaVelocity: { x: 0, y: 0, z: 0 }, space: 'world' }, 'script')).toMatchObject({ ok: false, code: 'operation-budget-exceeded' });
  });
});
