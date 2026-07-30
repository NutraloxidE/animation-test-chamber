/**
 * Backend detection.
 *
 * The chamber is served two ways. Locally (`pnpm dev`) the Hono API in
 * apps/api sits behind the Vite proxy and everything is available. On a static
 * host such as Vercel there is no server at all: the build is just index.html,
 * the bundle and the asset tree.
 *
 * Rather than compiling two different bundles, the API is probed once at
 * startup. Features that need a server ask `backendAvailable()` and either use
 * it or fall back to a browser-local implementation — and where no fallback is
 * possible (git, disk writes), they say so plainly instead of surfacing a
 * "failed to fetch" that reads like a bug.
 */

/** Shown wherever a feature cannot work without the API server. */
export const NO_BACKEND_MESSAGE =
  "Not available in this static deployment — it needs the local API server (`pnpm dev`).";

let probe: Promise<boolean> | null = null;
let resolved: boolean | null = null;

async function probeBackend(): Promise<boolean> {
  try {
    const response = await fetch("/api/health", {
      headers: { accept: "application/json" },
    });
    if (!response.ok) return false;
    // A static host answers unknown paths with the SPA shell or a 404 page, so
    // a 200 alone proves nothing — the payload has to be the health document.
    const payload = (await response.json()) as { ok?: boolean };
    return payload.ok === true;
  } catch {
    return false;
  }
}

/** Resolves once per page load; the result is cached for later callers. */
export function backendAvailable(): Promise<boolean> {
  probe ??= probeBackend().then((available) => {
    resolved = available;
    return available;
  });
  return probe;
}

/**
 * The last probe result, or null while it is still in flight. For rendering
 * only — anything that acts on the answer should await `backendAvailable()`.
 */
export function backendState(): boolean | null {
  return resolved;
}
