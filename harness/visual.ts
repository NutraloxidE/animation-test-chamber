/**
 * `pnpm harness:visual` — the visual suite, against a disposable repository.
 *
 * The visual tests drive the real browser through the real API, which means
 * they perform real writes. Pointed at the developer's checkout — which is what
 * `npx playwright test` did — those writes landed on
 * `projects/demo-character/project.json`, and the deterministic replay and
 * animation-asset harnesses stayed red afterwards until someone remembered to
 * restore the file by hand.
 *
 * That is not a flaky test, it is a suite that cannot be run twice. It could
 * never be part of a one-shot gate, and "remember to `git checkout` the project
 * afterwards" is not a property anything can depend on.
 *
 * So: build a throwaway checkout, copy the canonical inputs into it, start the
 * API bound to *that* root, run Playwright against it, and prove the source
 * checkout did not move. Nothing is mocked. The production code path, the
 * transaction engine and the file writes are all real — they simply happen
 * somewhere disposable.
 */
import { createServer } from 'node:net';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO_ROOT } from './lib.ts';

/**
 * Everything the API reads from a repository root.
 *
 * Copied rather than symlinked: a symlinked tree would let a write follow the
 * link back into the source checkout, which is the one outcome this whole file
 * exists to prevent.
 */
const SEEDED_PATHS = [
  'projects',
  'assets',
  'generated',
  'presets',
  'schemas',
  // Not read by the API, but it is what `findRepoRoot` looks for. Present so a
  // fallback that ignored ATC_REPO_ROOT would still land inside the temp root
  // rather than walking up into the real checkout.
  'pnpm-workspace.yaml',
];

/**
 * Paths whose modification means the run leaked.
 *
 * The canonical project is the one the visual Apply tests actually write. The
 * others are here because they are what a leak *damages*: the replay baselines
 * and the generated inputs are exactly what went red last time, and naming them
 * turns "the suite seems to have broken replay again" into a named failure at
 * the moment it happens.
 */
const CLEAN_TREE_PATHS = [
  'projects/demo-character/project.json',
  'assets',
  'generated',
  'tests/fixtures/animation-assets/legacy-replay-traces.json',
];

/** An OS-assigned free port, so a run never collides with a developer's server. */
async function freePort(): Promise<number> {
  return new Promise((resolveP, rejectP) => {
    const server = createServer();
    server.on('error', rejectP);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (typeof address === 'string' || address === null) {
        server.close(() => rejectP(new Error('could not obtain a free port')));
        return;
      }
      const { port } = address;
      server.close(() => resolveP(port));
    });
  });
}

function seedRepository(): string {
  const root = mkdtempSync(join(tmpdir(), 'atc-visual-'));
  for (const entry of SEEDED_PATHS) {
    const source = resolve(REPO_ROOT, entry);
    if (!existsSync(source)) continue;
    cpSync(source, join(root, entry), { recursive: true });
  }
  // The Apply path writes reports here. Created up front so a failure to write
  // one is a real failure rather than a missing directory.
  mkdirSync(join(root, 'reports/apply'), { recursive: true });
  return root;
}

/** Paths under the source checkout that git reports as modified. */
function dirtyPaths(paths: string[]): string[] {
  const result = spawnSync('git', ['status', '--porcelain', '--', ...paths], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  if (result.status !== 0) return [];
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * Apply reports and transaction directories that a leaked write would leave in
 * the source checkout.
 *
 * Checked separately from `git status` because both are gitignored, so a leak
 * into them is invisible to a clean-tree check — and a `.chamber-transactions`
 * directory left in the real checkout makes the *next* API process start
 * read-only.
 */
function strayArtifacts(): string[] {
  const stray: string[] = [];
  const transactions = resolve(REPO_ROOT, '.chamber-transactions');
  if (existsSync(transactions)) stray.push('.chamber-transactions/');
  return stray;
}

async function main(): Promise<void> {
  const passthrough = process.argv.slice(2);

  const before = dirtyPaths(CLEAN_TREE_PATHS);
  const strayBefore = strayArtifacts();

  const root = seedRepository();
  const apiPort = await freePort();
  const webPort = await freePort();

  console.log(`[visual] disposable repository: ${root}`);
  console.log(`[visual] api :${apiPort}  web :${webPort}`);

  const result = spawnSync(
    'npx',
    ['playwright', 'test', '--reporter=line', ...passthrough],
    {
      cwd: REPO_ROOT,
      stdio: 'inherit',
      shell: process.platform === 'win32',
      env: {
        ...process.env,
        ATC_REPO_ROOT: root,
        ATC_VISUAL_ISOLATED: '1',
        API_PORT: String(apiPort),
        WEB_PORT: String(webPort),
      },
    },
  );

  const after = dirtyPaths(CLEAN_TREE_PATHS);
  const strayAfter = strayArtifacts();

  /*
   * Compared against the state before the run rather than against "clean", so
   * running the visual suite on a branch with legitimate local edits reports
   * what *this run* changed instead of blaming it for work already in progress.
   */
  const leaked = after.filter((entry) => !before.includes(entry));
  const strayLeaked = strayAfter.filter((entry) => !strayBefore.includes(entry));
  const clean = leaked.length === 0 && strayLeaked.length === 0;

  if (!clean) {
    console.error('\n[visual] FAILED: the run modified the source checkout.');
    for (const entry of leaked) console.error(`  ${entry}`);
    for (const entry of strayLeaked) console.error(`  ${entry} (untracked artifact)`);
    console.error(
      '\nThe visual suite must write only into its disposable repository root. ' +
        'A path here means something resolved the real checkout instead of ATC_REPO_ROOT.',
    );
    console.error(`[visual] the disposable repository was kept for inspection: ${root}`);
    process.exit(1);
  }

  if (result.status === 0) {
    rmSync(root, { recursive: true, force: true });
    console.log('[visual] source checkout unchanged; disposable repository removed.');
  } else {
    // Kept on failure: the temp project and its Apply reports are usually the
    // only record of what the browser actually wrote.
    console.error(`[visual] tests failed; disposable repository kept at ${root}`);
  }

  process.exit(result.status ?? 1);
}

void main();
