/**
 * `character.control` — the machine path onto a character's *control*, not its
 * animation.
 *
 * The commands here accept normalized intent and nothing else. There is
 * deliberately no `play_animation`, no `force_state` and no `set_clip`: those
 * skip the transition rules, input windows, equipment context and root-motion
 * policy the character's tuning consists of, so an AI using them would be
 * playing a different character from the one a human tuned (work package §2.6).
 *
 * Simulation here is **stateless**. Each call builds a runtime, advances it and
 * discards it, so the same project plus the same intent frames plus the same
 * tick count produce the same answer in a fresh process (§15.6). The
 * alternative — a session store — would make the API require sticky routing to
 * answer a question that is already a pure function of its inputs.
 */
import { Type } from '@sinclair/typebox';
import type { CharacterSceneEntity, SceneDefinition } from '@atc/schema';
import { SceneRuntime, hashSceneTrace, observeScene, recordSceneTrace } from '@atc/scene-runtime';
import { neutralIntent, type CharacterIntent } from '@atc/character-control-runtime';
import type { CapabilityManifest, CommandContext, CommandResult } from './manifest.ts';

/** The largest run a caller may ask for, so one extra zero cannot hang a request. */
const MAX_TICKS = 2000;

const IntentFrame = Type.Object(
  {
    moveX: Type.Optional(Type.Number({ minimum: -1, maximum: 1 })),
    moveY: Type.Optional(Type.Number({ minimum: -1, maximum: 1 })),
    lookX: Type.Optional(Type.Number({ minimum: -1, maximum: 1 })),
    lookY: Type.Optional(Type.Number({ minimum: -1, maximum: 1 })),
    buttons: Type.Optional(Type.Record(Type.String(), Type.Boolean())),
  },
  { additionalProperties: false },
);

function requireRuntimeInputs(
  context: CommandContext,
): { scene: SceneDefinition; issues: null } | { scene: null; issues: CommandResult } {
  if (!context.scene) {
    return {
      scene: null,
      issues: {
        ok: false,
        issues: [
          { path: '/scene', message: 'this command needs a target scene', keyword: 'reference' },
        ],
      },
    };
  }
  if (!context.registry) {
    return {
      scene: null,
      issues: {
        ok: false,
        issues: [
          {
            path: '/registry',
            // Named rather than silently returning zeroes: a caller reading an
            // all-zero observation cannot tell "nothing happened" from
            // "nothing ran".
            message: 'this command needs an asset registry to build a runtime',
            keyword: 'reference',
          },
        ],
      },
    };
  }
  return { scene: context.scene, issues: null };
}

function intentFrom(frame: Record<string, unknown>): CharacterIntent {
  const intent = neutralIntent();
  for (const axis of ['moveX', 'moveY', 'lookX', 'lookY'] as const) {
    const value = frame[axis];
    if (typeof value === 'number') intent[axis] = value;
  }
  const buttons = frame.buttons as Record<string, boolean> | undefined;
  if (buttons) {
    for (const [action, value] of Object.entries(buttons)) {
      if (action in intent.buttons) {
        (intent.buttons as Record<string, boolean>)[action] = value;
      }
    }
  }
  return intent;
}

export const CHARACTER_CONTROL_CAPABILITY: CapabilityManifest = {
  id: 'character.control',
  version: '1.0.0',
  description:
    'Drive a scene character with normalized intent, and read back what it did. Never selects clips or states directly.',
  schemaIds: ['SceneDefinition', 'CharacterSceneEntity'],
  runtimeSystems: [
    '@atc/character-control-runtime/ControllableCharacter',
    '@atc/scene-runtime/SceneRuntime',
  ],

  commands: [
    {
      id: 'character-control.simulate',
      description:
        'Runs the scene for N ticks with the given intent frames applied to one entity, then discards the runtime.',
      mutating: false,
      inputSchema: Type.Object(
        {
          entityId: Type.String({ minLength: 1 }),
          ticks: Type.Integer({ minimum: 1, maximum: MAX_TICKS }),
          /** Held for the whole run unless `frames` supplies per-tick values. */
          intent: Type.Optional(IntentFrame),
          frames: Type.Optional(Type.Array(IntentFrame, { maxItems: MAX_TICKS })),
        },
        { additionalProperties: false },
      ),
      outputSchema: Type.Object(
        {
          tick: Type.Integer(),
          sceneHash: Type.String(),
          entityOrder: Type.Array(Type.String()),
          finalPosition: Type.Object(
            { x: Type.Number(), y: Type.Number(), z: Type.Number() },
            { additionalProperties: false },
          ),
        },
        { additionalProperties: false },
      ),
      execute: (input, context) => {
        const guard = requireRuntimeInputs(context);
        if (guard.issues) return guard.issues;

        const request = input as {
          entityId: string;
          ticks: number;
          intent?: Record<string, unknown>;
          frames?: Record<string, unknown>[];
        };

        const runtime = new SceneRuntime({
          registry: context.registry!,
          project: context.project,
          scene: guard.scene,
        });

        if (!runtime.character(request.entityId)) {
          return {
            ok: false,
            issues: [
              {
                path: `/entities/${request.entityId}`,
                message: `no runnable character entity "${request.entityId}"`,
                keyword: 'reference',
              },
            ],
          };
        }

        const held = request.intent ? intentFrom(request.intent) : neutralIntent();
        for (let tick = 0; tick < request.ticks; tick += 1) {
          const frame = request.frames?.[tick];
          // Injected straight onto the character's own source, so an AI frame
          // and a keypress reach the state machine by the identical path.
          runtime.character(request.entityId)!.injectIntent(frame ? intentFrom(frame) : held);
          runtime.step();
        }

        const observation = runtime.character(request.entityId)!.observe();
        const trace = recordSceneTrace(
          new SceneRuntime({
            registry: context.registry!,
            project: context.project,
            scene: guard.scene,
          }),
          request.ticks,
        );

        return {
          ok: true,
          issues: [],
          output: {
            tick: runtime.tick,
            sceneHash: hashSceneTrace(trace),
            entityOrder: [...runtime.entityIds],
            finalPosition: { ...observation.transform.position },
          },
        };
      },
    },
    {
      id: 'character-control.observe',
      description:
        'Reads one character back: its controller, state ids, intent and transform.',
      mutating: false,
      inputSchema: Type.Object(
        { entityId: Type.String({ minLength: 1 }) },
        { additionalProperties: false },
      ),
      outputSchema: Type.Object(
        {
          entityId: Type.String(),
          controllerKind: Type.String(),
          locomotionStateId: Type.String(),
          actionStateId: Type.String(),
          intentSourceKind: Type.String(),
          enabled: Type.Boolean(),
        },
        { additionalProperties: false },
      ),
      execute: (input, context) => {
        const guard = requireRuntimeInputs(context);
        if (guard.issues) return guard.issues;
        const { entityId } = input as { entityId: string };

        const runtime = new SceneRuntime({
          registry: context.registry!,
          project: context.project,
          scene: guard.scene,
        });
        const character = runtime.character(entityId);
        const resolved = runtime.resolvedCharacter(entityId);
        if (!character || !resolved) {
          return {
            ok: false,
            issues: [
              {
                path: `/entities/${entityId}`,
                message: `no runnable character entity "${entityId}"`,
                keyword: 'reference',
              },
            ],
          };
        }

        const observation = character.observe();
        return {
          ok: true,
          issues: [],
          output: {
            entityId,
            controllerKind: (resolved.definition as CharacterSceneEntity).controller.kind,
            locomotionStateId: observation.locomotionStateId,
            actionStateId: observation.actionStateId,
            intentSourceKind: observation.intentSourceKind,
            enabled: observation.enabled,
          },
        };
      },
    },
    {
      id: 'character-control.scene_observations',
      description: 'Every entity-qualified observation for the scene, as paths and values.',
      mutating: false,
      inputSchema: Type.Object({}, { additionalProperties: false }),
      outputSchema: Type.Object(
        { sceneId: Type.String(), entityCount: Type.Integer() },
        { additionalProperties: false },
      ),
      execute: (_input, context) => {
        const guard = requireRuntimeInputs(context);
        if (guard.issues) return guard.issues;
        const runtime = new SceneRuntime({
          registry: context.registry!,
          project: context.project,
          scene: guard.scene,
        });
        const observation = observeScene(runtime);
        return {
          ok: true,
          issues: [],
          output: { sceneId: observation.sceneId, entityCount: observation.entities.length },
        };
      },
    },
  ],

  authoringSurfaces: [
    {
      id: 'character-control.inspector',
      capabilityId: 'character.control',
      title: 'Character Runtime',
      fields: [
        {
          id: 'character-control.move',
          label: 'Move',
          description: 'Normalized movement intent, the same value a stick produces.',
          scope: 'instance',
          control: { kind: 'number', min: -1, max: 1, step: 0.01 },
          commandId: 'character-control.simulate',
          observationIds: ['character.intent', 'character.locomotion-state'],
        },
        {
          id: 'character-control.state',
          label: 'Runtime state',
          description: 'Which locomotion and action states the character is in.',
          scope: 'instance',
          control: { kind: 'enum', values: ['locomotion', 'action'] },
          commandId: 'character-control.observe',
          observationIds: ['character.locomotion-state', 'character.action-state'],
        },
      ],
    },
  ],

  observations: [
    {
      id: 'character.intent',
      description: 'The normalized intent one character consumed on the last tick.',
      pathExample: '/scenes/test-room/entities/honoka-01/intent/moveY',
    },
    {
      id: 'character.locomotion-state',
      description: 'The locomotion layer state id.',
      pathExample: '/scenes/test-room/entities/honoka-01/animation/layers/locomotion/stateId',
    },
    {
      id: 'character.action-state',
      description: 'The action layer state id.',
      pathExample: '/scenes/test-room/entities/honoka-01/animation/layers/action/stateId',
    },
  ],

  fixtures: [
    {
      id: 'character-control.demo-project',
      description: 'The shipped project, whose scene runs two characters on one definition.',
      path: 'projects/demo-character/project.json',
    },
  ],

  harnessStages: [
    { id: 'character-control.equivalence', script: 'harness:character-control' },
    { id: 'character-control.scene-contract', script: 'harness:scenes' },
  ],
};
