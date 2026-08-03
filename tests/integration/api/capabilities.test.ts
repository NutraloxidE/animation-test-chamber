/**
 * The capability API over real handlers.
 *
 * The interesting cases are the read-only ones. Discovery and observation are
 * the tools an operator reaches for *because* something has gone wrong, so they
 * have to survive a repository that has gone read-only — while publication
 * stays refused by the same middleware.
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../../apps/api/src/app.ts';
import { createRepositoryRuntime } from '../../../apps/api/src/runtime.ts';
import { loadWorldFixture } from '../../fixtures/world.ts';

const REPO_ROOT = resolve(__dirname, '../../..');
const PROJECT_PATH = resolve(REPO_ROOT, 'projects/demo-character/project.json');

type Json = Record<string, unknown>;

function apiFor(readOnly: boolean) {
  const runtime = createRepositoryRuntime();
  if (readOnly) {
    runtime.health.readOnly = true;
    runtime.health.reason = 'test lockdown';
  }
  const { app } = createApp({ runtime });
  return {
    get: async (path: string) => {
      const response = await app.request(`http://localhost${path}`);
      return { status: response.status, body: (await response.json()) as Json };
    },
    post: async (path: string, body: unknown) => {
      const response = await app.request(`http://localhost${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: (await response.json()) as Json };
    },
  };
}

describe('capability API', () => {
  it('lists capabilities', async () => {
    const { status, body } = await apiFor(false).get('/api/capabilities');
    expect(status).toBe(200);
    const ids = (body.capabilities as { id: string }[]).map((entry) => entry.id);
    expect(ids).toContain('world.multi-instance');
    expect(ids).toContain('world.intent-tracks');
  });

  it('describes a capability including its authoring surface', async () => {
    const { status, body } = await apiFor(false).get('/api/capabilities/world.multi-instance');
    expect(status).toBe(200);
    expect((body.authoringSurfaces as unknown[]).length).toBeGreaterThan(0);
    expect((body.observations as unknown[]).length).toBeGreaterThan(0);
    expect((body.commands as { id: string }[]).map((entry) => entry.id)).toContain(
      'world.set_instance_transform',
    );
  });

  it('describes a command with both schemas', async () => {
    const { status, body } = await apiFor(false).get(
      '/api/capabilities/commands/world.set_instance_transform',
    );
    expect(status).toBe(200);
    expect(body.inputSchema).toBeTruthy();
    expect(body.outputSchema).toBeTruthy();
    expect(body.mutating).toBe(true);
  });

  it('404s an unknown capability and an unknown command', async () => {
    const api = apiFor(false);
    expect((await api.get('/api/capabilities/nope')).status).toBe(404);
    expect((await api.get('/api/capabilities/commands/nope')).status).toBe(404);
  });

  it('executes a read command against the canonical world', async () => {
    const { status, body } = await apiFor(false).post(
      '/api/capabilities/commands/world.list_instances',
      { input: {} },
    );
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    // The demo project ships the acceptance world, so a caller that supplies no
    // world of its own sees the two instances a human would see.
    const instances = (body.output as { instances: { id: string }[] }).instances;
    expect(instances.map((entry) => entry.id)).toEqual([
      'controlled-humanoid',
      'scripted-humanoid',
    ]);
  });

  it('returns structured issues with 422 rather than throwing', async () => {
    const { status, body } = await apiFor(false).post(
      '/api/capabilities/commands/world.inspect_instance',
      { input: { instanceId: 'not-a-real-instance' } },
    );
    expect(status).toBe(422);
    expect(body.ok).toBe(false);
    expect((body.issues as { message: string }[])[0]!.message).toContain('unknown instance');
  });

  it('keeps discovery and observation available in read-only mode', async () => {
    const api = apiFor(true);
    expect((await api.get('/api/capabilities')).status).toBe(200);
    expect((await api.get('/api/capabilities/world.multi-instance')).status).toBe(200);

    const listed = await api.post('/api/capabilities/commands/world.list_instances', { input: {} });
    expect(listed.status).toBe(200);

    const simulated = await api.post('/api/capabilities/commands/world.simulate', {
      input: { ticks: 5 },
    });
    expect(simulated.status).toBe(200);
    expect((simulated.body.output as { worldHash: string }).worldHash).toMatch(/^[0-9a-f]{8}$/);
  });

  it('still refuses a mutating command in read-only mode', async () => {
    const { status, body } = await apiFor(true).post(
      '/api/capabilities/commands/world.set_instance_transform',
      { input: { instanceId: 'controlled-humanoid', position: { x: 1, y: 2, z: 3 }, yawRad: 0 } },
    );
    expect(status).toBe(503);
    expect(JSON.stringify(body)).toContain('read');
  });
});

describe('stateless world simulation over HTTP', () => {
  it('returns final observations from stateless world.simulate over HTTP', async () => {
    const { status, body } = await apiFor(false).post(
      '/api/capabilities/commands/world.simulate',
      { input: { ticks: 120, includeFlatObservations: true } },
    );
    expect(status).toBe(200);
    expect(body.ok).toBe(true);

    const output = body.output as {
      tick: number;
      worldHash: string;
      instanceOrder: string[];
      observation: { instances: { instanceId: string; transform: { position: { z: number } } }[] };
      flatObservations: { path: string }[];
    };

    expect(output.tick).toBe(120);
    expect(output.worldHash).toMatch(/^[0-9a-f]{8}$/);
    expect(output.instanceOrder).toEqual(['controlled-humanoid', 'scripted-humanoid']);

    const ids = output.observation.instances.map((entry) => entry.instanceId);
    expect(ids).toEqual(['controlled-humanoid', 'scripted-humanoid']);

    // The whole point: the scripted instance is *not* at its tick-zero state in
    // the very response that ran it.
    const scripted = output.observation.instances.find(
      (entry) => entry.instanceId === 'scripted-humanoid',
    )!;
    expect(Math.abs(scripted.transform.position.z)).toBeGreaterThan(1);

    expect(
      output.flatObservations.some(
        (entry) => entry.path === '/world/instances/scripted-humanoid/transform/position/z',
      ),
    ).toBe(true);
    expect(output.flatObservations.every((entry) => !/\/instances\/\d+\//.test(entry.path))).toBe(
      true,
    );
  });

  it('produces the same simulate result in a fresh app instance', async () => {
    const payload = { input: { ticks: 90, includeFlatObservations: true } };
    const first = await apiFor(false).post('/api/capabilities/commands/world.simulate', payload);
    // A second app built from scratch: no shared runtime, no shared registry,
    // no session. Identical output is what proves none is needed.
    const second = await apiFor(false).post('/api/capabilities/commands/world.simulate', payload);

    expect(second.status).toBe(200);
    expect(JSON.stringify(second.body.output)).toBe(JSON.stringify(first.body.output));
  });

  it('does not write repository bytes while simulating a staged world', async () => {
    const before = readFileSync(PROJECT_PATH, 'utf8');
    const staged = loadWorldFixture();
    staged.instances[0]!.transform.position.x = 12.5;
    staged.instances[1]!.intentSource = { kind: 'none' };

    const { status, body } = await apiFor(false).post(
      '/api/capabilities/commands/world.simulate',
      { input: { ticks: 60 }, world: staged },
    );
    expect(status).toBe(200);

    const output = body.output as {
      observation: { instances: { instanceId: string; intentSourceKind: string }[] };
    };
    // The response reflects the supplied staged world, not the canonical one.
    const scripted = output.observation.instances.find(
      (entry) => entry.instanceId === 'scripted-humanoid',
    )!;
    expect(scripted.intentSourceKind).toBe('none');

    expect(readFileSync(PROJECT_PATH, 'utf8')).toBe(before);
    expect(existsSync(resolve(REPO_ROOT, '.chamber-asset-transactions'))).toBe(false);
  });

  it('simulates in a read-only repository while mutation stays refused', async () => {
    const before = readFileSync(PROJECT_PATH, 'utf8');
    const api = apiFor(true);

    expect((await api.get('/api/capabilities')).status).toBe(200);
    const simulated = await api.post('/api/capabilities/commands/world.simulate', {
      input: { ticks: 30 },
    });
    expect(simulated.status).toBe(200);

    const mutated = await api.post('/api/capabilities/commands/world.duplicate_instance', {
      input: { instanceId: 'controlled-humanoid', newInstanceId: 'copy-humanoid' },
    });
    expect(mutated.status).toBe(503);

    expect(readFileSync(PROJECT_PATH, 'utf8')).toBe(before);
  });

  it('advertises no cross-request runtime continuation', async () => {
    const { body } = await apiFor(false).get(
      '/api/capabilities/commands/world.simulate',
    );
    const description = String((body as { description: string }).description);
    expect(description.toLowerCase()).toContain('stateless');
    expect(description.toLowerCase()).toContain('same response');

    // The in-process observation command is not reachable over HTTP, because an
    // HTTP request has no runtime of its own to observe.
    const refused = await apiFor(false).post(
      '/api/capabilities/commands/world.read_observations',
      { input: {} },
    );
    expect(refused.status).toBe(400);
    expect(JSON.stringify(refused.body)).toContain('world.simulate');
  });

  it('refuses invalid simulate input with structured issues', async () => {
    const api = apiFor(false);

    for (const input of [{ ticks: 0 }, { ticks: 10_001 }, { ticks: 1.5 }]) {
      const { status, body } = await api.post(
        '/api/capabilities/commands/world.simulate',
        { input },
      );
      expect(status).toBe(422);
      expect((body.issues as { path: string }[])[0]!.path).toBe('/ticks');
    }

    const badWorld = loadWorldFixture();
    badWorld.instances[1]!.intentSource = { kind: 'scripted-track', trackId: 'no-such-track' };
    const invalid = await api.post('/api/capabilities/commands/world.simulate', {
      input: { ticks: 10 },
      world: badWorld,
    });
    expect(invalid.status).toBe(422);
    expect(JSON.stringify(invalid.body)).toContain('unknown intent track');

    const response = await fetchRaw('/api/capabilities/commands/world.simulate', 'not json');
    expect(response.status).toBe(400);
  });

  it('bounds trace output', async () => {
    const api = apiFor(false);

    const plain = await api.post('/api/capabilities/commands/world.simulate', {
      input: { ticks: 60 },
    });
    expect((plain.body.output as { trace?: unknown }).trace).toBeUndefined();

    const off = await api.post('/api/capabilities/commands/world.simulate', {
      input: { ticks: 60, includeTrace: false },
    });
    expect((off.body.output as { trace?: unknown }).trace).toBeUndefined();

    const on = await api.post('/api/capabilities/commands/world.simulate', {
      input: { ticks: 60, includeTrace: true },
    });
    expect((on.body.output as { trace?: { tickCount: number } }).trace!.tickCount).toBe(60);

    const tooMany = await api.post('/api/capabilities/commands/world.simulate', {
      input: { ticks: 5000, includeTrace: true },
    });
    expect(tooMany.status).toBe(422);
    expect(JSON.stringify(tooMany.body)).toContain('trace is limited');
  });
});

/** A raw request, for the malformed-body case that `post` cannot express. */
async function fetchRaw(path: string, body: string) {
  const { app } = createApp({ runtime: createRepositoryRuntime() });
  return app.request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
}
