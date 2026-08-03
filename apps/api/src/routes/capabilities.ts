/**
 * Capability discovery and command execution.
 *
 * Discovery and observation are GET and stay available when the repository has
 * gone read-only — an agent must always be able to find out what it may do and
 * what the world currently looks like, especially when it may not write.
 *
 * Execution is POST and is deliberately limited to preview and staging: the
 * response carries a proposed `WorldDefinition`, and publishing it goes through
 * the existing validated save path. The command surface never touches the
 * filesystem, so there is no second way to write a project and no second place
 * for validation to be skipped.
 */
import { Hono } from 'hono';
import type { ProjectDefinition, WorldDefinition } from '@atc/schema';
import { worldOf } from '@atc/world-runtime';
import { createDefaultRegistry, type CommandContext } from '@atc/capability-runtime';
import {
  loadAssetRegistry as loadAssetRegistryFrom,
  loadProject as loadProjectFrom,
} from '../context.ts';
import { createRepositoryRuntime, type RepositoryRuntime } from '../runtime.ts';

/**
 * Commands that read a runtime the caller already holds.
 *
 * They stay registered — the browser and the in-process tests use them — but
 * they are not reachable over HTTP, because an HTTP request has no runtime to
 * observe and returning a tick-zero reading would be a lie with a 200 on it.
 */
const IN_PROCESS_ONLY_COMMANDS = new Set(['world.read_observations']);

/** The JSON view of a command. `execute` is not serializable and never leaves. */
function describeCommand(command: {
  id: string;
  description: string;
  mutating: boolean;
  inputSchema: unknown;
  outputSchema: unknown;
}) {
  return {
    id: command.id,
    description: command.description,
    mutating: command.mutating,
    inputSchema: command.inputSchema,
    outputSchema: command.outputSchema,
  };
}

function describeCapability(capability: ReturnType<ReturnType<typeof createDefaultRegistry>['list']>[number]) {
  return {
    id: capability.id,
    version: capability.version,
    description: capability.description,
    schemaIds: capability.schemaIds,
    runtimeSystems: capability.runtimeSystems,
    authoringSurfaces: capability.authoringSurfaces,
    observations: capability.observations,
    fixtures: capability.fixtures,
    harnessStages: capability.harnessStages,
    commands: capability.commands.map(describeCommand),
  };
}

/**
 * Whether a request path names a command that only reads.
 *
 * The read-only middleware refuses every non-GET request, which is right for
 * publication and wrong for `world.simulate`: simulating runs a world in memory
 * and writes nothing, and a repository that has gone read-only is exactly when
 * an operator most needs to be able to look. Command inputs are JSON objects, so
 * these cannot reasonably be GETs; the exemption is narrowed to commands the
 * registry itself reports as non-mutating.
 */
export function isReadOnlyCommandRequest(method: string, path: string): boolean {
  const match = /^\/api\/capabilities\/commands\/([^/]+)$/.exec(path);
  if (!match || method.toUpperCase() !== 'POST') return false;
  const command = createDefaultRegistry().command(decodeURIComponent(match[1]!));
  return command !== undefined && !command.mutating;
}

export function capabilityRoutes(
  runtime: RepositoryRuntime = createRepositoryRuntime(),
): Hono {
  const app = new Hono();
  const registry = createDefaultRegistry();
  const loadProject = (): ProjectDefinition => loadProjectFrom(runtime.repoRoot);

  app.get('/api/capabilities', (c) =>
    c.json({
      capabilities: registry.list().map((capability) => ({
        id: capability.id,
        version: capability.version,
        description: capability.description,
        commandCount: capability.commands.length,
      })),
      // Honest about the mode the caller is in, so a refusal later is not a
      // surprise it has to reverse-engineer from a 503.
      readOnly: runtime.health.readOnly,
    }),
  );

  app.get('/api/capabilities/commands', (c) =>
    c.json({ commands: registry.commands().map(describeCommand) }),
  );

  app.get('/api/capabilities/commands/:commandId', (c) => {
    const command = registry.command(c.req.param('commandId'));
    if (!command) return c.json({ error: 'unknown command' }, 404);
    return c.json(describeCommand(command));
  });

  // Registered after the `/commands` routes on purpose: a `:capabilityId`
  // wildcard declared first would swallow `/api/capabilities/commands`.
  app.get('/api/capabilities/:capabilityId', (c) => {
    const capability = registry.get(c.req.param('capabilityId'));
    if (!capability) return c.json({ error: 'unknown capability' }, 404);
    return c.json(describeCapability(capability));
  });

  /**
   * Executes one command.
   *
   * `world` may be supplied by the caller so a chain of staged edits can be
   * previewed without publishing any of them. When it is absent the canonical
   * (or synthesized) world is used.
   */
  app.post('/api/capabilities/commands/:commandId', async (c) => {
    const commandId = c.req.param('commandId');
    const command = registry.command(commandId);
    if (!command) return c.json({ error: 'unknown command' }, 404);

    if (IN_PROCESS_ONLY_COMMANDS.has(commandId)) {
      return c.json(
        {
          ok: false,
          issues: [
            {
              path: '/',
              message: `"${commandId}" observes a runtime the caller already owns, which an HTTP request does not have. Use world.simulate, which returns its observations in the same response.`,
              keyword: 'stateless',
            },
          ],
        },
        400,
      );
    }

    let body: { input?: unknown; world?: WorldDefinition; ticks?: number };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ ok: false, issues: [{ path: '/', message: 'body must be JSON', keyword: 'parse' }] }, 400);
    }

    const project = loadProject();
    const world = body.world ?? worldOf(project);

    /*
     * No `runtime` is attached. Each HTTP request is standalone: there is no
     * previous request whose runtime this one could observe, and pretending
     * otherwise is exactly the bug `world.simulate` replaced. Commands that
     * need to run a world build one from `registry` and discard it.
     */
    const context: CommandContext = {
      project,
      world,
      registry: loadAssetRegistryFrom(runtime.repoRoot),
      // The API is not authenticated, so a caller reaching it is treated as the
      // actor with the fewest privileges rather than the most.
      actor: 'ai',
    };

    const result = registry.execute(commandId, body.input ?? {}, context);
    return c.json(result, result.ok ? 200 : 422);
  });

  return app;
}
