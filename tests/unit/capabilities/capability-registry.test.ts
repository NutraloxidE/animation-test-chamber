/**
 * Capability completeness.
 *
 * The interesting test here is the last one: an intentionally incomplete
 * manifest must *fail*. Without it, `checkCapabilityCompleteness` could return
 * an empty list for every input and the suite would stay green.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Type } from '@sinclair/typebox';
import {
  CapabilityRegistry,
  REFERENCE_CAPABILITY,
  WORLD_CAPABILITY,
  WORLD_CAPABILITY_ID,
  checkCapabilityCompleteness,
  createDefaultRegistry,
  type CapabilityManifest,
} from '@atc/capability-runtime';

const REPO_ROOT = resolve(__dirname, '../../..');

function repoContext() {
  const packageJson = JSON.parse(
    readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8'),
  ) as { scripts: Record<string, string> };
  return {
    fileExists: (path: string) => existsSync(resolve(REPO_ROOT, path)),
    scripts: new Set(Object.keys(packageJson.scripts)),
  };
}

/** A manifest that is complete, so each test can break exactly one thing. */
function completeManifest(): CapabilityManifest {
  return {
    id: 'test.capability',
    version: '1.0.0',
    description: 'A complete capability used to check the completeness rules.',
    schemaIds: ['WorldDefinition'],
    runtimeSystems: ['test:System'],
    authoringSurfaces: [
      {
        id: 'test.surface',
        capabilityId: 'test.capability',
        title: 'Test',
        fields: [
          {
            id: 'test.field',
            label: 'Field',
            scope: 'instance',
            control: { kind: 'boolean' },
            commandId: 'test.command',
            observationIds: ['test.observation'],
          },
        ],
      },
    ],
    commands: [
      {
        id: 'test.command',
        description: 'Does nothing, verifiably.',
        mutating: false,
        inputSchema: Type.Object({}, { additionalProperties: false }),
        outputSchema: Type.Object({}, { additionalProperties: false }),
        execute: () => ({ ok: true, issues: [] }),
      },
    ],
    observations: [
      { id: 'test.observation', description: 'A value.', pathExample: '/world/tick' },
    ],
    fixtures: [
      {
        id: 'test.fixture',
        description: 'The acceptance world.',
        path: 'tests/fixtures/world/two-humanoids-shared-animation.json',
      },
    ],
    harnessStages: [{ id: 'test.stage', script: 'harness:capabilities' }],
  };
}

function issuesFor(manifest: CapabilityManifest): string[] {
  const registry = new CapabilityRegistry();
  registry.register(manifest);
  return checkCapabilityCompleteness(registry, repoContext()).map((issue) => issue.message);
}

describe('capability registry', () => {
  it('registers the world capability and a second, unrelated one', () => {
    const registry = createDefaultRegistry();
    const ids = registry.list().map((capability) => capability.id);
    expect(ids).toContain(WORLD_CAPABILITY_ID);
    expect(ids).toContain(REFERENCE_CAPABILITY.id);
    expect(ids).toHaveLength(2);
  });

  it('exposes every world command through discovery', () => {
    const ids = createDefaultRegistry()
      .commands()
      .map((command) => command.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'world.list_instances',
        'world.inspect_instance',
        'world.create_instance',
        'world.duplicate_instance',
        'world.remove_instance',
        'world.set_instance_enabled',
        'world.set_instance_transform',
        'world.bind_intent_source',
        'world.simulate',
        'world.read_observations',
      ]),
    );
  });

  it('offers no command that edits an arbitrary path', () => {
    for (const command of createDefaultRegistry().commands()) {
      const properties = Object.keys(
        (command.inputSchema as { properties?: Record<string, unknown> }).properties ?? {},
      );
      expect(properties).not.toContain('path');
      expect(properties).not.toContain('patch');
      expect(properties).not.toContain('value');
    }
  });

  it('gives every command an input and an output schema', () => {
    for (const command of createDefaultRegistry().commands()) {
      expect(command.inputSchema).toBeTruthy();
      expect(command.outputSchema).toBeTruthy();
    }
  });

  it('refuses to register the same capability twice', () => {
    const registry = createDefaultRegistry();
    expect(() => registry.register(WORLD_CAPABILITY)).toThrow(/already registered/);
  });
});

describe('capability completeness', () => {
  it('passes for the capabilities this repository ships', () => {
    expect(checkCapabilityCompleteness(createDefaultRegistry(), repoContext())).toEqual([]);
  });

  it('fails a capability with no machine-operable command', () => {
    expect(issuesFor({ ...completeManifest(), commands: [], authoringSurfaces: [] })).toContain(
      'declares no machine-operable command',
    );
  });

  it('fails a capability with no human authoring surface', () => {
    expect(issuesFor({ ...completeManifest(), authoringSurfaces: [] })).toContain(
      'declares no human authoring surface',
    );
  });

  it('fails a capability with no observation', () => {
    const manifest = completeManifest();
    manifest.observations = [];
    expect(issuesFor(manifest)).toContain('declares no observation');
  });

  it('fails a capability with no deterministic fixture', () => {
    expect(issuesFor({ ...completeManifest(), fixtures: [] })).toContain('declares no fixture');
  });

  it('fails a capability with no harness stage', () => {
    expect(issuesFor({ ...completeManifest(), harnessStages: [] })).toContain(
      'declares no harness stage',
    );
  });

  it('fails an authoring field wired to a command nobody implemented', () => {
    const manifest = completeManifest();
    manifest.authoringSurfaces[0]!.fields[0]!.commandId = 'test.missing';
    expect(issuesFor(manifest)).toContain(
      'field "test.field" is backed by unknown command "test.missing"',
    );
  });

  it('fails an authoring field reading an observation nobody emits', () => {
    const manifest = completeManifest();
    manifest.authoringSurfaces[0]!.fields[0]!.observationIds = ['test.missing'];
    expect(issuesFor(manifest)).toContain(
      'field "test.field" reads unknown observation "test.missing"',
    );
  });

  it('fails a fixture path that does not exist', () => {
    const manifest = completeManifest();
    manifest.fixtures[0]!.path = 'tests/fixtures/world/does-not-exist.json';
    expect(issuesFor(manifest)).toContain(
      'fixture "test.fixture" points at missing file tests/fixtures/world/does-not-exist.json',
    );
  });

  it('fails a harness stage that names no script', () => {
    const manifest = completeManifest();
    manifest.harnessStages[0]!.script = 'harness:imaginary';
    expect(issuesFor(manifest)).toContain(
      'harness stage "test.stage" names unknown script "harness:imaginary"',
    );
  });

  it('fails a schema id that is not canonical', () => {
    expect(issuesFor({ ...completeManifest(), schemaIds: ['NotARealSchema'] })).toContain(
      'declares schema "NotARealSchema", which is not in SCHEMA_REGISTRY',
    );
  });
});
