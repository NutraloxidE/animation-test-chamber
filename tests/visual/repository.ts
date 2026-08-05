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
