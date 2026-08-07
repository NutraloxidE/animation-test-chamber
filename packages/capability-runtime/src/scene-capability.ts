/**
 * `scene.edit` — the machine path onto a Scene Definition.
 *
 * Every command here delegates to `applySceneOperation`, the same function the
 * Scene Editor's Inspector, gizmos and drops go through (work package §4.7).
 * That is the whole point: a UI drag and an AI command that perform the same
 * authored change must dispatch the *same* typed operation, because two
 * implementations of "place a character" are two answers to what a valid scene
 * is, and only one of them would be exercised by the tests.
 *
 * Nothing here writes. A mutating command returns `stagedScene`; publishing it
 * stays on the validated apply path, which is the only path that knows how to
 * be atomic and how to refuse a stale baseline.
 */
import { Type } from '@sinclair/typebox';
import type { SceneDefinition, SceneEntityDefinition } from '@atc/schema';
import { applySceneOperation, type SceneOperation } from '@atc/editor-core';
import type {
  CapabilityManifest,
  CommandContext,
  CommandResult,
} from './manifest.ts';

const Vec3 = Type.Object(
  { x: Type.Number(), y: Type.Number(), z: Type.Number() },
  { additionalProperties: false },
);

const Quat = Type.Object(
  { x: Type.Number(), y: Type.Number(), z: Type.Number(), w: Type.Number() },
  { additionalProperties: false },
);

const TransformInput = Type.Object(
  { position: Vec3, rotation: Quat, scale: Vec3 },
  { additionalProperties: false },
);

const SceneOutput = Type.Object(
  {
    sceneId: Type.String(),
    entityCount: Type.Integer(),
    changedPaths: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);

function missingScene(): CommandResult {
  return {
    ok: false,
    issues: [
      {
        path: '/scene',
        message: 'this command needs a target scene; pass one in the command context',
        keyword: 'reference',
      },
    ],
  };
}

/**
 * Runs one operation against the context's scene and reports the result.
 *
 * The single place a `scene.*` command touches a document, so protection,
 * validation and path reporting cannot diverge between commands.
 */
function run(context: CommandContext, operation: SceneOperation): CommandResult {
  const scene = context.scene;
  if (!scene) return missingScene();

  const result = applySceneOperation(scene, operation, context.project);
  if (!result.ok || result.document === undefined) {
    return { ok: false, issues: result.issues };
  }
  return {
    ok: true,
    issues: [],
    output: {
      sceneId: result.document.id,
      entityCount: result.document.entities.length,
      changedPaths: result.changedPaths ?? [],
    },
    stagedScene: result.document,
    changedPaths: result.changedPaths ?? [],
  };
}

function entityOf(scene: SceneDefinition, entityId: string): SceneEntityDefinition | undefined {
  return scene.entities.find((entity) => entity.id === entityId);
}

export const SCENE_CAPABILITY: CapabilityManifest = {
  id: 'scene.edit',
  version: '1.0.0',
  description:
    'Compose one Scene Definition: place, remove, reorder and configure entities, and bind their controllers.',
  schemaIds: ['SceneDefinition', 'SceneEntityDefinition', 'CharacterControllerBindingDefinition'],
  runtimeSystems: ['@atc/editor-core/operations', '@atc/scene-runtime/SceneRuntime'],

  commands: [
    {
      id: 'scene.place_asset',
      description: 'Places a Character, prop, light or camera into the scene.',
      mutating: true,
      inputSchema: Type.Object(
        {
          entityId: Type.String({ minLength: 1 }),
          displayName: Type.String({ minLength: 1 }),
          asset: Type.Union([
            Type.Object(
              { kind: Type.Literal('character'), characterId: Type.String() },
              { additionalProperties: false },
            ),
            Type.Object(
              {
                kind: Type.Literal('light'),
                lightType: Type.Union([
                  Type.Literal('directional'),
                  Type.Literal('point'),
                  Type.Literal('spot'),
                ]),
              },
              { additionalProperties: false },
            ),
            Type.Object({ kind: Type.Literal('camera') }, { additionalProperties: false }),
          ]),
          transform: Type.Optional(TransformInput),
        },
        { additionalProperties: false },
      ),
      outputSchema: SceneOutput,
      execute: (input, context) =>
        run(context, { type: 'scene.place_asset', ...(input as object) } as SceneOperation),
    },
    {
      id: 'scene.delete_entity',
      description: 'Removes one entity and repairs references that named it.',
      mutating: true,
      inputSchema: Type.Object(
        { entityId: Type.String({ minLength: 1 }) },
        { additionalProperties: false },
      ),
      outputSchema: SceneOutput,
      execute: (input, context) =>
        run(context, { type: 'scene.delete_entity', ...(input as object) } as SceneOperation),
    },
    {
      id: 'scene.duplicate_entity',
      description:
        'Copies one entity, keeping its reference to the shared Character or asset.',
      mutating: true,
      inputSchema: Type.Object(
        { entityId: Type.String({ minLength: 1 }) },
        { additionalProperties: false },
      ),
      outputSchema: SceneOutput,
      execute: (input, context) =>
        run(context, { type: 'scene.duplicate_entity', ...(input as object) } as SceneOperation),
    },
    {
      id: 'scene.set_transform',
      description: 'Places one entity at an authored position, rotation and scale.',
      mutating: true,
      inputSchema: Type.Object(
        { entityId: Type.String({ minLength: 1 }), transform: TransformInput },
        { additionalProperties: false },
      ),
      outputSchema: SceneOutput,
      execute: (input, context) =>
        run(context, { type: 'scene.set_transform', ...(input as object) } as SceneOperation),
    },
    {
      id: 'scene.set_enabled',
      description: 'Enables or disables one entity. A disabled entity does not tick.',
      mutating: true,
      inputSchema: Type.Object(
        { entityId: Type.String({ minLength: 1 }), enabled: Type.Boolean() },
        { additionalProperties: false },
      ),
      outputSchema: SceneOutput,
      execute: (input, context) =>
        run(context, { type: 'scene.set_enabled', ...(input as object) } as SceneOperation),
    },
    {
      id: 'scene.bind_controller',
      description:
        'Binds a character entity to a human, script, AI, replay or no controller.',
      mutating: true,
      inputSchema: Type.Object(
        {
          entityId: Type.String({ minLength: 1 }),
          controller: Type.Union([
            Type.Object(
              { kind: Type.Literal('human'), playerIndex: Type.Integer({ minimum: 0, maximum: 7 }) },
              { additionalProperties: false },
            ),
            Type.Object(
              { kind: Type.Literal('script'), trackId: Type.String() },
              { additionalProperties: false },
            ),
            Type.Object(
              { kind: Type.Literal('ai'), channelId: Type.String() },
              { additionalProperties: false },
            ),
            Type.Object(
              { kind: Type.Literal('replay'), replayId: Type.String() },
              { additionalProperties: false },
            ),
            Type.Object({ kind: Type.Literal('none') }, { additionalProperties: false }),
          ]),
        },
        { additionalProperties: false },
      ),
      outputSchema: SceneOutput,
      execute: (input, context) =>
        run(context, { type: 'scene.bind_controller', ...(input as object) } as SceneOperation),
    },
    {
      id: 'scene.reorder_entity',
      description:
        'Moves one entity in declaration order, which is also tick order.',
      mutating: true,
      inputSchema: Type.Object(
        { entityId: Type.String({ minLength: 1 }), toIndex: Type.Integer({ minimum: 0 }) },
        { additionalProperties: false },
      ),
      outputSchema: SceneOutput,
      execute: (input, context) =>
        run(context, { type: 'scene.reorder_entity', ...(input as object) } as SceneOperation),
    },
    {
      id: 'scene.observe',
      description: 'Reads the scene back: entity ids, kinds, controllers and transforms.',
      mutating: false,
      inputSchema: Type.Object(
        { entityId: Type.Optional(Type.String()) },
        { additionalProperties: false },
      ),
      outputSchema: Type.Object(
        {
          sceneId: Type.String(),
          entities: Type.Array(
            Type.Object(
              {
                entityId: Type.String(),
                kind: Type.String(),
                enabled: Type.Boolean(),
                characterId: Type.Optional(Type.String()),
                controllerKind: Type.Optional(Type.String()),
                position: Vec3,
              },
              { additionalProperties: false },
            ),
          ),
        },
        { additionalProperties: false },
      ),
      execute: (input, context) => {
        const scene = context.scene;
        if (!scene) return missingScene();
        const { entityId } = input as { entityId?: string };

        if (entityId !== undefined && !entityOf(scene, entityId)) {
          return {
            ok: false,
            issues: [
              {
                path: `/entities/${entityId}`,
                message: `no entity "${entityId}"`,
                keyword: 'reference',
              },
            ],
          };
        }

        const entities = scene.entities
          .filter((entity) => entityId === undefined || entity.id === entityId)
          .map((entity) => ({
            entityId: entity.id,
            kind: entity.kind,
            enabled: entity.enabled,
            ...(entity.kind === 'character'
              ? { characterId: entity.characterId, controllerKind: entity.controller.kind }
              : {}),
            position: { ...entity.transform.position },
          }));

        return { ok: true, issues: [], output: { sceneId: scene.id, entities } };
      },
    },
  ],

  authoringSurfaces: [
    {
      id: 'scene.inspector',
      capabilityId: 'scene.edit',
      title: 'Scene Inspector',
      fields: [
        {
          id: 'scene.entity.position',
          label: 'Position',
          description: 'Where the entity is placed, in scene coordinates.',
          scope: 'instance',
          control: { kind: 'vector3', min: -10000, max: 10000, step: 0.1 },
          commandId: 'scene.set_transform',
          observationIds: ['scene.entity.transform'],
        },
        {
          id: 'scene.entity.enabled',
          label: 'Enabled',
          description: 'A disabled entity does not tick and is not rendered.',
          scope: 'instance',
          control: { kind: 'boolean' },
          commandId: 'scene.set_enabled',
          observationIds: ['scene.entity.enabled'],
        },
        {
          id: 'scene.entity.controller',
          label: 'Controller',
          description: 'Which source drives this character.',
          scope: 'instance',
          control: { kind: 'enum', values: ['human', 'script', 'ai', 'replay', 'none'] },
          commandId: 'scene.bind_controller',
          observationIds: ['scene.entity.controller'],
        },
      ],
    },
  ],

  observations: [
    {
      id: 'scene.entity.enabled',
      description: 'Whether one entity ticks and renders.',
      pathExample: '/scenes/test-room/entities/honoka-01/enabled',
    },
    {
      id: 'scene.entity.transform',
      description: 'One entity is authored placement.',
      pathExample: '/scenes/test-room/entities/honoka-01/transform/position/x',
    },
    {
      id: 'scene.entity.controller',
      description: 'Which controller drives one character entity.',
      pathExample: '/scenes/test-room/entities/honoka-01/controller/kind',
    },
  ],

  fixtures: [
    {
      id: 'scene.demo-project',
      description:
        'The shipped project, whose scene was migrated from the acceptance world fixture.',
      path: 'projects/demo-character/project.json',
    },
  ],

  harnessStages: [
    { id: 'scene.contract', script: 'harness:scenes' },
    { id: 'scene.equivalence', script: 'harness:replay' },
  ],
};
