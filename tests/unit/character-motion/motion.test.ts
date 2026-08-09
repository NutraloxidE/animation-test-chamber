import { describe, expect, it } from 'vitest';
import { ControllableCharacter, InjectedCharacterIntentSource, NeutralCharacterIntentSource, neutralIntent, seedOf, type CharacterIntentSource } from '@atc/character-control-runtime';
import { resolveCharacterAnimationBundle, materializeResolvedProject } from '@atc/animation-asset-runtime';
import { findTerrainPreset } from '@atc/terrain-runtime';
import { UNIT_SCALE, yawToQuaternion } from '@atc/schema';
import { demoRegistry, loadDemoProject } from '../../fixtures/project.ts';

function character(id = 'motion-test', intentSource: CharacterIntentSource = new NeutralCharacterIntentSource()) {
  const project = loadDemoProject();
  const definition = project.characters.find((entry) => entry.id === 'demo-humanoid')!;
  const { bundle } = resolveCharacterAnimationBundle({ registry: demoRegistry(), project, characterId: definition.id });
  return new ControllableCharacter({ instanceId: id, resolvedProject: materializeResolvedProject({ project, character: definition, bundle }), initialTransform: { position: { x: 0, y: 2, z: 0 }, rotation: yawToQuaternion(0), scale: { ...UNIT_SCALE } }, terrain: findTerrainPreset(project.defaultTerrainPresetId), intentSource, seed: seedOf(id) });
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
    expect(subject.setGameplayParameter('gameplay.invalid', Number.NaN).ok).toBe(false);
    expect(subject.gameplaySnapshot().gameplayParameters).toEqual({ 'gameplay.dashing': true });
    subject.step(0, { cameraYawRad: 0 });
    expect(subject.gameplaySnapshot().gameplayParameters).toEqual({});
  });

  it('applies velocity and explicit facing contracts', () => {
    const subject = character();
    subject.enqueueCommand({ type: 'motion-override', key: 'east', velocity: { x: 8, y: 0, z: 0 }, space: 'world', durationTicks: 1, horizontal: 'replace', vertical: 'preserve', facing: 'velocity' }, 'dash');
    expect(subject.step(0, { cameraYawRad: 0 }).record.yawRad).toBeCloseTo(Math.PI / 2, 5);
    subject.enqueueCommand({ type: 'motion-override', key: 'aim', velocity: { x: 0, y: 0, z: 0 }, space: 'world', durationTicks: 1, horizontal: 'replace', vertical: 'preserve', facing: { yawRad: -0.75 } }, 'dash');
    expect(subject.step(1, { cameraYawRad: 0 }).record.yawRad).toBeCloseTo(-0.75, 5);
  });

  it('arbitrates movement-scale channels independently', () => {
    const source = new InjectedCharacterIntentSource(0);
    const subject = character('scaled', source);
    source.inject({ ...neutralIntent(), moveX: 1 });
    subject.enqueueCommand({ type: 'movement-scale', key: 'slow', speedScale: 0.5, durationTicks: 1, priority: 100 }, 'speed-script');
    subject.enqueueCommand({ type: 'movement-scale', key: 'turn-lock', speedScale: 1, turnScale: 0, durationTicks: 1, priority: 50 }, 'turn-script');
    const record = subject.step(0, { cameraYawRad: 0 }).record;
    expect(record.yawRad).toBe(0);
    expect(Math.abs(record.velocity.x)).toBeGreaterThan(0);
  });

  it('keeps same-key commands from different script origins independent', () => {
    const subject = character();
    subject.enqueueCommand({ type: 'motion-override', key: 'knockback', velocity: { x: 1, y: 0, z: 0 }, space: 'world', durationTicks: 2, horizontal: 'add', vertical: 'preserve' }, 'hit-a/script-a@1.0.0');
    subject.enqueueCommand({ type: 'motion-override', key: 'knockback', velocity: { x: 0, y: 0, z: 1 }, space: 'world', durationTicks: 2, horizontal: 'add', vertical: 'preserve' }, 'hit-b/script-b@1.0.0');
    subject.step(0, { cameraYawRad: 0 });
    expect(subject.gameplaySnapshot().activeMotionOverrides.map((entry) => entry.sourceComponentId)).toEqual(['hit-a/script-a@1.0.0', 'hit-b/script-b@1.0.0']);
  });

  it('uses priority then stable origin for replacement arbitration', () => {
    const high = character('priority');
    high.enqueueCommand({ type: 'motion-override', key: 'low', velocity: { x: 2, y: 0, z: 0 }, space: 'world', durationTicks: 1, priority: 1, horizontal: 'replace', vertical: 'preserve' }, 'z-script');
    high.enqueueCommand({ type: 'motion-override', key: 'high', velocity: { x: 7, y: 0, z: 0 }, space: 'world', durationTicks: 1, priority: 2, horizontal: 'replace', vertical: 'preserve' }, 'a-script');
    expect(high.step(0, { cameraYawRad: 0 }).record.velocity.x).toBe(7);
    const tied = character('tie');
    tied.enqueueCommand({ type: 'motion-override', key: 'same', velocity: { x: 3, y: 0, z: 0 }, space: 'world', durationTicks: 1, priority: 1, horizontal: 'replace', vertical: 'preserve' }, 'z-script');
    tied.enqueueCommand({ type: 'motion-override', key: 'same', velocity: { x: 5, y: 0, z: 0 }, space: 'world', durationTicks: 1, priority: 1, horizontal: 'replace', vertical: 'preserve' }, 'a-script');
    expect(tied.step(0, { cameraYawRad: 0 }).record.velocity.x).toBe(5);
  });

  it('teleports runtime state without mutating canonical data', () => {
    const subject = character();
    const canonical = JSON.stringify(subject.resolvedProject);
    subject.enqueueCommand({ type: 'teleport', position: { x: 4, y: 3, z: -2 }, yawRad: 1, velocity: 'clear' }, 'portal');
    const record = subject.step(0, { cameraYawRad: 0 }).record;
    expect(record.position).toMatchObject({ x: 4, z: -2 });
    expect(record.yawRad).toBe(1);
    expect(JSON.stringify(subject.resolvedProject)).toBe(canonical);
  });

  it('isolates command queues between character instances', () => {
    const commanded = character('commanded');
    const untouched = character('untouched');
    commanded.enqueueCommand({ type: 'impulse', deltaVelocity: { x: 5, y: 0, z: 0 }, space: 'world' }, 'hit');
    expect(commanded.step(0, { cameraYawRad: 0 }).record.velocity.x).toBe(5);
    expect(untouched.step(0, { cameraYawRad: 0 }).record.velocity.x).toBe(0);
  });

  it('rejects invalid commands and enforces a finite queue budget', () => {
    const subject = character();
    expect(subject.enqueueCommand({ type: 'impulse', deltaVelocity: { x: Number.NaN, y: 0, z: 0 }, space: 'world' }, 'bad').ok).toBe(false);
    for (let index = 0; index < 16; index += 1) expect(subject.enqueueCommand({ type: 'impulse', deltaVelocity: { x: 0, y: 0, z: 0 }, space: 'world' }, 'script').ok).toBe(true);
    expect(subject.enqueueCommand({ type: 'impulse', deltaVelocity: { x: 0, y: 0, z: 0 }, space: 'world' }, 'script')).toMatchObject({ ok: false, code: 'operation-budget-exceeded' });
    for (const origin of ['a', 'b', 'c']) for (let index = 0; index < 16; index += 1) expect(subject.enqueueCommand({ type: 'impulse', deltaVelocity: { x: 0, y: 0, z: 0 }, space: 'world' }, origin).ok).toBe(true);
    expect(subject.enqueueCommand({ type: 'impulse', deltaVelocity: { x: 0, y: 0, z: 0 }, space: 'world' }, 'new-origin')).toMatchObject({ ok: false, code: 'operation-budget-exceeded' });
  });
});
