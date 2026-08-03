/**
 * `world.intent-tracks` — a second, deliberately small capability.
 *
 * It exists so the registry and the completeness harness are exercised against
 * a capability they were not written for. A registry with one member proves
 * nothing: every rule in it could be a hard-coded assumption about the world
 * capability and no test would notice.
 *
 * It is not a toy, though. Listing tracks and sampling one at a tick is exactly
 * what an author needs in order to answer "why did the scripted instance dodge
 * on tick 90", and it is answerable without starting a runtime.
 */
import { Type } from '@sinclair/typebox';
import type { IntentTrackDefinition, WorldDefinition } from '@atc/schema';
import { ScriptedTrackIntentSource } from '@atc/world-runtime';
import { evaluateEdit } from '@atc/runtime-core';
import type { CapabilityManifest, CommandContext, CommandDeclaration } from './manifest.ts';

const TrackId = Type.String({ pattern: '^[a-z0-9][a-z0-9-]*$', minLength: 1, maxLength: 96 });

function trackOf(world: WorldDefinition, trackId: string): IntentTrackDefinition | undefined {
  return world.intentTracks.find((track) => track.id === trackId);
}

const listTracks: CommandDeclaration = {
  id: 'intentTrack.list',
  description: 'Lists the deterministic intent tracks the world declares.',
  mutating: false,
  inputSchema: Type.Object({}, { additionalProperties: false }),
  outputSchema: Type.Object(
    {
      tracks: Type.Array(
        Type.Object(
          {
            id: Type.String(),
            displayName: Type.String(),
            loop: Type.Boolean(),
            durationTicks: Type.Number(),
            keyframeCount: Type.Number(),
          },
          { additionalProperties: false },
        ),
      ),
    },
    { additionalProperties: false },
  ),
  execute: (_input: unknown, context: CommandContext) => ({
    ok: true,
    issues: [],
    output: {
      tracks: context.world.intentTracks.map((track) => ({
        id: track.id,
        displayName: track.displayName,
        loop: track.loop,
        durationTicks: track.durationTicks,
        keyframeCount: track.keyframes.length,
      })),
    },
  }),
};

const sampleTrack: CommandDeclaration = {
  id: 'intentTrack.sample',
  description: 'Samples a track at a tick, using the same hold semantics the runtime uses.',
  mutating: false,
  inputSchema: Type.Object(
    { trackId: TrackId, tick: Type.Integer({ minimum: 0, maximum: 1_000_000 }) },
    { additionalProperties: false },
  ),
  outputSchema: Type.Object(
    {
      trackId: Type.String(),
      localTick: Type.Number(),
      intent: Type.Unknown(),
    },
    { additionalProperties: false },
  ),
  execute: (rawInput: unknown, context: CommandContext) => {
    const input = rawInput as { trackId: string; tick: number };

    const track = trackOf(context.world, input.trackId);
    if (!track) {
      return {
        ok: false,
        issues: [
          { path: '/trackId', message: `unknown track "${input.trackId}"`, keyword: 'reference' },
        ],
      };
    }
    // The runtime's own sampler, not a reimplementation: a second copy of the
    // hold rule is a second chance for the two to disagree about tick 90.
    const source = new ScriptedTrackIntentSource(track);
    const intent = source.sample(input.tick);
    return {
      ok: true,
      issues: [],
      output: { trackId: track.id, localTick: source.localTick(input.tick), intent },
    };
  },
};

const setTrackLoop: CommandDeclaration = {
  id: 'intentTrack.set_loop',
  description: 'Stages whether a track loops.',
  mutating: true,
  inputSchema: Type.Object(
    { trackId: TrackId, loop: Type.Boolean() },
    { additionalProperties: false },
  ),
  outputSchema: Type.Object(
    { trackId: Type.String(), loop: Type.Boolean() },
    { additionalProperties: false },
  ),
  execute: (rawInput: unknown, context: CommandContext) => {
    const input = rawInput as { trackId: string; loop: boolean };

    const track = trackOf(context.world, input.trackId);
    if (!track) {
      return {
        ok: false,
        issues: [
          { path: '/trackId', message: `unknown track "${input.trackId}"`, keyword: 'reference' },
        ],
      };
    }
    const path = `/world/intentTracks/${input.trackId}/loop`;
    const decision = evaluateEdit(
      { ...context.project, world: context.world },
      { path, actor: context.actor ?? 'ai' },
    );
    if (!decision.allowed) {
      return {
        ok: false,
        issues: [
          {
            path,
            message: decision.reason,
            keyword: decision.requiresApproval ? 'approval-required' : 'protected',
          },
        ],
      };
    }
    const staged: WorldDefinition = {
      ...context.world,
      intentTracks: context.world.intentTracks.map((entry) =>
        entry.id === input.trackId ? { ...entry, loop: input.loop } : entry,
      ),
    };
    return {
      ok: true,
      issues: [],
      output: { trackId: input.trackId, loop: input.loop },
      stagedWorld: staged,
      changedPaths: [path],
    };
  },
};

export const REFERENCE_CAPABILITY_ID = 'world.intent-tracks';

export const REFERENCE_CAPABILITY: CapabilityManifest = {
  id: REFERENCE_CAPABILITY_ID,
  version: '1.0.0',
  description:
    'Deterministic authored intent tracks: the composition and test primitive scripted instances sample.',
  schemaIds: ['IntentTrackDefinition'],
  runtimeSystems: ['@atc/world-runtime:ScriptedTrackIntentSource'],
  authoringSurfaces: [
    {
      id: 'world.intent-track-inspector',
      capabilityId: REFERENCE_CAPABILITY_ID,
      title: 'Intent track',
      fields: [
        {
          id: 'track.loop',
          label: 'Loop',
          description: 'Whether the track restarts at tick 0 after its duration.',
          scope: 'shared-definition',
          control: { kind: 'boolean' },
          commandId: 'intentTrack.set_loop',
          observationIds: ['intentTrack.sampledIntent'],
        },
      ],
    },
  ],
  commands: [listTracks, sampleTrack, setTrackLoop],
  observations: [
    {
      id: 'intentTrack.sampledIntent',
      description: 'The normalized intent a track produces at a tick, as the runtime samples it.',
      pathExample: '/world/instances/scripted-humanoid/intent/Move',
    },
  ],
  fixtures: [
    {
      id: 'scripted-locomotion-cycle',
      description: 'The track the scripted humanoid follows in the acceptance fixture.',
      path: 'tests/fixtures/world/two-humanoids-shared-animation.json',
    },
  ],
  harnessStages: [{ id: 'capability-completeness', script: 'harness:capabilities' }],
};
