/**
 * The replay lifecycle: reset, re-record, and the round trip between them.
 *
 * Two defects motivate this file, and both are the kind that only surface on the
 * *second* use of a recording:
 *
 *   - `reset()` rebuilds a runtime from its constructor options. A control
 *     source attached after construction was therefore dropped, so resetting a
 *     replay silently flattened its camera track to zero — while the first
 *     playback, the one everybody checks, was correct.
 *   - the recorder read camera yaw from the runtime *before* stepping. For a
 *     host-driven run that is the value the tick uses; for a control-source-
 *     driven run the source is sampled inside the step, so the recorder stored
 *     the previous tick's yaw and every re-record shifted the track one tick.
 *
 * Neither is visible in a single record-then-replay pass, which is exactly why
 * the round trip is the test.
 */
import { describe, expect, it } from 'vitest';
import {
  RecordedControlSource,
  WorldReplayRecorder,
  WorldRuntime,
  createReplayRuntime,
  hashWorldTrace,
  neutralIntent,
  observeWorld,
  recordWorldTrace,
  type WorldControlSource,
  type WorldReplay,
} from '@atc/world-runtime';
import { demoRegistry, loadDemoProject } from '../../fixtures/project.ts';
import { CONTROLLED, SCRIPTED, loadWorldFixture } from '../../fixtures/world.ts';

const TICKS = 120;

/** The camera schedule every lifecycle test records against. */
function yawAt(tick: number): number {
  if (tick < 30) return 0;
  if (tick < 60) return Math.PI / 4;
  if (tick < 90) return Math.PI / 2;
  return -Math.PI / 3;
}

function context() {
  return { registry: demoRegistry(), project: loadDemoProject(), world: loadWorldFixture() };
}

/** A host-driven recording: the caller sets yaw and injects input each tick. */
function recordLive(ticks = TICKS): WorldReplay {
  const { registry, project, world } = context();
  const live = new WorldRuntime({ registry, project, world });
  const recorder = new WorldReplayRecorder(live);
  for (let tick = 0; tick < ticks; tick += 1) {
    live.setCameraYaw(yawAt(tick));
    live.injectLocalIntent(0, { ...neutralIntent(), moveY: 1 });
    recorder.step();
  }
  return recorder.finish();
}

describe('replay reset', () => {
  it('resetting a replay runtime preserves its recorded camera control source', () => {
    const replay = recordLive();
    const { registry, project, world } = context();

    const fresh = createReplayRuntime({ registry, project, world, replay });
    const freshTrace = recordWorldTrace(fresh, TICKS);
    const freshObservation = observeWorld(fresh);

    // A reset runtime must be the same replay, not the same world with the
    // camera nailed to zero.
    const reset = createReplayRuntime({ registry, project, world, replay }).reset();
    const resetTrace = recordWorldTrace(reset, TICKS);
    const resetObservation = observeWorld(reset);

    expect(hashWorldTrace(resetTrace)).toBe(hashWorldTrace(freshTrace));
    expect(resetTrace.instanceOrder).toEqual(freshTrace.instanceOrder);
    for (const instanceId of [CONTROLLED, SCRIPTED]) {
      expect(JSON.stringify(resetTrace.instances[instanceId]!.ticks)).toBe(
        JSON.stringify(freshTrace.instances[instanceId]!.ticks),
      );
    }
    expect(JSON.stringify(resetObservation)).toBe(JSON.stringify(freshObservation));

    // And the camera really did move: a reset that dropped its control source
    // would still match a fresh run that had also dropped it, so the schedule
    // has to be visible in the record itself.
    const boundaries = [0, 29, 30, 59, 60, 89, 90, TICKS - 1];
    const yawAtBoundary = boundaries.map((tick) => {
      const runtime = createReplayRuntime({ registry, project, world, replay }).reset();
      let controls = { cameraYawRad: Number.NaN };
      for (let i = 0; i <= tick; i += 1) controls = runtime.step().controls;
      return controls.cameraYawRad;
    });
    expect(yawAtBoundary).toEqual(boundaries.map(yawAt));
  });

  it('resetting after partial playback restarts the same replay from tick zero', () => {
    const replay = recordLive();
    const { registry, project, world } = context();

    const partial = createReplayRuntime({ registry, project, world, replay });
    partial.run(47);
    expect(partial.tick).toBe(47);

    const reset = partial.reset();
    expect(reset.tick).toBe(0);
    expect(reset.instance(CONTROLLED)!.lastRecord).toBeNull();
    // Tick-zero control restored, not held over from tick 47.
    expect(reset.cameraYawRad).toBe(0);

    const resetTrace = recordWorldTrace(reset, TICKS);
    const freshTrace = recordWorldTrace(
      createReplayRuntime({ registry, project, world, replay }),
      TICKS,
    );
    expect(hashWorldTrace(resetTrace)).toBe(hashWorldTrace(freshTrace));
    for (const instanceId of [CONTROLLED, SCRIPTED]) {
      expect(JSON.stringify(resetTrace.instances[instanceId]!.ticks)).toBe(
        JSON.stringify(freshTrace.instances[instanceId]!.ticks),
      );
    }
  });

  it('shares one stateless control source between a runtime and its reset', () => {
    // The source is reused rather than rebuilt, so it must carry no cursor: two
    // runtimes sampling it must not drag each other's position along.
    const source = new RecordedControlSource([
      { tick: 0, cameraYawRad: 0 },
      { tick: 30, cameraYawRad: Math.PI / 2 },
    ]);
    const { registry, project, world } = context();
    const a = new WorldRuntime({ registry, project, world, controlSource: source });
    const b = a.reset();

    a.run(45);
    expect(a.cameraYawRad).toBe(Math.PI / 2);
    // `b` has not ticked, so it must still be at the tick-zero value.
    expect(b.tick).toBe(0);
    b.run(10);
    expect(b.cameraYawRad).toBe(0);
  });
});

describe('replay re-recording', () => {
  it('recording a control-source-driven runtime captures the yaw consumed by the same tick', () => {
    const source: WorldControlSource = new RecordedControlSource([
      { tick: 0, cameraYawRad: 0 },
      { tick: 30, cameraYawRad: Math.PI / 2 },
    ]);
    const { registry, project, world } = context();
    const runtime = new WorldRuntime({ registry, project, world, controlSource: source });
    const recorder = new WorldReplayRecorder(runtime);
    for (let tick = 0; tick < 60; tick += 1) {
      runtime.injectLocalIntent(0, { ...neutralIntent(), moveY: 1 });
      recorder.step();
    }
    const recorded = recorder.finish();

    // Exactly the source's own keyframes — not [0, 31], which is what reading
    // the runtime before the step produced.
    expect(recorded.controls.cameraYaw).toEqual([
      { tick: 0, cameraYawRad: 0 },
      { tick: 30, cameraYawRad: Math.PI / 2 },
    ]);
  });

  it('record replay record preserves camera control keyframes exactly', () => {
    const a = recordLive();
    const { registry, project, world } = context();

    const playback = createReplayRuntime({ registry, project, world, replay: a });
    const rerecorder = new WorldReplayRecorder(playback);
    rerecorder.run(TICKS);
    const b = rerecorder.finish();

    expect(b.worldReplayVersion).toBe(a.worldReplayVersion);
    expect(b.fixedTimestepVersion).toBe(a.fixedTimestepVersion);
    expect(b.worldId).toBe(a.worldId);
    expect(b.tickCount).toBe(a.tickCount);
    expect(b.instanceOrder).toEqual(a.instanceOrder);
    expect(b.controls.cameraYaw).toEqual(a.controls.cameraYaw);
  });

  it('record replay record preserves every per-instance replay frame', () => {
    const a = recordLive();
    const { registry, project, world } = context();

    const playback = createReplayRuntime({ registry, project, world, replay: a });
    const rerecorder = new WorldReplayRecorder(playback);
    rerecorder.run(TICKS);
    const b = rerecorder.finish();

    for (const instanceId of [CONTROLLED, SCRIPTED]) {
      // Every frame, not just the last position: a one-tick shift in the middle
      // of a run can end in the same place.
      expect(JSON.stringify(b.instances[instanceId]!.frames)).toBe(
        JSON.stringify(a.instances[instanceId]!.frames),
      );
      expect(b.instances[instanceId]!.tickCount).toBe(a.instances[instanceId]!.tickCount);
    }
  });

  it('produces the same trace when played back from either recording', () => {
    const a = recordLive();
    const { registry, project, world } = context();

    const rerecorder = new WorldReplayRecorder(
      createReplayRuntime({ registry, project, world, replay: a }),
    );
    rerecorder.run(TICKS);
    const b = rerecorder.finish();

    const fromA = createReplayRuntime({ registry, project, world, replay: a });
    const fromB = createReplayRuntime({ registry, project, world, replay: b });
    const traceA = recordWorldTrace(fromA, TICKS);
    const traceB = recordWorldTrace(fromB, TICKS);

    expect(hashWorldTrace(traceB)).toBe(hashWorldTrace(traceA));
    for (const instanceId of [CONTROLLED, SCRIPTED]) {
      expect(JSON.stringify(traceB.instances[instanceId]!.ticks)).toBe(
        JSON.stringify(traceA.instances[instanceId]!.ticks),
      );
    }
    expect(JSON.stringify(observeWorld(fromB))).toBe(JSON.stringify(observeWorld(fromA)));
  });

  it('keeps host-driven recording correct', () => {
    // The path the browser uses: set yaw, inject intent, step. It must still
    // record the schedule it was given.
    const replay = recordLive(90);
    expect(replay.controls.cameraYaw).toEqual([
      { tick: 0, cameraYawRad: 0 },
      { tick: 30, cameraYawRad: Math.PI / 4 },
      { tick: 60, cameraYawRad: Math.PI / 2 },
    ]);
  });
});

describe('invalid control atomicity', () => {
  it('does not partially advance a tick when the control source returns NaN', () => {
    const { registry, project, world } = context();
    const broken: WorldControlSource = {
      sample: (tick) => ({ cameraYawRad: tick < 10 ? 0 : Number.NaN }),
    };
    const runtime = new WorldRuntime({ registry, project, world, controlSource: broken });
    runtime.run(10);

    const before = {
      tick: runtime.tick,
      records: Object.fromEntries(
        runtime.instanceIds.map((id) => [id, JSON.stringify(runtime.instance(id)!.lastRecord)]),
      ),
    };

    expect(() => runtime.step()).toThrow(/must be finite/);

    // Nothing moved: not the world clock, not one instance, not the first one
    // in declaration order.
    expect(runtime.tick).toBe(before.tick);
    for (const id of runtime.instanceIds) {
      expect(JSON.stringify(runtime.instance(id)!.lastRecord)).toBe(before.records[id]);
    }
  });
});
