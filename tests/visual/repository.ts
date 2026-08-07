import { cpSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

/**
 * The repository the API under test is reading and writing.
 *
 * A visual test that asserts on canonical files has to look at the same
 * checkout the server does, and since `pnpm harness:visual` points the API at a
 * disposable root, "the same checkout" is no longer a constant. Resolving it
 * from the spec file's own location — which is what these tests did — reads the
 * developer's project while the server writes somewhere else entirely, and the
 * assertion then fails for a reason that has nothing to do with what it tests.
 *
 * Falls back to the source checkout so `npx playwright test` still works
 * standalone. That run *does* write to your working tree; the wrapper exists
 * precisely so the gate does not.
 */
export const REPOSITORY_ROOT =
  process.env.ATC_REPO_ROOT ?? fileURLToPath(new URL('../..', import.meta.url));

/** True when this run is against a disposable checkout. */
export const REPOSITORY_IS_DISPOSABLE = process.env.ATC_REPO_ROOT !== undefined;

export const PROJECT_PATH = join(REPOSITORY_ROOT, 'projects/demo-character/project.json');

/** The pristine seed, always the source checkout's copy. */
const SEED_PROJECT_PATH = fileURLToPath(
  new URL('../../projects/demo-character/project.json', import.meta.url),
);

/**
 * Returns the disposable repository to the state the browser expects.
 *
 * Needed because of a coupling that only became visible once the two stopped
 * being the same directory. The web app seeds its `canonicalProject` from a
 * compile-time import of the *source* `project.json`, and while the API wrote
 * to that same file, Vite's watcher noticed and reloaded the page — so the
 * browser silently re-synced after every write, and nobody had to think about
 * it.
 *
 * Pointed at a disposable checkout, that resync is gone: the API's repository
 * moves forward and the browser keeps seeding from the pristine source, so the
 * *second* write in any suite is refused as a stale-revision conflict. Which is
 * the server being right — the baseline really had moved.
 *
 * Restoring the seed between tests makes each one start from the state its page
 * load assumes. It is also strictly more deterministic than what came before,
 * which depended on a dev-server reload landing in time.
 *
 * A no-op outside the wrapper, where the two paths are the same file.
 */
export function resetRepositoryProject(): void {
  if (!REPOSITORY_IS_DISPOSABLE) return;
  cpSync(SEED_PROJECT_PATH, PROJECT_PATH);
  // Apply reports and transaction journals from a previous test are not just
  // clutter: an unresolved transaction directory makes the next write refuse.
  for (const entry of ['reports/apply', '.chamber-transactions']) {
    rmSync(join(REPOSITORY_ROOT, entry), { recursive: true, force: true });
  }
}
