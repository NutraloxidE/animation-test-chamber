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
