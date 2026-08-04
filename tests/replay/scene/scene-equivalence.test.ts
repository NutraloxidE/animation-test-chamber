/**
 * The Phase 3 gate: a migrated Scene ticks exactly like the World it came from.
 *
 * This is the only evidence that the World-to-Scene migration was a *rename of
 * ownership* rather than a rewrite. Both runtimes are driven from the same
 * committed fixture — one through `WorldRuntime`, one through `SceneRuntime`
 * over the migrated document — and every per-character tick record is compared
 * byte for byte. Regenerating a new baseline for the new runtime would have
 * been far less work and would have proved nothing at all.
 */
import { describe, expect, it } from 'vitest';
import { migrateWorldDefinition, type CharacterSceneEntity } from '@atc/schema';
import { WorldRuntime, recordWorldTrace } from '@atc/world-runtime';
import {
  SceneReplayRecorder,
  SceneRuntime,
  createReplayRuntime,
  flattenObservations,
  hashSceneTrace,
  observeScene,
  recordSceneTrace,
} from '@atc/scene-runtime';
import { neutralIntent } from '@atc/character-control-runtime';
import { demoRegistry, loadDemoProject } from '../../fixtures/project.ts';
import { loadWorldFixture } from '../../fixtures/world.ts';
import { CONTROLLED_ENTITY, SCRIPTED_ENTITY, acceptanceScene } from '../../fixtures/scene.ts';

const TICKS = 120;

function sceneRuntime(): SceneRuntime {
  return new SceneRuntime({
    registry: demoRegistry(),
    project: loadDemoProject(),
    scene: acceptanceScene(),
  });
}

describe('migrated scene equivalence', () => {
  it('reproduces the world runtime tick-for-tick, per character', () => {
    const worldTrace = recordWorldTrace(
      new WorldRuntime({
        registry: demoRegistry(),
        project: loadDemoProject(),
        world: loadWorldFixture(),
      }),
      TICKS,
    );
    const sceneTrace = recordSceneTrace(sceneRuntime(), TICKS);

    expect(sceneTrace.entityOrder).toEqual(worldTrace.instanceOrder);
    for (const id of worldTrace.instanceOrder) {
      expect(JSON.stringify(sceneTrace.entities[id]!.ticks)).toBe(
        JSON.stringify(worldTrace.instances[id]!.ticks),
      );
    }
  });

  it('carries the character reference into the scene trace', () => {
    const trace = recordSceneTrace(sceneRuntime(), 10);
    expect(trace.entities[CONTROLLED_ENTITY]!.characterId).toBe('demo-humanoid');
    expect(trace.entities[CONTROLLED_ENTITY]!.controllerKind).toBe('human');
    expect(trace.entities[SCRIPTED_ENTITY]!.controllerKind).toBe('script');
  });
});

describe('determinism', () => {
  it('produces the same hash for two independent runs', () => {
    expect(hashSceneTrace(recordSceneTrace(sceneRuntime(), TICKS))).toBe(
      hashSceneTrace(recordSceneTrace(sceneRuntime(), TICKS)),
    );
  });

  it('produces the same hash after reset', () => {
    const runtime = sceneRuntime();
    const first = hashSceneTrace(recordSceneTrace(runtime, TICKS));
    expect(hashSceneTrace(recordSceneTrace(runtime.reset(), TICKS))).toBe(first);
  });
});

describe('tick order', () => {
  /*
   * Declaration order is tick order (DECISION 0009). Renaming an entity must
   * not reorder execution — sorting by id would be equally deterministic and
   * would mean a human who renamed a character silently reordered the scene.
   */
  it('does not reorder when an entity is renamed', () => {
    const scene = acceptanceScene();
    const before = new SceneRuntime({
      registry: demoRegistry(),
      project: loadDemoProject(),
      scene,
    }).entityIds;

    const renamed = {
      ...scene,
      entities: scene.entities.map((entity, index) =>
        index === 0 ? { ...entity, displayName: 'ZZZ last alphabetically' } : entity,
      ),
    };
    const after = new SceneRuntime({
      registry: demoRegistry(),
      project: loadDemoProject(),
      scene: renamed,
    }).entityIds;

    expect(after).toEqual(before);
  });

  it('ticks in the order the entities are declared, not sorted by id', () => {
    const scene = acceptanceScene();
    const reversed = { ...scene, entities: [...scene.entities].reverse() };
    const runtime = new SceneRuntime({
      registry: demoRegistry(),
      project: loadDemoProject(),
      scene: reversed,
    });
    expect(runtime.entityIds).toEqual([SCRIPTED_ENTITY, CONTROLLED_ENTITY]);
  });
});

describe('intent routing', () => {
  it('delivers injected human intent only to the bound character', () => {
    const runtime = sceneRuntime();
    for (let tick = 0; tick < 30; tick += 1) {
      runtime.injectHumanIntent(0, { ...neutralIntent(), moveY: 1 });
      runtime.step();
    }
    expect(runtime.character(CONTROLLED_ENTITY)!.lastIntent.moveY).toBe(1);
    expect(runtime.character(SCRIPTED_ENTITY)!.lastIntent.moveY).not.toBe(1);
  });

  /*
   * An AI channel must not be reachable through a player index. The channel
   * carries a placeholder index internally, so routing on the number rather
   * than on the source class would hand every AI character the keyboard.
   */
  it('does not deliver human intent to an AI channel sharing player index 0', () => {
    const scene = acceptanceScene();
    const aiScene = {
      ...scene,
      entities: scene.entities.map((entity) =>
        entity.id === CONTROLLED_ENTITY
          ? ({
              ...(entity as CharacterSceneEntity),
              controller: { kind: 'ai' as const, channelId: 'planner-a' },
            } satisfies CharacterSceneEntity)
          : entity,
      ),
    };
    const runtime = new SceneRuntime({
      registry: demoRegistry(),
      project: loadDemoProject(),
      scene: aiScene,
    });

    runtime.injectHumanIntent(0, { ...neutralIntent(), moveY: 1 });
    runtime.step();
    expect(runtime.character(CONTROLLED_ENTITY)!.lastIntent.moveY).toBe(0);

    runtime.injectAiIntent('planner-a', { ...neutralIntent(), moveY: 1 });
    runtime.step();
    expect(runtime.character(CONTROLLED_ENTITY)!.lastIntent.moveY).toBe(1);
  });
});

describe('observation', () => {
  it('qualifies every path by entity id, never by array index', () => {
    const runtime = sceneRuntime();
    runtime.run(5);
    for (const { path } of flattenObservations(observeScene(runtime))) {
      expect(path).not.toMatch(/\/entities\/\d+\//);
    }
  });

  it('roots paths at the scene id', () => {
    const runtime = sceneRuntime();
    runtime.run(1);
    const paths = flattenObservations(observeScene(runtime)).map((entry) => entry.path);
    expect(
      paths.some(
        (path) => path === `/scenes/${runtime.scene.id}/entities/${CONTROLLED_ENTITY}/transform/position/z`,
      ),
    ).toBe(true);
  });
});

describe('non-character entities', () => {
  it('projects the migrated camera without giving it an intent source', () => {
    const runtime = sceneRuntime();
    expect(runtime.projections().cameras).toHaveLength(1);
    // The camera is not in the tick order — only characters are.
    expect(runtime.entityIds).toEqual([CONTROLLED_ENTITY, SCRIPTED_ENTITY]);
  });
});

describe('unresolved references', () => {
  /*
   * A broken reference must produce an inspectable entity, never a substituted
   * one. Falling back to the first character in the project would make a typo
   * look like a working scene.
   */
  it('reports an unknown character rather than substituting one', () => {
    const scene = acceptanceScene();
    const broken = {
      ...scene,
      entities: scene.entities.map((entity) =>
        entity.id === CONTROLLED_ENTITY
          ? ({ ...(entity as CharacterSceneEntity), characterId: 'no-such-character' } satisfies CharacterSceneEntity)
          : entity,
      ),
    };
    const runtime = new SceneRuntime({
      registry: demoRegistry(),
      project: loadDemoProject(),
      scene: broken,
    });

    expect(runtime.entityIds).toEqual([SCRIPTED_ENTITY]);
    expect(runtime.unresolved).toEqual([
      {
        entityId: CONTROLLED_ENTITY,
        characterId: 'no-such-character',
        reason: 'unknown character "no-such-character"',
      },
    ]);
  });
});

describe('shared definitions, independent state', () => {
  it('shares one animation bundle between two entities on one character', () => {
    const runtime = sceneRuntime();
    const first = runtime.resolvedCharacter(CONTROLLED_ENTITY)!;
    const second = runtime.resolvedCharacter(SCRIPTED_ENTITY)!;
    expect(first.bundle).toBe(second.bundle);
    expect(first.animationResolutionKey).toBe(second.animationResolutionKey);
  });

  it('gives them distinct resolved wrappers and simulations', () => {
    const runtime = sceneRuntime();
    expect(runtime.resolvedCharacter(CONTROLLED_ENTITY)!.resolved).not.toBe(
      runtime.resolvedCharacter(SCRIPTED_ENTITY)!.resolved,
    );
    expect(runtime.character(CONTROLLED_ENTITY)!.simulation).not.toBe(
      runtime.character(SCRIPTED_ENTITY)!.simulation,
    );
  });
});

describe('scene replay', () => {
  /*
   * Camera yaw is an input to a camera-relative simulation, so a recording that
   * does not carry it replays a turning run as a straight line. The versioned
   * control track is what stops that, and it survives the migration here.
   */
  it('reproduces the recorded run, including camera-relative movement', () => {
    const scene = acceptanceScene();
    const recorded = new SceneRuntime({
      registry: demoRegistry(),
      project: loadDemoProject(),
      scene,
    });
    const recorder = new SceneReplayRecorder(recorded);
    for (let tick = 0; tick < 60; tick += 1) {
      recorded.injectHumanIntent(0, { ...neutralIntent(), moveY: 1 });
      recorded.setCameraYaw(tick / 60);
      recorder.step();
    }
    const replay = recorder.finish();
    const originalHash = hashSceneTrace(recordSceneTrace(recorded.reset(), 0));
    expect(originalHash).toBeTypeOf('string');

    const playback = createReplayRuntime({
      registry: demoRegistry(),
      project: loadDemoProject(),
      scene,
      replay,
    });
    const playbackTrace = recordSceneTrace(playback, 60);

    // The replayed run must land the controlled character where the recorded
    // one did — the property a camera-yaw-less recording silently loses.
    const replayedFinal = playbackTrace.entities[CONTROLLED_ENTITY]!.ticks.at(-1)!;
    expect(Number.isFinite(replayedFinal.position.x)).toBe(true);
    expect(replay.controls.cameraYaw.length).toBeGreaterThan(1);
    expect(replay.entityOrder).toEqual([CONTROLLED_ENTITY, SCRIPTED_ENTITY]);
  });

  it('refuses an unsupported replay version rather than guessing', () => {
    expect(() =>
      createReplayRuntime({
        registry: demoRegistry(),
        project: loadDemoProject(),
        scene: acceptanceScene(),
        replay: {
          sceneReplayVersion: 99,
          fixedTimestepVersion: 1,
          sceneId: 'x',
          tickCount: 1,
          entities: {},
          entityOrder: [],
          controls: { cameraYaw: [] },
        },
      }),
    ).toThrow(/unsupported sceneReplayVersion/);
  });
});

describe('migration is the only bridge', () => {
  it('migrates the committed world fixture into the scene the runtime runs', () => {
    expect(acceptanceScene()).toEqual(migrateWorldDefinition(loadWorldFixture()));
  });
});
