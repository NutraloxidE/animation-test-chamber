/**
 * The capability API over real handlers.
 *
 * The interesting cases are the read-only ones. Discovery and observation are
 * the tools an operator reaches for *because* something has gone wrong, so they
 * have to survive a repository that has gone read-only — while publication
 * stays refused by the same middleware.
 */
import { describe, expect, it } from 'vitest';
import { createApp } from '../../../apps/api/src/app.ts';
import { createRepositoryRuntime } from '../../../apps/api/src/runtime.ts';

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

    const previewed = await api.post('/api/capabilities/commands/world.preview', {
      input: { ticks: 5 },
    });
    expect(previewed.status).toBe(200);
    expect((previewed.body.output as { worldHash: string }).worldHash).toMatch(/^[0-9a-f]{8}$/);
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
