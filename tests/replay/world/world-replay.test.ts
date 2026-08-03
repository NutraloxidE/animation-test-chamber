/**
 * Replay and trace compatibility.
 *
 * The claim these tests exist to make checkable is the one that would otherwise
 * be taken on trust: a one-instance world is the *same simulation* the focused
 * chamber has always run, not merely a similar one. The projection assertion
 * below compares tick records byte for byte against `runReplay`, which is the
 * legacy path, on the legacy fixtures.
 */
import { describe, expect, it } from 'vitest';
import type { ReplayDefinition, WorldDefinition } from '@atc/schema';
import { CURRENT_SCHEMA_VERSION } from '@atc/schema';
import { REPLAY_FIXTURES, compareTraces, findReplayFixture, runReplay } from '@atc/replay-runtime';
import { findTerrainPreset } from '@atc/terrain-runtime';
import {
  RecordedControlSource,
  WorldReplayRecorder,
  WorldRuntime,
  createReplayRuntime,
  hashWorldTrace,
  neutralIntent,
  projectInstanceTrace,
  recordWorldTrace,
} from '@atc/world-runtime';
import { demoRegistry, loadDemoProject, loadResolvedDemoProject } from '../../fixtures/project.ts';
import { CONTROLLED, SCRIPTED, loadWorldFixture } from '../../fixtures/world.ts';

/**
 * A one-instance world that reproduces a legacy replay's starting conditions
 * exactly: the recorded seed, transform and camera yaw, with the recording
 * itself bound as the instance's intent source.
 */
function worldForReplay(replay: ReplayDefinition): WorldDefinition {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    id: 'legacy-projection-world',
    displayName: 'Legacy projection',
    instances: [
      {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        id: 'legacy-instance',
        displayName: 'Legacy instance',
        source: { kind: 'character', characterId: loadDemoProject().activeCharacterId },
        transform: {
          position: { ...replay.initialPosition },
          yawRad: replay.initialYawRad,
        },
        intentSource: { kind: 'replay', replayId: replay.id },
        enabled: true,
        overrides: { seed: replay.seed },
      },
    ],
    intentTracks: [],
    focusedInstanceId: 'legacy-instance',
    cameraTargetInstanceId: 'legacy-instance',
  };
}

describe('legacy replay compatibility', () => {
  it.each(REPLAY_FIXTURES.map((replay) => replay.id))(
    'a one-instance world reproduces the legacy trace exactly: %s',
    (id) => {
      const replay = findReplayFixture(id);
      const legacy = runReplay(loadResolvedDemoProject(), replay);

      const runtime = new WorldRuntime({
        registry: demoRegistry(),
        project: loadDemoProject(),
        world: worldForReplay(replay),
        replays: [replay],
        cameraYawRad: replay.cameraYawRad,
        // Terrain is a world-level input, and each legacy fixture recorded its
        // own. Running them all on the project default would compare two
        // different scenes and call the difference a regression.
        terrain: findTerrainPreset(replay.terrainPresetId),
      });
      const worldTrace = recordWorldTrace(runtime, replay.tickCount);
      const projected = projectInstanceTrace(
        runtime,
        worldTrace,
        'legacy-instance',
        replay.id,
        legacy.revisionId,
      )!;

      // Byte-identical, not merely tolerant: a projection that only matched
      // within tolerance would hide exactly the drift it is here to rule out.
      expect(JSON.stringify(projected.ticks)).toBe(JSON.stringify(legacy.ticks));
      expect(projected.metrics).toEqual(legacy.metrics);
      expect(compareTraces(legacy, projected).identical).toBe(true);
    },
  );

  it('keeps the legacy trace shape unversioned and adds a versioned world trace', () => {
    const replay = findReplayFixture(REPLAY_FIXTURES[0]!.id);
    const trace = recordWorldTrace(
      new WorldRuntime({
        registry: demoRegistry(),
        project: loadDemoProject(),
        world: worldForReplay(replay),
        replays: [replay],
        terrain: findTerrainPreset(replay.terrainPresetId),
      }),
      10,
    );
    expect(trace.worldTraceVersion).toBe(1);
    expect(Object.keys(trace.instances)).toEqual(['legacy-instance']);
  });
});

describe('world replay', () => {
  it('reproduces both instances from a recorded world run', () => {
    const project = loadDemoProject();
    const world = loadWorldFixture();
    const registry = demoRegistry();

    // Drive the controlled instance from outside while the scripted one runs
    // its track, so the recording has to keep two different sources apart.
    const drive = (tick: number) =>
      tick > 40 ? { ...neutralIntent(), moveY: 1 } : neutralIntent();

    const live = new WorldRuntime({ registry, project, world });
    const recorder = new WorldReplayRecorder(live);
    for (let tick = 0; tick < 180; tick += 1) {
      live.injectLocalIntent(0, drive(tick));
      recorder.step();
    }
    const recorded = recorder.finish();

    expect(Object.keys(recorded.instances).sort()).toEqual([CONTROLLED, SCRIPTED]);
    expect(recorded.instanceOrder).toEqual([CONTROLLED, SCRIPTED]);

    // The same live inputs again, this time traced, so the playback has a run
    // to be identical *to* rather than merely a shape to match.
    const referenceRuntime = new WorldRuntime({ registry, project, world });
    const referenceTicks = [];
    for (let tick = 0; tick < 180; tick += 1) {
      referenceRuntime.injectLocalIntent(0, drive(tick));
      referenceTicks.push(referenceRuntime.step());
    }

    const playback = createReplayRuntime({ registry, project, world, replay: recorded });
    const playbackTrace = recordWorldTrace(playback, 180);

    for (const instanceId of [CONTROLLED, SCRIPTED]) {
      const replayed = playbackTrace.instances[instanceId]!.ticks;
      expect(replayed).toHaveLength(180);
      const expected = referenceTicks.map((record) => record.instances[instanceId]!);
      expect(JSON.stringify(replayed)).toBe(JSON.stringify(expected));
    }
    // Two different intent streams survived the round trip, rather than one
    // stream reaching both instances.
    expect(playbackTrace.instances[CONTROLLED]!.ticks.at(-1)!.position).not.toEqual(
      playbackTrace.instances[SCRIPTED]!.ticks.at(-1)!.position,
    );
  });

  it('replays a recorded run to the same world hash', () => {
    const project = loadDemoProject();
    const world = loadWorldFixture();
    const registry = demoRegistry();

    const live = new WorldRuntime({ registry, project, world });
    const recorder = new WorldReplayRecorder(live);
    for (let tick = 0; tick < 120; tick += 1) {
      live.injectLocalIntent(0, tick > 30 ? { ...neutralIntent(), moveY: 1 } : neutralIntent());
      recorder.step();
    }
    const recorded = recorder.finish();

    const first = hashWorldTrace(
      recordWorldTrace(
        createReplayRuntime({ registry, project, world, replay: recorded }),
        120,
      ),
    );
    const second = hashWorldTrace(
      recordWorldTrace(
        createReplayRuntime({ registry, project, world, replay: recorded }),
        120,
      ),
    );
    expect(second).toBe(first);
  });
});

describe('camera-faithful world replay', () => {
  const registry = demoRegistry();

  /**
   * Records a run with a deterministic camera-yaw schedule, then replays it
   * with no external camera updates at all. The replay must reproduce the run
   * from the recording alone — that is the whole claim.
   */
  function recordAndReplay(yawAt: (tick: number) => number, ticks: number) {
    const project = loadDemoProject();
    const world = loadWorldFixture();

    const live = new WorldRuntime({ registry, project, world });
    const recorder = new WorldReplayRecorder(live);
    const recorded: Record<string, unknown>[] = [];
    for (let tick = 0; tick < ticks; tick += 1) {
      live.setCameraYaw(yawAt(tick));
      live.injectLocalIntent(0, { ...neutralIntent(), moveY: 1 });
      recorder.step();
      recorded.push(
        Object.fromEntries(
          live.instanceIds.map((id) => [id, live.instance(id)!.lastRecord]),
        ) as Record<string, unknown>,
      );
    }
    const replay = recorder.finish();

    const playback = createReplayRuntime({ registry, project, world, replay });
    const playbackTrace = recordWorldTrace(playback, ticks);

    return { replay, recorded, playbackTrace, world, project };
  }

  it('replays a constant non-zero camera yaw exactly', () => {
    const { recorded, playbackTrace } = recordAndReplay(() => Math.PI / 2, 120);

    for (const instanceId of [CONTROLLED, SCRIPTED]) {
      const replayed = playbackTrace.instances[instanceId]!.ticks;
      const expected = recorded.map((entry) => entry[instanceId]);
      expect(JSON.stringify(replayed)).toBe(JSON.stringify(expected));
    }
    // A yaw of pi/2 turns "forward" into +x. If playback had used the old
    // hardcoded zero, the controlled instance would have moved along z instead.
    const last = playbackTrace.instances[CONTROLLED]!.ticks.at(-1)!;
    expect(Math.abs(last.position.x)).toBeGreaterThan(Math.abs(last.position.z));
  });

  it('replays changing camera yaw on the exact recorded tick', () => {
    const schedule = (tick: number): number => {
      if (tick < 30) return 0;
      if (tick < 60) return Math.PI / 4;
      if (tick < 90) return Math.PI / 2;
      return -Math.PI / 3;
    };
    const { recorded, playbackTrace, replay } = recordAndReplay(schedule, 120);

    for (const instanceId of [CONTROLLED, SCRIPTED]) {
      const replayed = playbackTrace.instances[instanceId]!.ticks;
      const expected = recorded.map((entry) => entry[instanceId]);
      expect(JSON.stringify(replayed)).toBe(JSON.stringify(expected));
    }

    // Change-only keyframes, one per distinct value in the schedule.
    expect(replay.controls.cameraYaw.map((frame) => frame.tick)).toEqual([0, 30, 60, 90]);
    expect(replay.controls.cameraYaw.map((frame) => frame.cameraYawRad)).toEqual([
      0,
      Math.PI / 4,
      Math.PI / 2,
      -Math.PI / 3,
    ]);
  });

  it('applies a yaw change on its own tick and not the one before', () => {
    const source = new RecordedControlSource([
      { tick: 0, cameraYawRad: 0 },
      { tick: 30, cameraYawRad: Math.PI / 2 },
    ]);
    expect(source.sample(29).cameraYawRad).toBe(0);
    expect(source.sample(30).cameraYawRad).toBe(Math.PI / 2);
    expect(source.sample(31).cameraYawRad).toBe(Math.PI / 2);

    // And end to end: the runtime must have the new yaw while ticking 30, not
    // after it. An off-by-one here is invisible in a constant-yaw recording.
    const project = loadDemoProject();
    const world = loadWorldFixture();
    const runtime = new WorldRuntime({ registry, project, world });
    runtime.setControlSource(source);
    // Ticks 0..29 each run with the old yaw; the value is sampled at the start
    // of a step, so after step N the runtime holds the yaw step N used.
    for (let tick = 0; tick < 30; tick += 1) {
      runtime.step();
      expect(runtime.cameraYawRad).toBe(0);
    }
    runtime.step();
    expect(runtime.cameraYawRad).toBe(Math.PI / 2);
  });

  it('replays two instances on different intent sources under one global camera', () => {
    const { playbackTrace } = recordAndReplay((tick) => (tick < 60 ? 0 : Math.PI / 2), 120);
    // Both instances were driven by the same world-global yaw, but by different
    // intent sources: the traces must differ from each other and each must be
    // reproducible.
    expect(playbackTrace.instances[CONTROLLED]!.ticks.at(-1)!.position).not.toEqual(
      playbackTrace.instances[SCRIPTED]!.ticks.at(-1)!.position,
    );
    expect(playbackTrace.instances[CONTROLLED]!.ticks).toHaveLength(120);
    expect(playbackTrace.instances[SCRIPTED]!.ticks).toHaveLength(120);
  });

  it('produces the same result from two fresh replay runtimes', () => {
    const { replay, world, project } = recordAndReplay((tick) => (tick < 40 ? 0 : 1.1), 90);
    const first = createReplayRuntime({ registry, project, world, replay });
    const second = createReplayRuntime({ registry, project, world, replay });
    const a = recordWorldTrace(first, 90);
    const b = recordWorldTrace(second, 90);
    expect(hashWorldTrace(b)).toBe(hashWorldTrace(a));
    expect(JSON.stringify(b.instances)).toBe(JSON.stringify(a.instances));
  });

  it('reads a v1 recording as constant zero yaw rather than guessing', () => {
    const { replay, world, project } = recordAndReplay(() => 0, 30);
    const legacy = { ...replay, worldReplayVersion: 1 };
    const runtime = createReplayRuntime({ registry, project, world, replay: legacy });
    expect(runtime.cameraYawRad).toBe(0);
  });

  it('refuses an unsupported world replay version', () => {
    const { replay, world, project } = recordAndReplay(() => 0, 30);
    expect(() =>
      createReplayRuntime({
        registry,
        project,
        world,
        replay: { ...replay, worldReplayVersion: 99 },
      }),
    ).toThrow(/unsupported worldReplayVersion 99/);
  });

  it('refuses malformed replay control data', () => {
    const { replay, world, project } = recordAndReplay(() => 0, 30);
    const broken: { cameraYaw: { tick: number; cameraYawRad: number }[] }[] = [
      { cameraYaw: [{ tick: 0, cameraYawRad: Number.NaN }] },
      { cameraYaw: [{ tick: -1, cameraYawRad: 0 }] },
      { cameraYaw: [{ tick: 5, cameraYawRad: 0 }, { tick: 2, cameraYawRad: 1 }] },
      { cameraYaw: [{ tick: 999, cameraYawRad: 0 }] },
    ];
    for (const controls of broken) {
      expect(() =>
        createReplayRuntime({ registry, project, world, replay: { ...replay, controls } }),
      ).toThrow(/invalid world replay controls/);
    }
  });

  it('refuses a non-finite camera yaw at the runtime boundary', () => {
    const runtime = new WorldRuntime({
      registry,
      project: loadDemoProject(),
      world: loadWorldFixture(),
    });
    expect(() => runtime.setCameraYaw(Number.NaN)).toThrow(/must be finite/);
    expect(() => runtime.setCameraYaw(Number.POSITIVE_INFINITY)).toThrow(/must be finite/);
    expect(runtime.cameraYawRad).toBe(0);
  });
});
