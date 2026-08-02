/**
 * `world.multi-instance` — the capability this work package adds.
 *
 * Every field is load-bearing. The authoring surface below is what the browser
 * renders its instance controls from: labels, ranges and step sizes are read
 * from here rather than typed a second time into JSX, which is what makes
 * "adding a declared field with no command fails the harness" a real statement
 * about the UI rather than about a document nobody reads.
 */
import { WORLD_COMMANDS } from './world-commands.ts';
import { REFERENCE_CAPABILITY } from './reference-capability.ts';
import type { CapabilityManifest } from './manifest.ts';
import { CapabilityRegistry } from './registry.ts';

export const WORLD_CAPABILITY_ID = 'world.multi-instance';

export const WORLD_CAPABILITY: CapabilityManifest = {
  id: WORLD_CAPABILITY_ID,
  version: '1.0.0',
  description:
    'Multiple runtime instances of shared character definitions, each with independent mutable state and its own bound intent source, ticking in one deterministic fixed-step world.',
  schemaIds: ['WorldDefinition', 'RuntimeInstanceDefinition', 'IntentTrackDefinition'],
  runtimeSystems: ['@atc/world-runtime:WorldRuntime', '@atc/world-runtime:IntentSource'],
  authoringSurfaces: [
    {
      id: 'world.instance-inspector',
      capabilityId: WORLD_CAPABILITY_ID,
      title: 'Runtime instance',
      fields: [
        {
          id: 'instance.enabled',
          label: 'Enabled',
          description: 'A disabled instance stops ticking. It stays selectable and inspectable.',
          scope: 'instance',
          control: { kind: 'boolean' },
          commandId: 'world.set_instance_enabled',
          observationIds: ['world.instance.enabled'],
        },
        {
          id: 'instance.position',
          label: 'Position',
          description: 'Where this instance spawns. Instance-scoped: no other instance moves.',
          scope: 'instance',
          control: { kind: 'vector3', min: -50, max: 50, step: 0.1 },
          commandId: 'world.set_instance_transform',
          observationIds: ['world.instance.transform'],
        },
        {
          id: 'instance.yaw',
          label: 'Yaw',
          description: 'Spawn facing, in radians.',
          scope: 'instance',
          control: { kind: 'number', min: -Math.PI, max: Math.PI, step: 0.01 },
          commandId: 'world.set_instance_transform',
          observationIds: ['world.instance.transform'],
        },
        {
          id: 'instance.intentSource',
          label: 'Intent source',
          description:
            'What drives this instance. Changing it rebinds one instance; it does not touch the shared character definition.',
          scope: 'instance',
          control: {
            kind: 'enum',
            values: ['local-input', 'scripted-track', 'replay', 'none'],
          },
          commandId: 'world.bind_intent_source',
          observationIds: ['world.instance.intentSource', 'world.instance.intent'],
        },
      ],
    },
  ],
  commands: WORLD_COMMANDS as CapabilityManifest['commands'],
  observations: [
    { id: 'world.tick', description: 'World fixed-step tick counter.', pathExample: '/world/tick' },
    {
      id: 'world.instance.enabled',
      description: 'Whether an instance is ticking.',
      pathExample: '/world/instances/controlled-humanoid/enabled',
    },
    {
      id: 'world.instance.source',
      description: 'The character definition an instance references.',
      pathExample: '/world/instances/controlled-humanoid/source/characterId',
    },
    {
      id: 'world.instance.intentSource',
      description: 'The intent source bound to an instance.',
      pathExample: '/world/instances/scripted-humanoid/intentSource/kind',
    },
    {
      id: 'world.instance.transform',
      description: 'An instance’s current runtime transform.',
      pathExample: '/world/instances/controlled-humanoid/transform/position/x',
    },
    {
      id: 'world.instance.animation.layers',
      description: 'Per-layer state id, normalized time and resolved clip.',
      pathExample: '/world/instances/scripted-humanoid/animation/layers/locomotion/stateId',
    },
    {
      id: 'world.instance.intent',
      description: 'The normalized intent an instance received this tick.',
      pathExample: '/world/instances/scripted-humanoid/intent/Move',
    },
    {
      id: 'world.instance.events',
      description: 'Semantic events an instance emitted this tick.',
      pathExample: '/world/instances/controlled-humanoid/events',
    },
  ],
  fixtures: [
    {
      id: 'two-humanoids-shared-animation',
      description:
        'Two instances of one character definition: one on local input, one on a scripted track.',
      path: 'tests/fixtures/world/two-humanoids-shared-animation.json',
    },
  ],
  harnessStages: [
    { id: 'world-contract', script: 'harness:world' },
    { id: 'capability-completeness', script: 'harness:capabilities' },
  ],
};

/**
 * The registry the API and the harness both read.
 *
 * A second, deliberately trivial capability is registered alongside the world
 * one so the completeness rules are exercised against something that is not the
 * capability they were written for. A registry with exactly one member is
 * indistinguishable from a hard-coded special case.
 */
export function createDefaultRegistry(): CapabilityRegistry {
  const registry = new CapabilityRegistry();
  registry.register(WORLD_CAPABILITY);
  registry.register(REFERENCE_CAPABILITY);
  return registry;
}
