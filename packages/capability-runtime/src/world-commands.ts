/**
 * The machine-operable surface of the multi-instance world.
 *
 * Twelve commands, each with a declared input and output schema, each returning
 * structured issues rather than throwing. Notably absent: anything shaped like
 * `apply_patch(path, value)`. A general "edit arbitrary canonical JSON" command
 * would make every other guarantee in this package unenforceable — protection,
 * validation, the definition/instance boundary — because a caller could reach
 * past all of them through one hole and nothing would be able to tell that it
 * had. The commands here can only express changes the world contract allows.
 *
 * Mutating commands never write. They return a proposed `WorldDefinition` and
 * the canonical paths it touches; publishing stays on the existing validated
 * save/transaction path.
 */
import { Type } from '@sinclair/typebox';
import type {
  IntentSourceDefinition,
  ProjectDefinition,
  RuntimeInstanceDefinition,
  RuntimeInstanceOverrides,
  ValidationIssue,
  WorldDefinition,
} from '@atc/schema';
import { CURRENT_SCHEMA_VERSION, validateWorldReferences } from '@atc/schema';
import { evaluateEdit } from '@atc/runtime-core';
import {
  MAX_SIMULATED_TICKS,
  MAX_TRACED_TICKS,
  flattenObservations,
  observeInstance,
  observeWorld,
  simulateWorld,
} from '@atc/world-runtime';
import type { CommandContext, CommandDeclaration, CommandResult } from './manifest.ts';

const InstanceId = Type.String({ pattern: '^[a-z0-9][a-z0-9-]*$', minLength: 1, maxLength: 96 });
const Empty = Type.Object({}, { additionalProperties: false });

const IssueList = Type.Array(
  Type.Object(
    { path: Type.String(), message: Type.String(), keyword: Type.String() },
    { additionalProperties: false },
  ),
);

function ok<T>(output: T, staged?: WorldDefinition, changedPaths?: string[]): CommandResult<T> {
  return {
    ok: true,
    issues: [],
    output,
    ...(staged ? { stagedWorld: staged } : {}),
    ...(changedPaths ? { changedPaths } : {}),
  };
}

function refuse<T>(path: string, message: string, keyword = 'reference'): CommandResult<T> {
  return { ok: false, issues: [{ path, message, keyword }] };
}

function instanceOf(
  world: WorldDefinition,
  instanceId: string,
): RuntimeInstanceDefinition | undefined {
  return world.instances.find((entry) => entry.id === instanceId);
}

/**
 * Replaces one instance, leaving declaration order — and therefore tick order —
 * exactly as it was. A command that appended the edited instance would silently
 * reorder the world every time someone nudged a transform.
 */
function withInstance(
  world: WorldDefinition,
  instanceId: string,
  next: RuntimeInstanceDefinition,
): WorldDefinition {
  return {
    ...world,
    instances: world.instances.map((entry) => (entry.id === instanceId ? next : entry)),
  };
}

/**
 * Protection gate.
 *
 * Every mutating command runs through this before producing a staged world, so
 * a locked instance is locked for the AI path and the UI path alike. `actor`
 * defaults to `ai` because the unauthenticated caller is the one that must not
 * get the benefit of the doubt.
 */
function protectionRefusal(
  project: ProjectDefinition,
  world: WorldDefinition,
  path: string,
  actor: 'human' | 'ai',
): ValidationIssue | null {
  const decision = evaluateEdit({ ...project, world }, { path, actor });
  if (decision.allowed) return null;
  return {
    path,
    message: decision.reason,
    keyword: decision.requiresApproval ? 'approval-required' : 'protected',
  };
}

/** Re-checks the whole staged world, so no command can stage an invalid one. */
function validateStaged(
  project: ProjectDefinition,
  staged: WorldDefinition,
): ValidationIssue[] {
  const characterIds = new Set(project.characters.map((entry) => entry.id));
  return validateWorldReferences(staged, characterIds).issues;
}

function stagedOrIssues<T>(
  context: CommandContext,
  staged: WorldDefinition,
  output: T,
  changedPaths: string[],
): CommandResult<T> {
  const issues = validateStaged(context.project, staged);
  if (issues.length > 0) return { ok: false, issues };
  return ok(output, staged, changedPaths);
}

/* ------------------------------------------------------------------ read */

const listInstances: CommandDeclaration = {
  id: 'world.list_instances',
  description: 'Lists every runtime instance in the world, in tick order.',
  mutating: false,
  inputSchema: Empty,
  outputSchema: Type.Object(
    {
      worldId: Type.String(),
      focusedInstanceId: Type.String(),
      cameraTargetInstanceId: Type.String(),
      instances: Type.Array(
        Type.Object(
          {
            id: Type.String(),
            displayName: Type.String(),
            characterId: Type.String(),
            intentSourceKind: Type.String(),
            enabled: Type.Boolean(),
          },
          { additionalProperties: false },
        ),
      ),
    },
    { additionalProperties: false },
  ),
  execute: (_input: unknown, context: CommandContext) => ok({
      worldId: context.world.id,
      focusedInstanceId: context.world.focusedInstanceId,
      cameraTargetInstanceId: context.world.cameraTargetInstanceId,
      instances: context.world.instances.map((instance) => ({
        id: instance.id,
        displayName: instance.displayName,
        characterId: instance.source.characterId,
        intentSourceKind: instance.intentSource.kind,
        enabled: instance.enabled,
      })),
    }),
};

const inspectInstance: CommandDeclaration = {
  id: 'world.inspect_instance',
  description:
    'Returns one instance: its definition, its shared asset provenance, and its current runtime observation when a runtime is attached.',
  mutating: false,
  inputSchema: Type.Object({ instanceId: InstanceId }, { additionalProperties: false }),
  outputSchema: Type.Object(
    {
      definition: Type.Unknown(),
      sharedAssets: Type.Unknown(),
      observation: Type.Unknown(),
    },
    { additionalProperties: false },
  ),
  execute: (rawInput: unknown, context: CommandContext) => {
    const input = rawInput as { instanceId: string };

    const instance = instanceOf(context.world, input.instanceId);
    if (!instance) {
      return refuse('/instanceId', `unknown instance "${input.instanceId}"`);
    }
    const character = context.project.characters.find(
      (entry) => entry.id === instance.source.characterId,
    );
    return ok({
      definition: instance,
      // Provenance, not a copy: the point of the whole contract is that the
      // instance references these rather than owning them.
      sharedAssets: character
        ? {
            characterId: character.id,
            behavior: character.animation.behavior,
            motionSet: character.animation.motionSet,
            rig: character.animation.rig,
            tuning: character.animation.tuning ?? null,
          }
        : null,
      observation: context.runtime
        ? (observeInstance(context.runtime, input.instanceId) ?? null)
        : null,
    });
  },
};

const readObservations: CommandDeclaration = {
  id: 'world.read_observations',
  description:
    'Reads instance-qualified observations from the runtime attached to *this* command context. In-process only: it observes the current runtime and never a runtime from an earlier request. Over HTTP, use world.simulate, which returns its observations in the same response.',
  mutating: false,
  inputSchema: Type.Object(
    { instanceId: Type.Optional(InstanceId) },
    { additionalProperties: false },
  ),
  outputSchema: Type.Object(
    {
      tick: Type.Number(),
      observations: Type.Array(
        Type.Object({ path: Type.String(), value: Type.Unknown() }, { additionalProperties: false }),
      ),
    },
    { additionalProperties: false },
  ),
  execute: (rawInput: unknown, context: CommandContext) => {
    const input = rawInput as { instanceId?: string };

    if (!context.runtime) {
      return refuse('/', 'no runtime is attached to this context; use world.simulate', 'state');
    }
    const observation = observeWorld(context.runtime);
    const flat = flattenObservations(observation);
    const prefix = input.instanceId ? `/world/instances/${input.instanceId}/` : null;
    return ok({
      tick: observation.tick,
      observations: prefix ? flat.filter((entry) => entry.path.startsWith(prefix)) : flat,
    });
  },
};

const simulate: CommandDeclaration = {
  id: 'world.simulate',
  description:
    'Stateless: advances a fresh runtime by a fixed number of ticks and returns the final observation and a deterministic world hash in the same response. It keeps no server state, so nothing needs to be read back in a later request. Read-only with respect to the repository.',
  mutating: false,
  inputSchema: Type.Object(
    {
      ticks: Type.Integer({ minimum: 1, maximum: MAX_SIMULATED_TICKS }),
      includeFlatObservations: Type.Optional(Type.Boolean()),
      includeTrace: Type.Optional(Type.Boolean()),
      cameraYawRad: Type.Optional(Type.Number({ minimum: -1000, maximum: 1000 })),
    },
    { additionalProperties: false },
  ),
  outputSchema: Type.Object(
    {
      tick: Type.Number(),
      worldHash: Type.String(),
      instanceOrder: Type.Array(Type.String()),
      observation: Type.Unknown(),
      flatObservations: Type.Optional(Type.Unknown()),
      trace: Type.Optional(Type.Unknown()),
    },
    { additionalProperties: false },
  ),
  execute: (rawInput: unknown, context: CommandContext) => {
    const input = rawInput as {
      ticks: number;
      includeFlatObservations?: boolean;
      includeTrace?: boolean;
      cameraYawRad?: number;
    };
    if (!context.registry) {
      return refuse('/', 'no asset registry is attached to this command context', 'state');
    }
    /*
     * The trace is capped rather than the run. A caller can simulate ten
     * thousand ticks and get a hash; asking for every record of that run is how
     * one extra zero becomes a response nobody wanted to receive.
     */
    if (input.includeTrace && input.ticks > MAX_TRACED_TICKS) {
      return refuse(
        '/includeTrace',
        `a trace is limited to ${MAX_TRACED_TICKS} ticks; ${input.ticks} were requested`,
        'maximum',
      );
    }

    const worldIssues = validateStaged(context.project, context.world);
    if (worldIssues.length > 0) return { ok: false, issues: worldIssues };

    try {
      const result = simulateWorld({
        registry: context.registry,
        project: context.project,
        world: context.world,
        ticks: input.ticks,
        ...(input.includeFlatObservations === undefined
          ? {}
          : { includeFlatObservations: input.includeFlatObservations }),
        ...(input.includeTrace === undefined ? {} : { includeTrace: input.includeTrace }),
        ...(input.cameraYawRad === undefined ? {} : { cameraYawRad: input.cameraYawRad }),
      });
      return ok(result);
    } catch (error) {
      return refuse('/', error instanceof Error ? error.message : String(error), 'runtime');
    }
  },
};

/* --------------------------------------------------------------- mutating */

const createInstance: CommandDeclaration = {
  id: 'world.create_instance',
  description: 'Stages a new runtime instance referencing an existing character definition.',
  mutating: true,
  inputSchema: Type.Object(
    {
      instanceId: InstanceId,
      displayName: Type.String({ minLength: 1 }),
      characterId: InstanceId,
      transform: Type.Optional(
        Type.Object(
          {
            position: Type.Object(
              { x: Type.Number(), y: Type.Number(), z: Type.Number() },
              { additionalProperties: false },
            ),
            yawRad: Type.Number(),
          },
          { additionalProperties: false },
        ),
      ),
    },
    { additionalProperties: false },
  ),
  outputSchema: Type.Object(
    { instanceId: Type.String(), issues: IssueList },
    { additionalProperties: false },
  ),
  execute: (rawInput: unknown, context: CommandContext) => {
    const input = rawInput as {
      instanceId: string;
      displayName: string;
      characterId: string;
      transform?: RuntimeInstanceDefinition['transform'];
    };

    if (instanceOf(context.world, input.instanceId)) {
      return refuse('/instanceId', `instance "${input.instanceId}" already exists`, 'unique');
    }
    if (!context.project.characters.some((entry) => entry.id === input.characterId)) {
      return refuse('/characterId', `unknown character "${input.characterId}"`);
    }
    const refusal = protectionRefusal(
      context.project,
      context.world,
      '/world/instances',
      context.actor ?? 'ai',
    );
    if (refusal) return { ok: false, issues: [refusal] };

    const instance: RuntimeInstanceDefinition = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      id: input.instanceId,
      displayName: input.displayName,
      source: { kind: 'character', characterId: input.characterId },
      transform: input.transform ?? { position: { x: 0, y: 2, z: 0 }, yawRad: 0 },
      intentSource: { kind: 'none' },
      enabled: true,
    };
    const staged: WorldDefinition = {
      ...context.world,
      instances: [...context.world.instances, instance],
    };
    return stagedOrIssues(context, staged, { instanceId: instance.id, issues: [] }, [
      `/world/instances/${instance.id}`,
    ]);
  },
};

const duplicateInstance: CommandDeclaration = {
  id: 'world.duplicate_instance',
  description:
    'Stages a copy of an instance. The copy shares the source character reference; it does not copy any animation asset.',
  mutating: true,
  inputSchema: Type.Object(
    {
      instanceId: InstanceId,
      newInstanceId: InstanceId,
      displayName: Type.Optional(Type.String({ minLength: 1 })),
    },
    { additionalProperties: false },
  ),
  outputSchema: Type.Object(
    { instanceId: Type.String(), characterId: Type.String() },
    { additionalProperties: false },
  ),
  execute: (rawInput: unknown, context: CommandContext) => {
    const input = rawInput as { instanceId: string; newInstanceId: string; displayName?: string };

    const source = instanceOf(context.world, input.instanceId);
    if (!source) return refuse('/instanceId', `unknown instance "${input.instanceId}"`);
    if (instanceOf(context.world, input.newInstanceId)) {
      return refuse('/newInstanceId', `instance "${input.newInstanceId}" already exists`, 'unique');
    }
    const refusal = protectionRefusal(
      context.project,
      context.world,
      '/world/instances',
      context.actor ?? 'ai',
    );
    if (refusal) return { ok: false, issues: [refusal] };

    /*
     * A structural copy of the *definition* — the source reference is copied by
     * value because it is a reference. Duplicating the assets it names is the
     * failure this command exists to make impossible, and is what the harness
     * asserts against by counting asset documents before and after.
     */
    const copy: RuntimeInstanceDefinition = {
      ...structuredClone(source),
      id: input.newInstanceId,
      displayName: input.displayName ?? `${source.displayName} copy`,
    };
    const staged: WorldDefinition = {
      ...context.world,
      instances: [...context.world.instances, copy],
    };
    return stagedOrIssues(
      context,
      staged,
      { instanceId: copy.id, characterId: copy.source.characterId },
      [`/world/instances/${copy.id}`],
    );
  },
};

const removeInstance: CommandDeclaration = {
  id: 'world.remove_instance',
  description:
    'Stages the removal of an instance. Shared animation assets are untouched — the instance referenced them, it did not own them.',
  mutating: true,
  inputSchema: Type.Object({ instanceId: InstanceId }, { additionalProperties: false }),
  outputSchema: Type.Object({ removed: Type.String() }, { additionalProperties: false }),
  execute: (rawInput: unknown, context: CommandContext) => {
    const input = rawInput as { instanceId: string };

    const instance = instanceOf(context.world, input.instanceId);
    if (!instance) return refuse('/instanceId', `unknown instance "${input.instanceId}"`);
    const refusal = protectionRefusal(
      context.project,
      context.world,
      `/world/instances/${input.instanceId}`,
      context.actor ?? 'ai',
    );
    if (refusal) return { ok: false, issues: [refusal] };

    const staged: WorldDefinition = {
      ...context.world,
      instances: context.world.instances.filter((entry) => entry.id !== input.instanceId),
    };
    if (staged.instances.length === 0) {
      return refuse('/instanceId', 'a world must keep at least one instance', 'minItems');
    }
    return stagedOrIssues(context, staged, { removed: input.instanceId }, [
      `/world/instances/${input.instanceId}`,
    ]);
  },
};

const setInstanceEnabled: CommandDeclaration = {
  id: 'world.set_instance_enabled',
  description: 'Stages an instance as enabled or disabled. A disabled instance stops ticking and stays inspectable.',
  mutating: true,
  inputSchema: Type.Object(
    { instanceId: InstanceId, enabled: Type.Boolean() },
    { additionalProperties: false },
  ),
  outputSchema: Type.Object(
    { instanceId: Type.String(), enabled: Type.Boolean() },
    { additionalProperties: false },
  ),
  execute: (rawInput: unknown, context: CommandContext) => {
    const input = rawInput as { instanceId: string; enabled: boolean };

    const instance = instanceOf(context.world, input.instanceId);
    if (!instance) return refuse('/instanceId', `unknown instance "${input.instanceId}"`);
    const path = `/world/instances/${input.instanceId}/enabled`;
    const refusal = protectionRefusal(context.project, context.world, path, context.actor ?? 'ai');
    if (refusal) return { ok: false, issues: [refusal] };

    const staged = withInstance(context.world, input.instanceId, {
      ...instance,
      enabled: input.enabled,
    });
    return stagedOrIssues(
      context,
      staged,
      { instanceId: input.instanceId, enabled: input.enabled },
      [path],
    );
  },
};

const setInstanceCharacter: CommandDeclaration = {
  id: 'world.set_instance_character',
  description:
    'Stages which character definition an instance is a use of. Rebinds one instance; the definition itself is untouched and every other instance keeps referencing what it referenced.',
  mutating: true,
  inputSchema: Type.Object(
    { instanceId: InstanceId, characterId: InstanceId },
    { additionalProperties: false },
  ),
  outputSchema: Type.Object(
    { instanceId: Type.String(), characterId: Type.String() },
    { additionalProperties: false },
  ),
  execute: (rawInput: unknown, context: CommandContext) => {
    const input = rawInput as { instanceId: string; characterId: string };

    const instance = instanceOf(context.world, input.instanceId);
    if (!instance) return refuse('/instanceId', `unknown instance "${input.instanceId}"`);
    if (!context.project.characters.some((entry) => entry.id === input.characterId)) {
      return refuse('/characterId', `unknown character "${input.characterId}"`);
    }
    const path = `/world/instances/${input.instanceId}/source/characterId`;
    const refusal = protectionRefusal(context.project, context.world, path, context.actor ?? 'ai');
    if (refusal) return { ok: false, issues: [refusal] };

    const staged = withInstance(context.world, input.instanceId, {
      ...instance,
      source: { kind: 'character', characterId: input.characterId },
    });
    return stagedOrIssues(
      context,
      staged,
      { instanceId: input.instanceId, characterId: input.characterId },
      [path],
    );
  },
};

const setInstanceTransform: CommandDeclaration = {
  id: 'world.set_instance_transform',
  description: 'Stages an instance-scoped transform. Affects exactly one instance.',
  mutating: true,
  inputSchema: Type.Object(
    {
      instanceId: InstanceId,
      position: Type.Object(
        {
          x: Type.Number({ minimum: -10000, maximum: 10000 }),
          y: Type.Number({ minimum: -10000, maximum: 10000 }),
          z: Type.Number({ minimum: -10000, maximum: 10000 }),
        },
        { additionalProperties: false },
      ),
      yawRad: Type.Number({ minimum: -1000, maximum: 1000 }),
    },
    { additionalProperties: false },
  ),
  outputSchema: Type.Object(
    { instanceId: Type.String(), transform: Type.Unknown() },
    { additionalProperties: false },
  ),
  execute: (rawInput: unknown, context: CommandContext) => {
    const input = rawInput as { instanceId: string; position: { x: number; y: number; z: number }; yawRad: number };

    const instance = instanceOf(context.world, input.instanceId);
    if (!instance) return refuse('/instanceId', `unknown instance "${input.instanceId}"`);
    const path = `/world/instances/${input.instanceId}/transform`;
    const refusal = protectionRefusal(context.project, context.world, path, context.actor ?? 'ai');
    if (refusal) return { ok: false, issues: [refusal] };

    const transform = { position: { ...input.position }, yawRad: input.yawRad };
    const staged = withInstance(context.world, input.instanceId, { ...instance, transform });
    return stagedOrIssues(context, staged, { instanceId: input.instanceId, transform }, [path]);
  },
};

const bindIntentSource: CommandDeclaration = {
  id: 'world.bind_intent_source',
  description: 'Stages the intent source bound to an instance.',
  mutating: true,
  inputSchema: Type.Object(
    {
      instanceId: InstanceId,
      intentSource: Type.Union([
        Type.Object(
          {
            kind: Type.Literal('local-input'),
            playerIndex: Type.Integer({ minimum: 0, maximum: 7 }),
          },
          { additionalProperties: false },
        ),
        Type.Object(
          { kind: Type.Literal('scripted-track'), trackId: InstanceId },
          { additionalProperties: false },
        ),
        Type.Object(
          { kind: Type.Literal('replay'), replayId: InstanceId },
          { additionalProperties: false },
        ),
        Type.Object({ kind: Type.Literal('none') }, { additionalProperties: false }),
      ]),
    },
    { additionalProperties: false },
  ),
  outputSchema: Type.Object(
    { instanceId: Type.String(), intentSourceKind: Type.String() },
    { additionalProperties: false },
  ),
  execute: (rawInput: unknown, context: CommandContext) => {
    const input = rawInput as { instanceId: string; intentSource: IntentSourceDefinition };

    const instance = instanceOf(context.world, input.instanceId);
    if (!instance) return refuse('/instanceId', `unknown instance "${input.instanceId}"`);
    const path = `/world/instances/${input.instanceId}/intentSource`;
    const refusal = protectionRefusal(context.project, context.world, path, context.actor ?? 'ai');
    if (refusal) return { ok: false, issues: [refusal] };

    const staged = withInstance(context.world, input.instanceId, {
      ...instance,
      intentSource: input.intentSource,
    });
    return stagedOrIssues(
      context,
      staged,
      { instanceId: input.instanceId, intentSourceKind: input.intentSource.kind },
      [path],
    );
  },
};

/**
 * Drops a key from an instance's overrides, and the overrides object itself
 * once it is empty.
 *
 * "Reset to the definition default" has to mean *absent*, not "written back to
 * whatever the default happens to be today": an override recorded as `false`
 * because that was the default at the time would silently stop following the
 * character definition the moment somebody changed it.
 */
function withoutOverride(
  overrides: RuntimeInstanceOverrides | undefined,
  key: keyof RuntimeInstanceOverrides,
): RuntimeInstanceOverrides | undefined {
  if (!overrides || !(key in overrides)) return overrides;
  const next = { ...overrides };
  delete next[key];
  return Object.keys(next).length === 0 ? undefined : next;
}

function withOverrides(
  instance: RuntimeInstanceDefinition,
  overrides: RuntimeInstanceOverrides | undefined,
): RuntimeInstanceDefinition {
  const next = { ...instance };
  if (overrides) next.overrides = overrides;
  else delete next.overrides;
  return next;
}

const setInstanceWeaponMode: CommandDeclaration = {
  id: 'world.set_instance_weapon_mode',
  description:
    'Stages the weapon mode one instance opens in, as an instance override. The shared character definition is untouched — omit weaponModeId to fall back to it.',
  mutating: true,
  inputSchema: Type.Object(
    {
      instanceId: InstanceId,
      /** Absent means "no override": follow the character definition. */
      weaponModeId: Type.Optional(Type.String({ minLength: 1, maxLength: 96 })),
    },
    { additionalProperties: false },
  ),
  outputSchema: Type.Object(
    { instanceId: Type.String(), weaponModeId: Type.Union([Type.String(), Type.Null()]) },
    { additionalProperties: false },
  ),
  execute: (rawInput: unknown, context: CommandContext) => {
    const input = rawInput as { instanceId: string; weaponModeId?: string };

    const instance = instanceOf(context.world, input.instanceId);
    if (!instance) return refuse('/instanceId', `unknown instance "${input.instanceId}"`);
    const path = `/world/instances/${input.instanceId}/overrides/weaponModeId`;
    const refusal = protectionRefusal(context.project, context.world, path, context.actor ?? 'ai');
    if (refusal) return { ok: false, issues: [refusal] };

    const overrides =
      input.weaponModeId === undefined
        ? withoutOverride(instance.overrides, 'weaponModeId')
        : { ...(instance.overrides ?? {}), weaponModeId: input.weaponModeId };

    const staged = withInstance(
      context.world,
      input.instanceId,
      withOverrides(instance, overrides),
    );
    return stagedOrIssues(
      context,
      staged,
      { instanceId: input.instanceId, weaponModeId: input.weaponModeId ?? null },
      [path],
    );
  },
};

const setInstanceEquipment: CommandDeclaration = {
  id: 'world.set_instance_equipment',
  description:
    'Stages one equipment slot as equipped or unequipped for one instance. Omit `equipped` to clear the override and follow the character definition default.',
  mutating: true,
  inputSchema: Type.Object(
    {
      instanceId: InstanceId,
      slotId: InstanceId,
      /** Absent means "no override": follow the slot's declared default. */
      equipped: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
  ),
  outputSchema: Type.Object(
    {
      instanceId: Type.String(),
      slotId: Type.String(),
      equipped: Type.Union([Type.Boolean(), Type.Null()]),
    },
    { additionalProperties: false },
  ),
  execute: (rawInput: unknown, context: CommandContext) => {
    const input = rawInput as { instanceId: string; slotId: string; equipped?: boolean };

    const instance = instanceOf(context.world, input.instanceId);
    if (!instance) return refuse('/instanceId', `unknown instance "${input.instanceId}"`);
    // Equipment slots are project data (PLAN: "no code anywhere learns the word
    // shield"), so an unknown slot is a reference error the command can catch
    // rather than an override that quietly never applies to anything.
    if (!context.project.equipment.some((slot) => slot.id === input.slotId)) {
      return refuse('/slotId', `unknown equipment slot "${input.slotId}"`);
    }
    const path = `/world/instances/${input.instanceId}/overrides/equipped/${input.slotId}`;
    const refusal = protectionRefusal(context.project, context.world, path, context.actor ?? 'ai');
    if (refusal) return { ok: false, issues: [refusal] };

    const equippedOverrides = { ...(instance.overrides?.equipped ?? {}) };
    if (input.equipped === undefined) delete equippedOverrides[input.slotId];
    else equippedOverrides[input.slotId] = input.equipped;

    const overrides =
      Object.keys(equippedOverrides).length === 0
        ? withoutOverride(instance.overrides, 'equipped')
        : { ...(instance.overrides ?? {}), equipped: equippedOverrides };

    const staged = withInstance(
      context.world,
      input.instanceId,
      withOverrides(instance, overrides),
    );
    return stagedOrIssues(
      context,
      staged,
      { instanceId: input.instanceId, slotId: input.slotId, equipped: input.equipped ?? null },
      [path],
    );
  },
};

export const WORLD_COMMANDS: CommandDeclaration[] = [
  listInstances,
  inspectInstance,
  readObservations,
  simulate,
  createInstance,
  duplicateInstance,
  removeInstance,
  setInstanceEnabled,
  setInstanceCharacter,
  setInstanceTransform,
  bindIntentSource,
  setInstanceWeaponMode,
  setInstanceEquipment,
];
