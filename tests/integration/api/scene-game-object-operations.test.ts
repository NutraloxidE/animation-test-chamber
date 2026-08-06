/**
 * All thirteen production Scene operations, driven through the real endpoint
 * against a real temporary checkout (§13.6).
 *
 * The claim each case makes is a four-way agreement:
 *
 *   the request           what the client asked for
 *   the apply response    what the server says it did
 *   scene.gameObjects     what is actually on disk afterwards
 *   a reloaded session    what a page opened after the write would show
 *
 * Any two of those agreeing proves nothing; a client that mis-assembled a
 * request and a server that mis-applied it agree perfectly. The reload is the
 * part that catches "the write landed somewhere nobody reads".
 *
 * Every case also asserts that `scene.entities` came through byte-identical
 * (§13.7). That is the property that makes the transitional policy safe: the
 * legacy mirror may be stale, and it is never written, so no production edit can
 * be silently reverted by regenerating it.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  GameObjectPrefabReference,
  GameObjectSceneOperation,
  ProjectDefinition,
  SceneDefinition,
} from '@atc/schema';
import { createApp } from '../../../apps/api/src/app.ts';
import { loadPrefabRegistry } from '../../../apps/api/src/context.ts';

const SOURCE_REPO = resolve(__dirname, '../../..');
const PROJECT_PATH = 'projects/demo-character/project.json';

let repoRoot: string;
let app: ReturnType<typeof createApp>['app'];

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'atc-scene-ops-'));
  mkdirSync(join(repoRoot, 'projects/demo-character'), { recursive: true });
  cpSync(join(SOURCE_REPO, PROJECT_PATH), join(repoRoot, PROJECT_PATH));
  for (const directory of ['assets/animation', 'assets/prefabs']) {
    cpSync(join(SOURCE_REPO, directory), join(repoRoot, directory), { recursive: true });
  }
  app = createApp({
    runtime: { repoRoot, health: { state: 'ready' }, transactionOptions: {} } as never,
  }).app;
});

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

function projectOf(): ProjectDefinition {
  return JSON.parse(readFileSync(join(repoRoot, PROJECT_PATH), 'utf8')) as ProjectDefinition;
}

function sceneOf(project = projectOf()): SceneDefinition {
  return project.scenes[0]!;
}

function gameObjectsOf() {
  return sceneOf().gameObjects ?? [];
}

function entityBytes(): string {
  return JSON.stringify(sceneOf().entities);
}

function reportFiles(): string[] {
  const directory = join(repoRoot, 'reports/apply');
  return existsSync(directory) ? readdirSync(directory).sort() : [];
}

function prefab(assetId: string, version = '1.0.0'): GameObjectPrefabReference {
  return loadPrefabRegistry(repoRoot).referenceTo(assetId, version);
}

interface ApplyResult {
  status: number;
  body: {
    ok?: boolean;
    status?: string;
    changedPaths?: string[];
    changedGameObjectIds?: string[];
    targetDocument?: SceneDefinition;
    issues?: { path: string; message: string; keyword: string }[];
  };
}

/**
 * One Apply, built as untrusted JSON rather than through a typed helper.
 *
 * That is what the endpoint actually receives, and a test that could only send
 * well-formed requests would prove nothing about the boundary it defends.
 */
async function applyOperations(
  operations: GameObjectSceneOperation[],
  intent = 'a scene edit',
): Promise<ApplyResult> {
  const project = projectOf();
  const response = await app.request('/api/repository/apply', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      target: { kind: 'scene', id: sceneOf(project).id },
      expected: { projectRevisionId: project.revisionId },
      operations,
      actor: 'human',
      intent,
    }),
  });
  return { status: response.status, body: (await response.json()) as ApplyResult['body'] };
}

/** The existing GameObjects of the seeded demo scene, by role. */
function seeded() {
  const gameObjects = gameObjectsOf();
  const camera = gameObjects.find((entry) => entry.relations.cameraTargetGameObjectId !== undefined);
  const character = gameObjects.find((entry) => entry.bindings.characterIntent !== undefined);
  return { camera: camera!, character: character!, all: gameObjects };
}

/**
 * Asserts the four-way agreement for one operation.
 *
 * `check` receives the Scene as re-read from disk — the "reloaded UI" half —
 * and the response the server sent.
 */
async function agrees(
  operations: GameObjectSceneOperation[],
  check: (persisted: SceneDefinition, result: ApplyResult) => void,
): Promise<void> {
  const entitiesBefore = entityBytes();
  const result = await applyOperations(operations);

  expect(result.status).toBe(200);
  expect(result.body.status).toBe('applied');

  const persisted = sceneOf();
  // The document the response returned and the document on disk are the same.
  expect(JSON.stringify(result.body.targetDocument)).toBe(JSON.stringify(persisted));
  // And the legacy mirror was not touched on the way.
  expect(entityBytes()).toBe(entitiesBefore);

  check(persisted, result);
}

describe('scene.place_prefab', () => {
  it('persists an exact Prefab reference and reports the id it created', async () => {
    await agrees(
      [
        {
          type: 'scene.place_prefab',
          gameObjectId: 'placed-light-rig',
          displayName: 'Placed light rig',
          prefab: prefab('default-scene-camera'),
        },
      ],
      (persisted, result) => {
        const placed = persisted.gameObjects!.find((entry) => entry.id === 'placed-light-rig');
        expect(placed?.prefab.version).toBe('1.0.0');
        expect(placed?.prefab.contentHash).toHaveLength(64);
        expect(result.body.changedGameObjectIds).toEqual(['placed-light-rig']);
        expect(result.body.changedPaths).toEqual(['/gameObjects/placed-light-rig']);
      },
    );
  });
});

describe('scene.rename_game_object and scene.set_transform', () => {
  it('renames one instance and leaves the others alone', async () => {
    const { character, all } = seeded();
    await agrees(
      [
        {
          type: 'scene.rename_game_object',
          gameObjectId: character.id,
          displayName: 'Renamed through the endpoint',
        },
      ],
      (persisted, result) => {
        expect(
          persisted.gameObjects!.find((entry) => entry.id === character.id)!.displayName,
        ).toBe('Renamed through the endpoint');
        expect(persisted.gameObjects).toHaveLength(all.length);
        expect(result.body.changedGameObjectIds).toEqual([character.id]);
      },
    );
  });

  it('persists an authored transform that survives a reload', async () => {
    const { character } = seeded();
    const moved = {
      position: { x: 3.5, y: 0, z: -2.25 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      scale: { x: 1, y: 1, z: 1 },
    };
    await agrees(
      [{ type: 'scene.set_transform', gameObjectId: character.id, transform: moved }],
      (persisted) => {
        expect(
          persisted.gameObjects!.find((entry) => entry.id === character.id)!.transform.position,
        ).toEqual(moved.position);
      },
    );

    /*
     * The reload, with nothing in between (§13.12). No migration command, no
     * reconciliation pass — the value a fresh read finds is the value the edit
     * wrote, or the edit did not really land.
     */
    const reloaded = sceneOf();
    expect(
      reloaded.gameObjects!.find((entry) => entry.id === character.id)!.transform.position.x,
    ).toBe(3.5);
  });
});

describe('scene.set_enabled', () => {
  it('disables an instance without removing it', async () => {
    const { character } = seeded();
    await agrees(
      [{ type: 'scene.set_enabled', gameObjectId: character.id, enabled: false }],
      (persisted) => {
        const disabled = persisted.gameObjects!.find((entry) => entry.id === character.id)!;
        expect(disabled.enabled).toBe(false);
        // Disabled is a statement about simulation, not about existence.
        expect(disabled.prefab).toBeDefined();
      },
    );
  });
});

describe('scene.duplicate_game_object', () => {
  it('duplicates a camera without copying its target relation', async () => {
    const { camera } = seeded();
    await agrees(
      [{ type: 'scene.duplicate_game_object', gameObjectId: camera.id }],
      (persisted) => {
        const copy = persisted.gameObjects!.find((entry) => entry.id === `${camera.id}-copy`);
        expect(copy).toBeDefined();
        expect(copy!.prefab).toEqual(camera.prefab);
        expect(copy!.relations).toEqual({});
      },
    );
  });
});

describe('scene.delete_game_object', () => {
  it('refuses while a relation still targets the object', async () => {
    const { character } = seeded();
    const before = readFileSync(join(repoRoot, PROJECT_PATH), 'utf8');
    const result = await applyOperations([
      { type: 'scene.delete_game_object', gameObjectId: character.id },
    ]);

    expect(result.status).toBe(422);
    expect(result.body.status).toBe('invalid');
    // Nothing was written, and no report was left describing a write.
    expect(readFileSync(join(repoRoot, PROJECT_PATH), 'utf8')).toBe(before);
    expect(reportFiles()).toEqual([]);
  });

  it('deletes an untargeted object and clears the active camera it named', async () => {
    const { camera } = seeded();
    await agrees(
      [
        // The relation goes first: an object nothing points at can be deleted.
        { type: 'scene.set_relation', gameObjectId: camera.id, relations: {} },
        { type: 'scene.delete_game_object', gameObjectId: camera.id },
      ],
      (persisted, result) => {
        expect(persisted.gameObjects!.some((entry) => entry.id === camera.id)).toBe(false);
        expect(persisted.activeCameraGameObjectId).toBeUndefined();
        expect(result.body.changedGameObjectIds).toContain(camera.id);
      },
    );
  });
});

describe('scene.set_prefab_source', () => {
  it('moves an instance onto another Prefab and clears incompatible overrides', async () => {
    const { character } = seeded();
    await agrees(
      [
        {
          type: 'scene.set_component_override',
          gameObjectId: character.id,
          override: {
            nodeId: 'root',
            componentId: 'model',
            patches: [{ path: '/castShadow', op: 'set', value: false }],
          },
        },
        {
          type: 'scene.set_prefab_source',
          gameObjectId: character.id,
          prefab: prefab('relay'),
        },
      ],
      (persisted) => {
        const moved = persisted.gameObjects!.find((entry) => entry.id === character.id)!;
        expect(moved.prefab.assetId).toBe('relay');
        // `relay` has a `model` Component too, so this override survives — the
        // clearing rule is about targets that no longer exist, not about
        // discarding everything on principle.
        expect(moved.componentOverrides).toHaveLength(1);
      },
    );
  });

  it('refuses a Prefab version the repository does not hold', async () => {
    const { character } = seeded();
    const result = await applyOperations([
      {
        type: 'scene.set_prefab_source',
        gameObjectId: character.id,
        prefab: {
          assetType: 'game-object-prefab',
          assetId: 'navigator',
          version: '9.9.9',
          contentHash: 'f'.repeat(64),
        },
      },
    ]);
    expect(result.status).toBe(422);
    expect(result.body.issues?.[0]!.message).toContain('never resolved to "latest"');
  });
});

describe('component overrides', () => {
  it('sets and then clears an override, round-tripping through disk', async () => {
    const { character } = seeded();
    await agrees(
      [
        {
          type: 'scene.set_component_override',
          gameObjectId: character.id,
          override: {
            nodeId: 'root',
            componentId: 'model',
            patches: [{ path: '/castShadow', op: 'set', value: false }],
          },
        },
      ],
      (persisted) => {
        expect(
          persisted.gameObjects!.find((entry) => entry.id === character.id)!.componentOverrides,
        ).toHaveLength(1);
      },
    );

    await agrees(
      [
        {
          type: 'scene.clear_component_override',
          gameObjectId: character.id,
          nodeId: 'root',
          componentId: 'model',
        },
      ],
      (persisted) => {
        expect(
          persisted.gameObjects!.find((entry) => entry.id === character.id)!.componentOverrides,
        ).toEqual([]);
      },
    );
  });

  it('refuses an override addressing a node the Prefab does not have', async () => {
    const { character } = seeded();
    const result = await applyOperations([
      {
        type: 'scene.set_component_override',
        gameObjectId: character.id,
        override: {
          nodeId: 'no-such-node',
          componentId: 'model',
          patches: [{ path: '/castShadow', op: 'set', value: false }],
        },
      },
    ]);
    expect(result.status).toBe(422);
  });
});

describe('scene.set_instance_binding', () => {
  it('rebinds a character intent', async () => {
    const { character } = seeded();
    await agrees(
      [
        {
          type: 'scene.set_instance_binding',
          gameObjectId: character.id,
          bindings: { characterIntent: { kind: 'ai', channelId: 'default' } },
        },
      ],
      (persisted) => {
        expect(
          persisted.gameObjects!.find((entry) => entry.id === character.id)!.bindings
            .characterIntent,
        ).toEqual({ kind: 'ai', channelId: 'default' });
      },
    );
  });

  it('refuses a character intent on a Prefab with no motor to drive', async () => {
    const { camera } = seeded();
    const result = await applyOperations([
      {
        type: 'scene.set_instance_binding',
        gameObjectId: camera.id,
        bindings: { characterIntent: { kind: 'human', playerIndex: 0 } },
      },
    ]);
    expect(result.status).toBe(422);
    expect(result.body.issues?.[0]!.keyword).toBe('capability');
  });
});

describe('scene.set_relation', () => {
  it('re-aims a camera at a different GameObject', async () => {
    const { camera, all } = seeded();
    const other = all.find(
      (entry) => entry.id !== camera.id && entry.id !== camera.relations.cameraTargetGameObjectId,
    )!;
    await agrees(
      [
        {
          type: 'scene.set_relation',
          gameObjectId: camera.id,
          relations: { cameraTargetGameObjectId: other.id },
        },
      ],
      (persisted) => {
        expect(
          persisted.gameObjects!.find((entry) => entry.id === camera.id)!.relations
            .cameraTargetGameObjectId,
        ).toBe(other.id);
      },
    );
  });

  it('refuses a target that is not in the Scene', async () => {
    const { camera } = seeded();
    const result = await applyOperations([
      {
        type: 'scene.set_relation',
        gameObjectId: camera.id,
        relations: { cameraTargetGameObjectId: 'nobody' },
      },
    ]);
    expect(result.status).toBe(422);
  });
});

describe('scene.reorder_game_object', () => {
  it('changes declaration order and leaves id-based relations intact', async () => {
    const { camera } = seeded();
    const targetBefore = camera.relations.cameraTargetGameObjectId;
    await agrees(
      [{ type: 'scene.reorder_game_object', gameObjectId: camera.id, toIndex: 0 }],
      (persisted) => {
        expect(persisted.gameObjects![0]!.id).toBe(camera.id);
        expect(persisted.gameObjects![0]!.relations.cameraTargetGameObjectId).toBe(targetBefore);
      },
    );
  });
});

describe('scene.set_active_camera', () => {
  it('accepts an enabled GameObject that resolves to a Camera Component', async () => {
    const { camera } = seeded();
    /*
     * Two separate Applies, not one with both operations in it. Clearing and
     * re-setting the same camera in one request produces the document already
     * on disk, which the endpoint correctly reports as `no-change` — the right
     * answer to that request, and not the one this test is about.
     */
    await agrees([{ type: 'scene.set_active_camera', gameObjectId: null }], (persisted) => {
      expect(persisted.activeCameraGameObjectId).toBeUndefined();
    });
    await agrees(
      [{ type: 'scene.set_active_camera', gameObjectId: camera.id }],
      (persisted, result) => {
        expect(persisted.activeCameraGameObjectId).toBe(camera.id);
        expect(result.body.changedPaths).toEqual(['/activeCameraGameObjectId']);
      },
    );
  });

  it.each([
    ['an unknown id', 'no-such-object'],
    ['a GameObject with no Camera Component', null as unknown as string],
  ])('refuses %s', async (label, id) => {
    const { character } = seeded();
    const target = id ?? character.id;
    const before = readFileSync(join(repoRoot, PROJECT_PATH), 'utf8');
    const result = await applyOperations([
      { type: 'scene.set_active_camera', gameObjectId: target },
    ]);
    expect(result.status, label).toBe(422);
    expect(readFileSync(join(repoRoot, PROJECT_PATH), 'utf8')).toBe(before);
  });

  it('refuses a disabled camera', async () => {
    const { camera } = seeded();
    await applyOperations([
      { type: 'scene.set_active_camera', gameObjectId: null },
      { type: 'scene.set_enabled', gameObjectId: camera.id, enabled: false },
    ]);
    const before = readFileSync(join(repoRoot, PROJECT_PATH), 'utf8');
    const result = await applyOperations([
      { type: 'scene.set_active_camera', gameObjectId: camera.id },
    ]);
    expect(result.status).toBe(422);
    expect(readFileSync(join(repoRoot, PROJECT_PATH), 'utf8')).toBe(before);
  });
});

describe('a stale revision writes nothing at all', () => {
  it('returns a conflict with zero changed paths and zero file changes', async () => {
    const { character } = seeded();
    const project = projectOf();
    const before = readFileSync(join(repoRoot, PROJECT_PATH), 'utf8');
    const entitiesBefore = entityBytes();

    // Something else moves the repository forward underneath this caller.
    writeFileSync(
      join(repoRoot, PROJECT_PATH),
      `${JSON.stringify({ ...project, revisionId: 'moved-on-externally' }, null, 2)}\n`,
      'utf8',
    );
    const afterExternal = readFileSync(join(repoRoot, PROJECT_PATH), 'utf8');

    const response = await app.request('/api/repository/apply', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        target: { kind: 'scene', id: sceneOf(project).id },
        expected: { projectRevisionId: project.revisionId },
        operations: [
          {
            type: 'scene.rename_game_object',
            gameObjectId: character.id,
            displayName: 'Renamed on a stale baseline',
          },
        ],
        actor: 'human',
        intent: 'apply against a baseline that moved',
      }),
    });
    const body = (await response.json()) as ApplyResult['body'];

    expect(response.status).toBe(409);
    expect(body.status).toBe('conflict');
    expect(body.changedPaths ?? []).toEqual([]);
    expect(body.changedGameObjectIds ?? []).toEqual([]);

    // Zero writes: the project is exactly what the external writer left, the
    // entity mirror is untouched, and no report claims otherwise.
    expect(readFileSync(join(repoRoot, PROJECT_PATH), 'utf8')).toBe(afterExternal);
    expect(entityBytes()).toBe(entitiesBefore);
    expect(reportFiles()).toEqual([]);
    expect(before).not.toBe(afterExternal);
  });
});

describe('the retired entity operations are refused by name', () => {
  it.each([
    'scene.place_asset',
    'scene.delete_entity',
    'scene.duplicate_entity',
    'scene.rename_entity',
    'scene.set_character_source',
    'scene.bind_controller',
    'scene.reorder_entity',
    'scene.rename',
  ])('refuses %s with 400 and no write', async (type) => {
    const before = readFileSync(join(repoRoot, PROJECT_PATH), 'utf8');
    const project = projectOf();
    const response = await app.request('/api/repository/apply', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        target: { kind: 'scene', id: sceneOf(project).id },
        expected: { projectRevisionId: project.revisionId },
        operations: [{ type, entityId: 'anything', displayName: 'anything' }],
        actor: 'human',
        intent: 'send a retired operation',
      }),
    });
    const body = (await response.json()) as ApplyResult['body'];

    expect(response.status).toBe(400);
    // Named, not dumped as a thirteen-member union failure: a client still
    // sending this needs to read the word back.
    expect(body.issues?.[0]!.message).toContain(type);
    expect(readFileSync(join(repoRoot, PROJECT_PATH), 'utf8')).toBe(before);
    expect(reportFiles()).toEqual([]);
  });
});
