/**
 * The `ControllableCharacter` contract.
 *
 * The gate for this layer is equivalence: identical normalized intent must
 * produce a byte-identical trace no matter which source label it arrived
 * under. If that does not hold, "the AI plays the character a human tuned" is
 * a claim with nothing behind it — the AI would be playing a *second*
 * character that merely resembles the first.
 */
import { describe, expect, it } from 'vitest';
import type {
  CharacterSceneEntity,
  IntentTrackDefinition,
  ReplayDefinition,
  TransformDefinition,
} from '@atc/schema';
import { CURRENT_SCHEMA_VERSION, UNIT_SCALE, yawToQuaternion } from '@atc/schema';
import {
  AiInjectedCharacterIntentSource,
  ControllableCharacter,
  InjectedCharacterIntentSource,
  NeutralCharacterIntentSource,
  ReplayCharacterIntentSource,
  ScriptedTrackCharacterIntentSource,
  buildCharacterIntentSource,
  neutralIntent,
  seedOf,
  type CharacterIntent,
} from '@atc/character-control-runtime';
import { findTerrainPreset } from '@atc/terrain-runtime';
import { resolveCharacterAnimationBundle, materializeResolvedProject } from '@atc/animation-asset-runtime';
import { demoRegistry } from '../../fixtures/project.ts';
import { loadDemoProject } from '../../fixtures/project.ts';
import { acceptanceScene } from '../../fixtures/scene.ts';

const TICKS = 60;

function spawnTransform(): TransformDefinition {
  return { position: { x: 0, y: 2, z: 0 }, rotation: yawToQuaternion(0), scale: { ...UNIT_SCALE } };
}

function resolvedFor(characterId: string) {
  const project = loadDemoProject();
  const character = project.characters.find((entry) => entry.id === characterId)!;
  const { bundle } = resolveCharacterAnimationBundle({
    registry: demoRegistry(),
    project,
    characterId,
  });
  return materializeResolvedProject({ project, character, bundle });
}

function character(
  instanceId: string,
  source: ConstructorParameters<typeof ControllableCharacter>[0]['intentSource'],
  characterId = 'demo-humanoid',
): ControllableCharacter {
  return new ControllableCharacter({
    instanceId,
    resolvedProject: resolvedFor(characterId),
    initialTransform: spawnTransform(),
    terrain: findTerrainPreset(loadDemoProject().defaultTerrainPresetId),
    intentSource: source,
    seed: seedOf(instanceId),
  });
}

/**
 * The acceptance sequence: forward for 60 ticks, with a one-tick dodge edge at
 * tick 20. The edge is the interesting part — a source that got the *hold*
 * semantics right and the edge wrong would still match on position.
 */
function frameAt(tick: number): CharacterIntent {
  const intent = neutralIntent();
  intent.moveY = 1;
  if (tick === 20) intent.buttons.Dodge = true;
  return intent;
}

function runInjected(source: InjectedCharacterIntentSource): unknown[] {
  const subject = character('equivalence', source);
  const records: unknown[] = [];
  for (let tick = 0; tick < TICKS; tick += 1) {
    source.inject(frameAt(tick));
    records.push(subject.step(tick, { cameraYawRad: 0 }).record);
  }
  return records;
}

/** The same sequence, authored as a track with explicit press/release edges. */
function equivalentTrack(): IntentTrackDefinition {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    id: 'equivalence-track',
    displayName: 'Forward with one dodge',
    loop: false,
    durationTicks: TICKS,
    keyframes: [
      { tick: 0, move: { x: 0, y: 1 } },
      { tick: 20, move: { x: 0, y: 1 }, buttons: { Dodge: true } },
      { tick: 21, move: { x: 0, y: 1 }, buttons: { Dodge: false } },
    ],
  };
}

describe('human and script equivalence', () => {
  it('produces byte-identical tick records for identical normalized intent', () => {
    const human = runInjected(new InjectedCharacterIntentSource(0));

    const scripted = character('equivalence', new ScriptedTrackCharacterIntentSource(equivalentTrack()));
    const scriptedRecords: unknown[] = [];
    for (let tick = 0; tick < TICKS; tick += 1) {
      scriptedRecords.push(scripted.step(tick, { cameraYawRad: 0 }).record);
    }

    expect(JSON.stringify(scriptedRecords)).toBe(JSON.stringify(human));
  });
});

describe('human and AI equivalence', () => {
  const human = new InjectedCharacterIntentSource(0);
  const ai = new AiInjectedCharacterIntentSource('planner-a');

  it('produces identical behaviour through an AI channel', () => {
    expect(JSON.stringify(runInjected(ai))).toBe(JSON.stringify(runInjected(human)));
  });

  /*
   * Identical behaviour must not mean indistinguishable provenance. Once the
   * two paths are proven equivalent, the observation is the only thing left
   * that can answer "was that the AI?".
   */
  it('still reports the source kind and channel separately', () => {
    expect(new AiInjectedCharacterIntentSource('planner-a').kind).toBe('ai');
    expect(new InjectedCharacterIntentSource(0).kind).toBe('human');
    expect(new AiInjectedCharacterIntentSource('planner-a').channelId).toBe('planner-a');
  });
});

describe('instance isolation', () => {
  /*
   * Two characters may share one Character Definition and one immutable
   * animation bundle. They must share no mutable byte of what happens next —
   * the failure this guards is a single Simulation reached through two ids,
   * which looks correct until the second character starts mirroring the first.
   */
  it('gives two characters on one definition independent state', () => {
    const movingSource = new InjectedCharacterIntentSource(0);
    const moving = character('moving', movingSource);
    const still = character('still', new NeutralCharacterIntentSource());

    for (let tick = 0; tick < 30; tick += 1) {
      movingSource.inject(frameAt(tick));
      moving.step(tick, { cameraYawRad: 0 });
      still.step(tick, { cameraYawRad: 0 });
    }

    const movingObservation = moving.observe();
    const stillObservation = still.observe();
    expect(movingObservation.transform.position.z).not.toBeCloseTo(
      stillObservation.transform.position.z,
      6,
    );
    expect(movingObservation.intentCursor).not.toBe(stillObservation.intentCursor);
  });

  it('derives a different deterministic seed per entity id', () => {
    expect(seedOf('moving')).not.toBe(seedOf('still'));
    expect(seedOf('moving')).toBe(seedOf('moving'));
    expect(seedOf('moving')).toBeGreaterThan(0);
  });
});

describe('reset', () => {
  it('rebuilds at tick 0 from the authored spawn transform', () => {
    const source = new InjectedCharacterIntentSource(0);
    const subject = character('resettable', source);
    for (let tick = 0; tick < 30; tick += 1) {
      source.inject(frameAt(tick));
      subject.step(tick, { cameraYawRad: 0 });
    }
    expect(subject.observe().transform.position.z).not.toBeCloseTo(0, 3);

    const fresh = subject.reset();
    expect(fresh.tick).toBe(0);
    expect(fresh.observe().transform.position).toEqual(spawnTransform().position);
  });

  /*
   * A cursor that survived reset would make the second run of a replay sample
   * from where the first one stopped — a divergence that appears only on the
   * re-run, which is the least likely place anyone looks.
   */
  it('leaks no source cursor across the boundary', () => {
    const source = new InjectedCharacterIntentSource(0);
    const subject = character('resettable', source);
    for (let tick = 0; tick < 10; tick += 1) {
      source.inject(frameAt(tick));
      subject.step(tick, { cameraYawRad: 0 });
    }
    expect(source.cursor()).toBe(10);
    subject.reset();
    expect(source.cursor()).toBe(0);
  });
});

describe('spawn transform', () => {
  it('projects yaw out of the authored quaternion rather than discarding it', () => {
    const yawed = new ControllableCharacter({
      instanceId: 'yawed',
      resolvedProject: resolvedFor('demo-humanoid'),
      initialTransform: {
        position: { x: 0, y: 2, z: 0 },
        rotation: yawToQuaternion(Math.PI / 2),
        scale: { ...UNIT_SCALE },
      },
      terrain: findTerrainPreset(loadDemoProject().defaultTerrainPresetId),
      intentSource: new NeutralCharacterIntentSource(),
      seed: 1,
    });
    // Before any step the observation reports the authored rotation verbatim.
    expect(yawed.observe().transform.rotation).toEqual(yawToQuaternion(Math.PI / 2));
  });

  it('reports authored scale, which the yaw-only runtime does not consume', () => {
    const subject = character('scaled', new NeutralCharacterIntentSource());
    expect(subject.observe().transform.scale).toEqual(UNIT_SCALE);
  });
});

describe('observation', () => {
  it('omits events before the first step rather than reporting an empty list', () => {
    const subject = character('unstepped', new NeutralCharacterIntentSource());
    expect(subject.observe().events).toBeUndefined();
  });

  it('reports events once the character has ticked', () => {
    const subject = character('stepped', new NeutralCharacterIntentSource());
    subject.step(0, { cameraYawRad: 0 });
    expect(Array.isArray(subject.observe().events)).toBe(true);
  });
});

describe('binding construction', () => {
  const tracks = new Map<string, IntentTrackDefinition>([['equivalence-track', equivalentTrack()]]);
  const replays = new Map<string, ReplayDefinition>();

  it.each([
    [{ kind: 'human', playerIndex: 1 } as const, InjectedCharacterIntentSource, 'human'],
    [{ kind: 'ai', channelId: 'planner-a' } as const, AiInjectedCharacterIntentSource, 'ai'],
    [{ kind: 'script', trackId: 'equivalence-track' } as const, ScriptedTrackCharacterIntentSource, 'script'],
    [{ kind: 'none' } as const, NeutralCharacterIntentSource, 'none'],
  ])('builds %o as the matching source', (binding, expected, kind) => {
    const source = buildCharacterIntentSource(binding, tracks, replays);
    expect(source).toBeInstanceOf(expected);
    expect(source.kind).toBe(kind);
  });

  /*
   * A broken reference must leave the scene openable. Throwing here would hand
   * a human a stack trace where a validation issue next to the field belongs.
   */
  it('falls back to neutral for an unknown track without throwing', () => {
    const source = buildCharacterIntentSource({ kind: 'script', trackId: 'nope' }, tracks, replays);
    expect(source).toBeInstanceOf(NeutralCharacterIntentSource);
  });

  it('falls back to neutral for an unknown replay without throwing', () => {
    const source = buildCharacterIntentSource({ kind: 'replay', replayId: 'nope' }, tracks, replays);
    expect(source).toBeInstanceOf(NeutralCharacterIntentSource);
  });
});

describe('scripted track sampling', () => {
  const track = equivalentTrack();

  it('holds the last keyframe value rather than interpolating', () => {
    const source = new ScriptedTrackCharacterIntentSource(track);
    expect(source.sample(10).moveY).toBe(1);
    expect(source.sample(19).buttons.Dodge).toBe(false);
    expect(source.sample(20).buttons.Dodge).toBe(true);
    expect(source.sample(21).buttons.Dodge).toBe(false);
  });

  it('clamps past the end for a non-looping track', () => {
    const source = new ScriptedTrackCharacterIntentSource(track);
    expect(source.localTick(TICKS + 100)).toBe(TICKS - 1);
  });

  it('wraps for a looping track', () => {
    const source = new ScriptedTrackCharacterIntentSource({ ...track, loop: true });
    expect(source.localTick(TICKS + 5)).toBe(5);
  });
});

describe('scene bindings', () => {
  it('the migrated acceptance scene binds a human and a script controller', () => {
    const kinds = acceptanceScene()
      .entities.filter((entity): entity is CharacterSceneEntity => entity.kind === 'character')
      .map((entity) => entity.controller.kind);
    expect(kinds).toEqual(['human', 'script']);
  });
});

describe('replay source', () => {
  it('is neutral before its start tick', () => {
    const replay: ReplayDefinition = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      id: 'r',
      displayName: 'r',
      fixedTimestepVersion: 1,
      terrainPresetId: 'flat-ground',
      frames: [{ tick: 0, sample: neutralIntent() }],
    } as unknown as ReplayDefinition;
    const source = new ReplayCharacterIntentSource(replay, 10);
    expect(source.sample(5)).toEqual(neutralIntent());
  });
});
