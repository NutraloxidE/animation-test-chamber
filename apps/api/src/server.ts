/**
 * Process entry point: build the app, bind the port. Everything that decides
 * what the API *does* lives in `app.ts`, which can be constructed without
 * listening — including in a test that needs two of them.
 */
import { serve } from '@hono/node-server';
import { createApp } from './app.ts';

/**
 * Resolve any repository transaction a previous process crashed in the middle
 * of, before this one accepts a single write (PLAN Part I §9): that happens
 * inside `createRepositoryRuntime`, which `createApp` calls. If a transaction
 * could not be fully rolled back, this process starts read-only rather than
 * risking a second write landing on top of an already-inconsistent repository.
 */
const { app, context } = createApp();

const port = Number(process.env.API_PORT ?? 8787);

// Bound to loopback: the server mints GitHub installation tokens and must not be
// reachable from the network.
serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, (info) => {
  console.log(`[api] listening on http://127.0.0.1:${info.port}`);
  console.log(
    `[api] git adapter: ${context.git.kind}${context.gitConfigured ? '' : ' (no GitHub App configured)'}`,
  );
  console.log(`[api] ai provider: ${context.ai.id}`);
  console.log(`[api] animation worker: ${context.worker.available ? 'available' : 'unavailable'}`);
});

export { app };
