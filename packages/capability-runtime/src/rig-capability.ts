/**
 * `rig.edit` — the machine path onto one Character Definition.
 *
 * Scoped narrowly on purpose. A Character's *own* fields — capsule dimensions,
 * display name, model path — are edited here. Its animation graph, motion set,
 * rig and tuning are **references**, and changing those is a question about
 * blast radius ("only this character, or every character on this behaviour?")
 * that the existing animation-asset destination flow already answers. Exposing
 * a `rig.set_blend_duration` here would be a second answer to that question,
 * and the second answer would be the one with no destination dialog in front
 * of it.
 *
 * Nothing here writes. A mutating command returns the proposed character; the
 * apply path publishes it.
 */
import { Type } from '@sinclair/typebox';
import type { CharacterDefinition, ProjectDefinition } from '@atc/schema';
import { validateProject, validateProjectReferences } from '@atc/schema';
import { evaluateEdit } from '@atc/runtime-core';
import type { CapabilityManifest, CommandContext, CommandResult } from './manifest.ts';

function targetCharacter(context: CommandContext): CharacterDefinition | undefined {
  const id = context.characterId ?? context.project.activeCharacterId;
  return context.project.characters.find((entry) => entry.id === id);
}

function missingCharacter(context: CommandContext): CommandResult {
  return {
    ok: false,
    issues: [
      {
        path: '/characterId',
        message: `no character "${context.characterId ?? context.project.activeCharacterId}"`,
        keyword: 'reference',
      },
    ],
  };
}

const CharacterOutput = Type.Object(
  {
    characterId: Type.String(),
    displayName: Type.String(),
    capsuleRadius: Type.Number(),
    capsuleHeight: Type.Number(),
    changedPaths: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);

/**
 * Applies one field change to the target character.
 *
 * Protection is checked for the *calling actor* before anything changes, on the
 * exact path being written — the same gate the Inspector goes through, so a
 * locked capsule is locked for an AI command too.
 */
function setField(
  context: CommandContext,
  field: 'displayName' | 'capsuleRadius' | 'capsuleHeight',
  value: string | number,
): CommandResult {
  const character = targetCharacter(context);
  if (!character) return missingCharacter(context);

  const path = `/characters/${character.id}/${field}`;
  const decision = evaluateEdit(context.project, {
    path,
    actor: context.actor ?? 'ai',
  });
  if (!decision.allowed) {
    return {
      ok: false,
      issues: [
        {
          path,
          message: decision.reason || `protection refuses this edit by ${context.actor ?? 'ai'}`,
          keyword: decision.requiresApproval ? 'approval-required' : 'protection',
        },
      ],
    };
  }

  const updated = { ...character, [field]: value } as CharacterDefinition;
  const project: ProjectDefinition = {
    ...context.project,
    characters: context.project.characters.map((entry) =>
      entry.id === character.id ? updated : entry,
    ),
  };

  // Validated as a whole project, not as a lone character: a capsule radius is
  // only meaningful against the schema bounds the project is checked with.
  const issues = [
    ...validateProject(project).issues,
    ...validateProjectReferences(project).issues,
  ];
  if (issues.length > 0) return { ok: false, issues };

  return {
    ok: true,
    issues: [],
    output: {
      characterId: updated.id,
      displayName: updated.displayName,
      capsuleRadius: updated.capsuleRadius,
      capsuleHeight: updated.capsuleHeight,
      changedPaths: [path],
    },
    changedPaths: [path],
  };
}

export const RIG_CAPABILITY: CapabilityManifest = {
  id: 'rig.edit',
  version: '1.0.0',
  description:
    "Tune one Character Definition's own fields. Animation asset references keep their existing destination flow.",
  schemaIds: ['ProjectDefinition', 'CharacterAnimationAssignment'],
  runtimeSystems: ['@atc/editor-core/EditSession', '@atc/animation-asset-runtime'],

  commands: [
    {
      id: 'rig.set_capsule',
      description: 'Sets the character capsule used for probes and step-up checks.',
      mutating: true,
      inputSchema: Type.Object(
        {
          radius: Type.Optional(Type.Number({ minimum: 0.05, maximum: 2 })),
          height: Type.Optional(Type.Number({ minimum: 0.2, maximum: 4 })),
        },
        { additionalProperties: false },
      ),
      outputSchema: CharacterOutput,
      execute: (input, context) => {
        const { radius, height } = input as { radius?: number; height?: number };
        if (radius === undefined && height === undefined) {
          return {
            ok: false,
            issues: [
              { path: '/', message: 'give a radius, a height, or both', keyword: 'shape' },
            ],
          };
        }
        if (radius !== undefined) {
          const result = setField(context, 'capsuleRadius', radius);
          if (!result.ok || height === undefined) return result;
        }
        return setField(context, 'capsuleHeight', height!);
      },
    },
    {
      /*
       * One command per field, rather than a `{ field, value }` setter.
       *
       * The generic shape is smaller and is exactly the escape hatch §4.9
       * forbids: a command that takes a field selector and an untyped value has
       * no schema that can describe what a valid call looks like, so the
       * validation moves into the body where nobody can see it. An existing
       * registry test asserts that no command anywhere accepts `path`, `patch`
       * or `value`, and it is right to.
       */
      id: 'rig.set_display_name',
      description: "Sets the character's display name. Never its identity.",
      mutating: true,
      inputSchema: Type.Object(
        { displayName: Type.String({ minLength: 1, maxLength: 120 }) },
        { additionalProperties: false },
      ),
      outputSchema: CharacterOutput,
      execute: (input, context) =>
        setField(context, 'displayName', (input as { displayName: string }).displayName),
    },
    {
      id: 'rig.observe',
      description: 'Reads one Character Definition back, including its asset references.',
      mutating: false,
      inputSchema: Type.Object({}, { additionalProperties: false }),
      outputSchema: Type.Object(
        {
          characterId: Type.String(),
          displayName: Type.String(),
          capsuleRadius: Type.Number(),
          capsuleHeight: Type.Number(),
          behaviorAssetId: Type.String(),
          motionSetAssetId: Type.String(),
          rigAssetId: Type.String(),
        },
        { additionalProperties: false },
      ),
      execute: (_input, context) => {
        const character = targetCharacter(context);
        if (!character) return missingCharacter(context);
        return {
          ok: true,
          issues: [],
          output: {
            characterId: character.id,
            displayName: character.displayName,
            capsuleRadius: character.capsuleRadius,
            capsuleHeight: character.capsuleHeight,
            behaviorAssetId: character.animation.behavior?.assetId ?? '',
            motionSetAssetId: character.animation.motionSet?.assetId ?? '',
            rigAssetId: character.animation.rig?.assetId ?? '',
          },
        };
      },
    },
    {
      id: 'rig.validate',
      description: 'Validates the project the target character belongs to.',
      mutating: false,
      inputSchema: Type.Object({}, { additionalProperties: false }),
      outputSchema: Type.Object(
        { valid: Type.Boolean(), issueCount: Type.Integer() },
        { additionalProperties: false },
      ),
      execute: (_input, context) => {
        const issues = [
          ...validateProject(context.project).issues,
          ...validateProjectReferences(context.project).issues,
        ];
        return {
          ok: true,
          issues: [],
          output: { valid: issues.length === 0, issueCount: issues.length },
        };
      },
    },
  ],

  authoringSurfaces: [
    {
      id: 'rig.character-inspector',
      capabilityId: 'rig.edit',
      title: 'Character',
      fields: [
        {
          id: 'rig.capsule-radius',
          label: 'Capsule radius',
          description: 'Metres. Used for capsule probes and step-up checks.',
          scope: 'shared-definition',
          control: { kind: 'number', min: 0.05, max: 2, step: 0.01 },
          commandId: 'rig.set_capsule',
          observationIds: ['rig.capsule'],
        },
        {
          id: 'rig.capsule-height',
          label: 'Capsule height',
          description: 'Metres.',
          scope: 'shared-definition',
          control: { kind: 'number', min: 0.2, max: 4, step: 0.01 },
          commandId: 'rig.set_capsule',
          observationIds: ['rig.capsule'],
        },
        {
          id: 'rig.display-name',
          label: 'Display name',
          description: 'What a human calls this character. Never used as identity.',
          scope: 'shared-definition',
          control: { kind: 'enum', values: [] },
          commandId: 'rig.set_display_name',
          observationIds: ['rig.identity'],
        },
      ],
    },
  ],

  observations: [
    {
      id: 'rig.identity',
      description: 'The character id and display name the route resolved to.',
      pathExample: '/characters/demo-humanoid/displayName',
    },
    {
      id: 'rig.capsule',
      description: 'The character capsule dimensions.',
      pathExample: '/characters/demo-humanoid/capsuleRadius',
    },
    {
      id: 'rig.animation-references',
      description: 'Which behaviour, motion set, rig and tuning the character references.',
      pathExample: '/characters/demo-humanoid/animation/behavior/assetId',
    },
  ],

  fixtures: [
    {
      id: 'rig.demo-project',
      description: 'The shipped project, whose two characters share one behaviour.',
      path: 'projects/demo-character/project.json',
    },
  ],

  harnessStages: [
    { id: 'rig.animation-assets', script: 'harness:animation-assets' },
    { id: 'rig.route-identity', script: 'harness:unit' },
  ],
};
