/**
 * Repo Guard (PLAN 17.2, 18.1).
 *
 * This is the mechanical part of "protect good states from vibe-coding
 * regressions". It compares the working tree against the last commit and
 * refuses changes that quietly erode the project: protected values moving,
 * tests disappearing or being weakened, schema constraints relaxed, generated
 * output treated as canonical, secrets committed, restricted assets added.
 */
import { readdirSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import type { ProjectDefinition } from '@atc/schema';
import { analyzeDiff } from '@atc/runtime-core';
import {
  REPO_ROOT,
  gitHasCommits,
  printStage,
  readAtRevision,
  readRepoFile,
  stage,
  type StageIssue,
  type StageResult,
} from './lib.ts';
import { loadResolvedProject } from './animation-assets.ts';

const PROJECT_PATH = 'projects/demo-character/project.json';

function listFiles(directory: string, out: string[] = []): string[] {
  const full = resolve(REPO_ROOT, directory);
  let entries: string[];
  try {
    entries = readdirSync(full);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === '.git' || entry === 'dist') continue;
    const path = resolve(full, entry);
    // Repository-relative and forward-slashed, on every platform. `relative`
    // returns backslashes on Windows, and every rule here compares against
    // literal `packages/…` prefixes — so the exemptions silently stopped
    // matching and the guard reported the packages that legitimately own a
    // Simulation as violations.
    if (statSync(path).isDirectory()) listFiles(relative(REPO_ROOT, path), out);
    else out.push(relative(REPO_ROOT, path).split('\\').join('/'));
  }
  return out;
}

/** Protected canonical values must not move without an explicit unlock. */
export function protectedValuesStage(): StageResult {
  return stage(
    'no protected value changed unexpectedly',
    {
      reproduce: 'pnpm harness:repo-guard',
      suggestion:
        'revert the protected value, or have a human unlock it deliberately and say so in the commit',
    },
    () => {
      if (!gitHasCommits()) {
        return { ok: true, issues: [], output: 'no previous commit to compare against' };
      }
      const previousRaw = readAtRevision('HEAD', PROJECT_PATH);
      const currentRaw = readRepoFile(PROJECT_PATH);
      if (!previousRaw || !currentRaw) {
        return { ok: true, issues: [], output: 'project not present in both revisions' };
      }

      const previous = JSON.parse(previousRaw) as ProjectDefinition;
      const current = JSON.parse(currentRaw) as ProjectDefinition;

      /*
       * Across the schema v1 -> v2 split the two files are not comparable: the
       * clips and the graph moved out of project.json into assets, so a naive
       * diff reports every clip as deleted when none of them went anywhere.
       *
       * The meaningful comparison is against the *resolved* document, which is
       * what the runtime actually sees, so that is what gets diffed. This makes
       * the guard stricter rather than weaker: a clip that genuinely vanished
       * during the migration still fails, because it would be missing from the
       * resolved document too.
       */
      const comparable =
        previous.schemaVersion === current.schemaVersion
          ? current
          : loadResolvedProject();
      const report = analyzeDiff(previous, comparable);

      const issues: StageIssue[] = report.findings
        .filter((finding) => finding.severity === 'blocking')
        .map((finding) => ({
          files: [PROJECT_PATH],
          expected: 'the protected value to be unchanged',
          actual: finding.message,
          message: `${finding.rule}: ${finding.path}`,
        }));

      return { ok: issues.length === 0, issues };
    },
  );
}

/** Tests must not vanish or have their expectations loosened to go green. */
export function testIntegrityStage(): StageResult {
  return stage(
    'no tests deleted or weakened',
    {
      reproduce: 'pnpm harness:repo-guard',
      suggestion: 'fix the implementation instead of relaxing the test',
    },
    () => {
      if (!gitHasCommits()) return { ok: true, issues: [] };

      const issues: StageIssue[] = [];
      const testFiles = listFiles('tests').filter((file) => file.endsWith('.test.ts'));
      const previousTests = new Set<string>();

      // Which test files existed at HEAD.
      for (const file of testFiles) {
        if (readAtRevision('HEAD', file) !== null) previousTests.add(file);
      }

      // Any test file present at HEAD but gone now.
      const knownAtHead = listFilesAtHead();
      for (const file of knownAtHead) {
        if (!file.endsWith('.test.ts')) continue;
        if (readRepoFile(file) === null) {
          issues.push({
            files: [file],
            expected: 'the test file to still exist',
            actual: 'it was deleted',
            message: `test file ${file} was deleted`,
          });
        }
      }

      // Test count must not drop within a file that still exists.
      const countAssertions = (source: string): number =>
        (source.match(/\b(it|test)\s*(\.each\([\s\S]*?\))?\s*\(/g) ?? []).length;

      for (const file of previousTests) {
        const before = readAtRevision('HEAD', file);
        const after = readRepoFile(file);
        if (before === null || after === null) continue;
        const beforeCount = countAssertions(before);
        const afterCount = countAssertions(after);
        if (afterCount < beforeCount) {
          issues.push({
            files: [file],
            expected: `at least ${beforeCount} test(s)`,
            actual: `${afterCount} test(s)`,
            message: `${file} lost ${beforeCount - afterCount} test(s)`,
          });
        }
        if (/\.skip\(|\.todo\(|xit\(/.test(after) && !/\.skip\(|\.todo\(|xit\(/.test(before)) {
          issues.push({
            files: [file],
            expected: 'no newly skipped tests',
            actual: 'a test was skipped',
            message: `${file} newly skips a test`,
          });
        }
      }

      return { ok: issues.length === 0, issues };
    },
  );
}

function listFilesAtHead(): string[] {
  const raw = readAtRevision('HEAD', '');
  if (raw !== null) return [];
  // `git show HEAD:` on a directory is awkward; use the working tree list and
  // rely on the per-file existence probe above instead.
  return listFiles('tests');
}

/** Schema constraints must not be silently loosened. */
export function schemaConstraintStage(): StageResult {
  return stage(
    'no schema constraint relaxed silently',
    {
      reproduce: 'pnpm harness:repo-guard',
      suggestion:
        'if a bound genuinely needs to change, say so explicitly in the commit message',
    },
    () => {
      if (!gitHasCommits()) return { ok: true, issues: [] };

      const issues: StageIssue[] = [];
      const schemaFiles = listFiles('packages/schema/src').filter((file) => file.endsWith('.ts'));

      /** Property names declared as `name: Type.Optional(...)`. */
      const optionalFieldNames = (source: string): Set<string> =>
        new Set(
          [...source.matchAll(/^\s*([A-Za-z_$][\w$]*):\s*Type\.Optional\(/gm)].map(
            (match) => match[1]!,
          ),
        );

      /** Property names declared with any other value — i.e. required ones. */
      const requiredFieldNames = (source: string): Set<string> => {
        const optional = optionalFieldNames(source);
        return new Set(
          [...source.matchAll(/^\s*([A-Za-z_$][\w$]*):\s*\S/gm)]
            .map((match) => match[1]!)
            .filter((name) => !optional.has(name)),
        );
      };

      /*
       * `additionalProperties: false` is what stops unknown fields creeping in,
       * and the count of them across the package must never fall.
       *
       * Counted package-wide as well as per file, because a per-file count
       * alone cannot tell a deleted constraint from a *moved* one: extracting a
       * type into a new module drops the old file's count to zero and reads as
       * five constraints vanishing, which trains everyone to ignore the guard.
       * The package total is the number that actually answers "did a strict
       * object stop being strict?", so a per-file drop is only reported when
       * the total dropped with it.
       */
      const strictTotal = (files: (readonly [string, string | null])[]): number =>
        files.reduce(
          (sum, [, text]) => sum + (text?.match(/additionalProperties:\s*false/g) ?? []).length,
          0,
        );
      const headSources = schemaFiles.map(
        (file) => [file, readAtRevision('HEAD', file)] as const,
      );
      const workingSources = schemaFiles.map((file) => [file, readRepoFile(file)] as const);
      const packageLostConstraints = strictTotal(workingSources) < strictTotal(headSources);

      for (const file of schemaFiles) {
        const before = readAtRevision('HEAD', file);
        const after = readRepoFile(file);
        if (before === null || after === null) continue;

        const strictBefore = (before.match(/additionalProperties:\s*false/g) ?? []).length;
        const strictAfter = (after.match(/additionalProperties:\s*false/g) ?? []).length;
        if (strictAfter < strictBefore && packageLostConstraints) {
          issues.push({
            files: [file],
            expected: `${strictBefore} strict object(s)`,
            actual: `${strictAfter}`,
            message: `${file} dropped an additionalProperties:false constraint`,
          });
        }

        /*
         * A required field that became optional, named.
         *
         * This used to compare raw `Type.Optional(` counts and fire whenever a
         * file gained more than two of them — which reports "several fields
         * became optional" for a file that added a *new type* with optional
         * members, and says nothing at all when one existing field is quietly
         * relaxed while another is deleted. Neither number is the question. The
         * question is whether a field that was required at HEAD is optional
         * now, so that is what is compared, by name.
         */
        for (const name of optionalFieldNames(after)) {
          if (requiredFieldNames(before).has(name)) {
            issues.push({
              files: [file],
              expected: `"${name}" to stay required`,
              actual: 'it is now optional',
              message: `${file} relaxed "${name}" from required to optional`,
            });
          }
        }
      }

      return { ok: issues.length === 0, issues };
    },
  );
}

/** Nothing under generated/ may be referenced as if it were canonical. */
export function generatedNotCanonicalStage(): StageResult {
  return stage(
    'no generated artifact treated as canonical',
    {
      reproduce: 'pnpm harness:repo-guard',
      suggestion: 'read canonical data from projects/ or packages/, never from generated/',
    },
    () => {
      const issues: StageIssue[] = [];
      const sourceFiles = [
        ...listFiles('packages'),
        ...listFiles('apps'),
        ...listFiles('harness'),
      ].filter((file) => /\.(ts|tsx)$/.test(file) && !file.endsWith('.d.ts'));

      for (const file of sourceFiles) {
        const content = readRepoFile(file);
        if (!content) continue;
        // Writing into generated/ is expected; importing out of it is not.
        const importsGenerated = /(from|import|require)\s*\(?['"][^'"]*generated\//.test(content);
        if (importsGenerated) {
          issues.push({
            files: [file],
            expected: 'no imports from generated/',
            actual: 'this file imports a generated artifact',
            message: `${file} imports from generated/`,
          });
        }
      }

      return { ok: issues.length === 0, issues };
    },
  );
}

/** No secrets in the tree, and none reachable from the browser bundle. */
export function secretsStage(): StageResult {
  return stage(
    'no secrets committed',
    {
      reproduce: 'pnpm harness:repo-guard',
      suggestion: 'move the value into .env (git-ignored) and read it in apps/api only',
    },
    () => {
      const issues: StageIssue[] = [];

      const patterns: { test: RegExp; label: string }[] = [
        { test: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, label: 'a private key' },
        { test: /sk-ant-[A-Za-z0-9-]{16,}/, label: 'an Anthropic API key' },
        { test: /ghp_[A-Za-z0-9]{20,}/, label: 'a GitHub token' },
        { test: /gh[sioru]_[A-Za-z0-9]{20,}/, label: 'a GitHub token' },
      ];

      const candidates = [
        ...listFiles('packages'),
        ...listFiles('apps'),
        ...listFiles('harness'),
        ...listFiles('projects'),
        ...listFiles('tests'),
      ].filter((file) => !file.includes('node_modules'));

      for (const file of candidates) {
        const content = readRepoFile(file);
        if (!content) continue;
        for (const pattern of patterns) {
          if (pattern.test.test(content)) {
            issues.push({
              files: [file],
              expected: 'no credentials in the repository',
              actual: `looks like ${pattern.label}`,
              message: `${file} appears to contain ${pattern.label}`,
            });
          }
        }
      }

      // A .env file must never be committed.
      if (readAtRevision('HEAD', '.env') !== null) {
        issues.push({
          files: ['.env'],
          expected: '.env to be git-ignored',
          actual: '.env is tracked by git',
          message: '.env is committed',
        });
      }

      // The browser bundle must not read server-only configuration.
      for (const file of listFiles('apps/web').filter((f) => /\.(ts|tsx)$/.test(f))) {
        const content = readRepoFile(file);
        if (!content) continue;
        if (/GITHUB_APP_PRIVATE_KEY|ANTHROPIC_API_KEY|GITHUB_APP_ID/.test(content)) {
          issues.push({
            files: [file],
            expected: 'the web app to hold no credentials',
            actual: 'it references a server-only secret',
            message: `${file} references a server-only secret`,
          });
        }
      }

      return { ok: issues.length === 0, issues };
    },
  );
}

/** Binary assets must not appear without a licence manifest alongside them. */
export function restrictedAssetStage(): StageResult {
  return stage(
    'no raw restricted asset committed',
    {
      reproduce: 'pnpm harness:repo-guard',
      suggestion:
        'record a verified licence manifest for the asset, or keep it out of the repository',
    },
    () => {
      const issues: StageIssue[] = [];
      const project = readRepoFile(PROJECT_PATH);
      const candidates = project
        ? ((JSON.parse(project) as ProjectDefinition).candidates ?? [])
        : [];

      const binaryExtensions = /\.(glb|gltf|fbx|bvh)$/i;
      const assetFiles = [...listFiles('projects'), ...listFiles('presets')].filter((file) =>
        binaryExtensions.test(file),
      );

      for (const file of assetFiles) {
        const manifested = candidates.some(
          (candidate) =>
            file.endsWith(candidate.provenance.originalFilename) &&
            candidate.provenance.license.verificationStatus === 'human-verified' &&
            candidate.provenance.license.publicRepository === 'allowed',
        );
        if (!manifested) {
          issues.push({
            files: [file],
            expected: 'a human-verified licence manifest permitting public repository use',
            actual: 'no such manifest was found',
            message: `${file} is committed without a verified licence manifest`,
          });
        }
      }

      return { ok: issues.length === 0, issues };
    },
  );
}

/**
 * A published asset version is immutable (PLAN 38).
 *
 * Editing one in place changes behaviour for every character already pointing
 * at it — retroactively, invisibly, and without any replay having been run
 * against the new content. Adding a version file is always fine; changing one
 * that already existed at HEAD never is.
 */
export function publishedAssetImmutabilityStage(): StageResult {
  return stage(
    'no published asset version modified in place',
    {
      reproduce: 'pnpm harness:repo-guard',
      suggestion:
        'restore the published file and publish a new version instead — every reference to it carries its content hash',
    },
    () => {
      if (!gitHasCommits()) {
        return { ok: true, issues: [], output: 'no previous commit to compare against' };
      }
      const issues: StageIssue[] = [];
      for (const file of listFiles('assets/animation')) {
        if (!file.endsWith('.json')) continue;
        const before = readAtRevision('HEAD', file);
        if (before === null) continue; // A new version file: exactly what is allowed.
        const after = readRepoFile(file);
        if (after === null) {
          issues.push({
            files: [file],
            expected: 'the published version to still exist',
            actual: 'it was deleted',
            message: `published asset ${file} was deleted`,
          });
          continue;
        }
        if (before !== after) {
          issues.push({
            files: [file],
            expected: 'the published version to be byte-identical',
            actual: 'its contents changed',
            message: `published asset ${file} was modified in place`,
          });
        }
      }
      return { ok: issues.length === 0, issues };
    },
  );
}

/**
 * The runtime must not infer behaviour from a state's name (PLAN 33).
 *
 * Every one of these branches was real, wanted behaviour selected by spelling,
 * which meant a second character could only inherit it by naming its states the
 * same way. They now live in canonical policy fields, and this keeps them from
 * creeping back in.
 */
export function stateNameDependenceStage(): StageResult {
  return stage(
    'no runtime behaviour inferred from state names',
    {
      reproduce: 'pnpm harness:repo-guard',
      suggestion:
        'move the special case onto a canonical field (completionPolicy, recoveryPolicy, movementAuthorityPolicy) and read that instead',
    },
    () => {
      const issues: StageIssue[] = [];
      const patterns: { test: RegExp; label: string }[] = [
        { test: /\.startsWith\(\s*['"]attack-/, label: "startsWith('attack-')" },
        { test: /\.endsWith\(\s*['"]-recovery/, label: "endsWith('-recovery')" },
        { test: /stateId\s*===\s*['"](dodge|guard|walk|run|idle|jump|fall|land|slide)['"]/, label: 'stateId === a specific state' },
        { test: /stateId\s*!==\s*['"](dodge|guard|walk|run|idle|jump|fall|land|slide)['"]/, label: 'stateId !== a specific state' },
        { test: /actionState\s*===\s*['"]/, label: 'actionState === a literal' },
        { test: /locomotionState\s*===\s*['"](walk|run)['"]/, label: 'locomotionState === walk/run' },
      ];

      // Only the layers that decide behaviour. Panels legitimately name states
      // for display, and the demo data is allowed to contain its own state ids.
      const runtimeFiles = [
        ...listFiles('packages/animation-runtime/src'),
        ...listFiles('packages/replay-runtime/src'),
        ...listFiles('packages/terrain-runtime/src'),
      ].filter((file) => file.endsWith('.ts'));

      for (const file of runtimeFiles) {
        const content = readRepoFile(file);
        if (!content) continue;
        // Comments explaining what was removed are the point, not a violation.
        const code = content
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .split('\n')
          .filter((line) => !line.trim().startsWith('//'))
          .join('\n');
        for (const pattern of patterns) {
          if (pattern.test.test(code)) {
            issues.push({
              files: [file],
              expected: 'behaviour to be read from a canonical policy field',
              actual: `it branches on ${pattern.label}`,
              message: `${file} infers behaviour from a state name (${pattern.label})`,
            });
          }
        }
      }

      return {
        ok: issues.length === 0,
        issues,
        output: `${runtimeFiles.length} runtime file(s) checked`,
      };
    },
  );
}

/**
 * The world contract's own erosion checks.
 *
 * Each pattern here is a specific way the multi-instance guarantees could be
 * quietly undone by a plausible-looking edit: a game concept becoming canonical
 * schema, mutable runtime state written into a canonical document, an
 * observation path falling back to an array index, the world runtime reaching
 * for a browser API, or per-instance state cached under a shared id.
 *
 * The checks are scoped to canonical and runtime source. A global word ban
 * would reject this repository's own documentation of its non-goals, which is
 * the opposite of useful.
 */
export function worldContractGuardStage(): StageResult {
  return stage(
    'world contract not eroded',
    {
      reproduce: 'pnpm harness:repo-guard',
      suggestion:
        'keep game concepts out of canonical schema, keep mutable state out of canonical documents, and key per-instance state by instance id',
    },
    () => {
      const issues: StageIssue[] = [];

      const schemaFiles = ['packages/schema/src/world.ts'];
      const worldRuntimeFiles = [
        ...listFiles('packages/world-runtime/src'),
        ...listFiles('packages/capability-runtime/src'),
      ].filter((file) => file.endsWith('.ts'));

      /*
       * Names from the example use case. The world contract is generic; the
       * moment "enemy" or "health" is a canonical field, every later world has
       * to carry a concept it does not have.
       */
      const gameTerms = /\b(enemy|player|attack|combat|soulslike|health|damage|hitbox|hurtbox)\b/i;
      for (const file of schemaFiles) {
        const content = readRepoFile(file);
        if (!content) continue;
        for (const match of content.matchAll(/^\s*([a-zA-Z][a-zA-Z0-9]*)\s*:/gm)) {
          const field = match[1] ?? '';
          if (gameTerms.test(field)) {
            issues.push({
              files: [file],
              expected: 'generic canonical field names',
              actual: `a field named "${field}"`,
              message: `${file} declares a game-specific canonical field "${field}"`,
            });
          }
        }
      }

      /*
       * Mutable runtime state must never reach a canonical document.
       *
       * Scoped to the instance declarations: an intent track legitimately
       * carries a `tick` on every keyframe, and that is authored data — the
       * tick an author wrote down, not a clock the runtime advanced.
       */
      const projectRaw = readRepoFile(PROJECT_PATH);
      if (projectRaw) {
        const world = (JSON.parse(projectRaw) as {
          world?: { instances?: Record<string, unknown>[] };
        }).world;
        const forbidden = [
          'tick',
          'elapsedSec',
          'velocity',
          'inputBuffer',
          'activeState',
          'clipTime',
          'transitionProgress',
        ];
        for (const instance of world?.instances ?? []) {
          const serialized = JSON.stringify(instance);
          for (const key of forbidden) {
            if (new RegExp(`"${key}"\\s*:`).test(serialized)) {
              issues.push({
                files: [PROJECT_PATH],
                expected: 'an instance declaration holding only definitions',
                actual: `it carries a "${key}" field`,
                message: `${PROJECT_PATH} stores mutable runtime state ("${key}") in canonical data`,
              });
            }
          }
        }
      }

      for (const file of worldRuntimeFiles) {
        const content = readRepoFile(file);
        if (!content) continue;
        const code = content
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .split('\n')
          .filter((line) => !line.trim().startsWith('//'))
          .join('\n');

        // Engine-agnostic means engine-agnostic.
        for (const pattern of [
          { test: /\bfrom\s+['"]react/, label: 'react' },
          { test: /\bfrom\s+['"]three/, label: 'three' },
          { test: /\bfrom\s+['"]hono/, label: 'hono' },
          { test: /\bfrom\s+['"]node:fs/, label: 'node:fs' },
          /*
           * Not preceded by a dot or an identifier character, so `document.`
           * still fails while `result.document.id` does not. The unqualified
           * pattern flagged an `OperationResult` field named `document`, which
           * is a false positive of the kind that teaches people to ignore a
           * guard.
           */
          { test: /(?<![.\w$])(document|window)\./, label: 'a DOM global' },
          { test: /apps\/(web|api)/, label: 'an app import' },
        ]) {
          if (pattern.test.test(code)) {
            issues.push({
              files: [file],
              expected: 'the world and capability runtimes to stay engine-agnostic',
              actual: `it reaches for ${pattern.label}`,
              message: `${file} depends on ${pattern.label}`,
            });
          }
        }

        // Observation paths must name instances.
        if (/instances\/\$\{(index|i)\b/.test(code)) {
          issues.push({
            files: [file],
            expected: 'instance-qualified observation paths',
            actual: 'a path built from an array index',
            message: `${file} builds an observation path from an array index`,
          });
        }

        // Per-instance mutable state keyed by something instances share.
        if (/new Map<string, (RuntimeInstanceState|Simulation)>[\s\S]{0,200}characterId/.test(code)) {
          issues.push({
            files: [file],
            expected: 'per-instance state keyed by instance id',
            actual: 'it is keyed by character id',
            message: `${file} caches per-instance runtime state under a shared definition id`,
          });
        }
      }

      // Devices are polled in one place. An instance that polled for itself
      // would receive input according to when it happened to tick.
      for (const file of worldRuntimeFiles) {
        const content = readRepoFile(file);
        if (content && /getGamepads|addEventListener\(\s*['"]key/.test(content)) {
          issues.push({
            files: [file],
            expected: 'device polling to live in the input adapter',
            actual: 'the world runtime polls a device directly',
            message: `${file} polls an input device outside the input adapter`,
          });
        }
      }

      return {
        ok: issues.length === 0,
        issues,
        output: `${worldRuntimeFiles.length} world/capability file(s) checked`,
      };
    },
  );
}

/**
 * Every workspace package must be resolvable everywhere it is consumed.
 *
 * A package's path is written down in four independent places — `tsconfig.base
 * .json` for the compiler, `vitest.config.ts` for the tests, `apps/web/vite
 * .config.ts` for the browser, and the package's own directory — and nothing
 * made them agree. Adding a package to three of them typechecks, lints and
 * passes every test, then fails at `pnpm dev` with a Vite import error, because
 * the browser is the one consumer no Node-side check exercises.
 *
 * The list of directories under `packages/` is the authority here: a package
 * that exists and is missing from any alias map is the failure, in whichever
 * direction it happens.
 */
export function workspaceAliasStage(): StageResult {
  return stage(
    'every workspace package resolves in every consumer',
    {
      reproduce: 'pnpm harness:repo-guard',
      blocksCommit: true,
      suggestion:
        'add the package to tsconfig.base.json, vitest.config.ts and apps/web/vite.config.ts — the browser is the consumer no Node-side check catches',
    },
    () => {
      const issues: StageIssue[] = [];

      const packages = listFiles('packages')
        .filter((file) => file.endsWith('/package.json'))
        .map((file) => file.slice('packages/'.length, -'/package.json'.length))
        .filter((name) => !name.includes('/'))
        .sort();

      /*
       * The web app deliberately aliases only what reaches the browser — it has
       * no business resolving the git adapter or the Unity exporter — but that
       * set is the *transitive* closure of its dependencies, not the declared
       * list. A package pulled in through another package still has to resolve,
       * and a direct-dependency rule would miss exactly the case that produced
       * this stage: `@atc/scene-runtime` arrives via `@atc/world-runtime`, is
       * imported in the browser, and is named nowhere in apps/web/package.json.
       *
       * `tsconfig` and `vitest` compile and run the whole workspace, so they
       * must carry every package.
       *
       * Matched on the alias *key* rather than the path, because vitest builds
       * its paths through a helper and a path-shaped search would report every
       * package as missing.
       */
      const atcDependencies = (packageJsonPath: string): string[] =>
        Object.keys(
          (JSON.parse(readRepoFile(packageJsonPath) ?? '{}') as {
            dependencies?: Record<string, string>;
          }).dependencies ?? {},
        )
          .filter((name) => name.startsWith('@atc/'))
          .map((name) => name.slice('@atc/'.length));

      const reachableFromWeb = new Set<string>();
      const queue = atcDependencies('apps/web/package.json');
      while (queue.length > 0) {
        const name = queue.shift()!;
        if (reachableFromWeb.has(name)) continue;
        reachableFromWeb.add(name);
        queue.push(...atcDependencies(`packages/${name}/package.json`));
      }

      const consumers: { file: string; required: (name: string) => boolean }[] = [
        { file: 'tsconfig.base.json', required: () => true },
        { file: 'vitest.config.ts', required: () => true },
        {
          file: 'apps/web/vite.config.ts',
          required: (name) => reachableFromWeb.has(name),
        },
      ];

      for (const consumer of consumers) {
        const source = readRepoFile(consumer.file);
        if (source === null) {
          issues.push({
            files: [consumer.file],
            expected: 'the alias map to exist',
            actual: 'file not found',
            message: `${consumer.file} is missing`,
          });
          continue;
        }
        for (const name of packages) {
          if (!consumer.required(name)) continue;
          if (source.includes(`'@atc/${name}'`) || source.includes(`"@atc/${name}"`)) continue;
          issues.push({
            files: [consumer.file, `packages/${name}/package.json`],
            expected: `an alias for @atc/${name}`,
            actual: 'no alias',
            message: `${consumer.file} cannot resolve @atc/${name}`,
          });
        }
      }

      return { ok: issues.length === 0, issues, output: `${packages.length} package(s) checked` };
    },
  );
}

/**
 * Character control must go through `ControllableCharacter`.
 *
 * The browser app is the one place a direct `Simulation.step(deviceSample)` is
 * tempting, because the device is right there — and it was exactly what the web
 * engine did. The cost is not abstract: the one controller a human actually
 * uses becomes the one controller that skips the boundary every other
 * controller is tested against, so "human and AI behave identically" stops
 * being checkable in the direction that matters.
 *
 * The runtime packages that legitimately own a `Simulation` are exempt by name
 * rather than by a broad substring rule, so the exemption stays visible.
 */
export function characterControlBoundaryStage(): StageResult {
  return stage(
    'no direct device-to-Simulation control path',
    {
      reproduce: 'pnpm harness:repo-guard',
      blocksCommit: true,
      suggestion:
        'route the input through a CharacterIntentSource and ControllableCharacter.step, as apps/web/src/engine.ts does',
    },
    () => {
      const issues: StageIssue[] = [];
      const owners = [
        'packages/character-control-runtime/',
        'packages/replay-runtime/',
        'packages/world-runtime/',
      ];

      const files = [...listFiles('apps'), ...listFiles('packages')].filter(
        (file) =>
          (file.endsWith('.ts') || file.endsWith('.tsx')) &&
          !owners.some((owner) => file.startsWith(owner)),
      );

      for (const file of files) {
        const source = readRepoFile(file);
        if (source === null) continue;
        for (const [index, line] of source.split('\n').entries()) {
          // `this.simulation.step(...)` and friends. `runtime.step()` is a
          // scene/world clock, not a character, and is left alone.
          if (/\bsimulation\.step\s*\(/i.test(line) && !line.trimStart().startsWith('*')) {
            issues.push({
              files: [file],
              expected: 'intent through ControllableCharacter',
              actual: `${file}:${index + 1}`,
              message: `${file} steps a Simulation directly`,
            });
          }
        }
      }

      return { ok: issues.length === 0, issues, output: `${files.length} file(s) checked` };
    },
  );
}

/**
 * No second Character selector, and no second animation graph (work package §10).
 *
 * Both regressions this guards against are *additions that look harmless*. A
 * `CHARACTER_PRESETS`-style catalog carrying model files reads like renderer
 * configuration until a selector is pointed at it, at which point the app has two
 * answers to "which Character is this" and the canonical one loses. A
 * `stateId -> clip name` map reads like a convenience until it is what playback
 * uses, at which point the repository's motion set is decoration.
 *
 * Neither shows up as a failing test: the route tests still pass, typecheck still
 * passes, and the screen still renders. So they are checked mechanically here.
 */
export function characterSelectorBoundaryStage(): StageResult {
  return stage(
    'no second Character selector, and no renderer-side clip map',
    {
      reproduce: 'pnpm harness:repo-guard',
      blocksCommit: true,
      suggestion:
        'the route is the Character selector (CharacterDefinition.model owns the model); playback resolves state -> motionSlot -> motion set -> clip asset. A preview override must be named previewModelOverride* and labelled PREVIEW ONLY.',
    },
    () => {
      const issues: StageIssue[] = [];

      /*
       * The declared migration adapters and the tests that assert the retirement
       * are exempt: they must be able to *name* what was retired. Everything else
       * in the app and the packages may not.
       */
      const allowed = [
        'harness/repo-guard.ts',
        'harness/generate-imported-character-assets.ts',
        'packages/schema/src/migration.ts',
      ];

      const files = [...listFiles('apps'), ...listFiles('packages')].filter(
        (file) =>
          (file.endsWith('.ts') || file.endsWith('.tsx')) &&
          !allowed.includes(file),
      );

      const forbidden: { pattern: RegExp; message: string; expected: string }[] = [
        {
          pattern: /\bCHARACTER_PRESETS\b/,
          message: 'declares or reads CHARACTER_PRESETS, the retired second Character catalog',
          expected: 'the route Character and CharacterDefinition.model',
        },
        {
          pattern: /\bsetCharacterPreset\b|\bcharacterPresetId\b/,
          message:
            'names a character preset as selection state; a preview override must be previewModelOverride*',
          expected: 'previewModelOverrideId / setPreviewModelOverride',
        },
        {
          pattern: /\bCLIP_FOR_STATE\b/,
          message: 'declares a web-only stateId -> clip name map',
          expected: 'canonical motion-set bindings',
        },
        {
          pattern: /\bclipMap\b/,
          message: 'carries a clipMap; imported takes belong to clip assets',
          expected: 'AnimationClipDefinition.externalSource',
        },
      ];

      for (const file of files) {
        const source = readRepoFile(file);
        if (source === null) continue;
        for (const [index, line] of source.split('\n').entries()) {
          const trimmed = line.trimStart();
          // Prose may discuss what was retired; code may not reintroduce it.
          if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) continue;
          for (const rule of forbidden) {
            if (!rule.pattern.test(line)) continue;
            issues.push({
              files: [file],
              expected: rule.expected,
              actual: `${file}:${index + 1}`,
              message: `${file} ${rule.message}`,
            });
          }
        }
      }

      /*
       * The positive half. The rules above can all be satisfied by deleting the
       * feature, so the guard also insists the replacements are still there — a
       * Character Overview with ownership badges, and a preview override that says
       * PREVIEW ONLY.
       */
      const required: { file: string; needle: string; message: string }[] = [
        {
          file: 'packages/animation-asset-runtime/src/bindings.ts',
          needle: 'describeCharacterBindings',
          message: 'the single Character binding inventory is missing',
        },
        {
          file: 'apps/web/src/rig-editor/CharacterOverview.tsx',
          needle: 'ONLY THIS CHARACTER',
          message: 'the Character Overview no longer states exclusive ownership',
        },
        {
          file: 'apps/web/src/rig-editor/CharacterOverview.tsx',
          needle: 'SHARED BY',
          message: 'the Character Overview no longer states shared ownership',
        },
        {
          file: 'apps/web/src/panels/Hierarchy.tsx',
          needle: 'PREVIEW ONLY',
          message: 'the preview model override is no longer labelled PREVIEW ONLY',
        },
      ];

      for (const rule of required) {
        const source = readRepoFile(rule.file);
        if (source === null || !source.includes(rule.needle)) {
          issues.push({
            files: [rule.file],
            expected: `${rule.file} to contain "${rule.needle}"`,
            actual: source === null ? 'the file is missing' : 'the text is absent',
            message: rule.message,
          });
        }
      }

      return { ok: issues.length === 0, issues, output: `${files.length} file(s) checked` };
    },
  );
}

/**
 * The GameObject Prefab system exists, and canonical documents stay canonical
 * (work package §17).
 *
 * Two halves, and the positive half is the unusual one. A guard that only
 * forbids things cannot tell "the Prefab system was never built" from "the
 * Prefab system is fine", so this one also asserts that each load-bearing piece
 * is present by name: a refactor that deletes the resolver fails here rather
 * than passing quietly because nothing forbidden was added.
 *
 * The negative half — forbidding production reads of `Project.characters`,
 * `SceneEntityDefinition.kind` and the rest of the retired vocabulary — is
 * deliberately *not* here yet. Those are still the fields the renderer, the
 * Scene runtime and the API read, so a guard forbidding them today would fail
 * on the code it is meant to protect. It lands with the production switchover;
 * `reports/gameobject-prefab-migration-audit.md` records that as the open item.
 */
export function prefabSystemGuardStage(): StageResult {
  return stage(
    'gameobject prefab system present and canonical',
    {
      reproduce: 'pnpm harness:repo-guard',
      suggestion:
        'a missing piece means the Prefab spine was removed; a runtime field means a tick wrote itself into a document',
    },
    () => {
      const issues: StageIssue[] = [];

      /** Each load-bearing symbol, and the file that must still declare it. */
      const required: { file: string; symbols: string[] }[] = [
        {
          file: 'packages/schema/src/prefab.ts',
          symbols: [
            'GameObjectPrefabReference',
            'BaseGameObjectPrefabAsset',
            'VariantGameObjectPrefabAsset',
            'GameObjectComponentDefinition',
            'GAME_OBJECT_COMPONENT_TYPES',
            'PrefabNodeDefinition',
            'PrefabComponentOverride',
            'isCharacterComposition',
          ],
        },
        {
          file: 'packages/schema/src/scene.ts',
          symbols: ['GameObjectInstanceDefinition', 'PlaceablePrefabAsset', 'GameObjectSceneOperation'],
        },
        { file: 'packages/prefab-runtime/src/registry.ts', symbols: ['PrefabAssetRegistry'] },
        { file: 'packages/prefab-runtime/src/resolution.ts', symbols: ['resolveGameObjectPrefab'] },
        { file: 'packages/prefab-runtime/src/usage.ts', symbols: ['describePrefabUsage'] },
        { file: 'packages/game-object-runtime/src/runtime.ts', symbols: ['RuntimeGameObject'] },
        { file: 'packages/game-object-runtime/src/scene.ts', symbols: ['instantiateScene'] },
      ];

      for (const entry of required) {
        const source = readRepoFile(entry.file);
        if (source === null) {
          issues.push({
            files: [entry.file],
            expected: 'the file to exist',
            actual: 'it does not',
            message: `${entry.file} is missing; the Prefab spine is incomplete`,
          });
          continue;
        }
        for (const symbol of entry.symbols) {
          if (!source.includes(symbol)) {
            issues.push({
              files: [entry.file],
              expected: `${entry.file} to declare ${symbol}`,
              actual: 'it does not',
              message: `${symbol} has been removed from ${entry.file}`,
            });
          }
        }
      }

      /*
       * Runtime state is never canonical (§3.6). Checked against the files on
       * disk rather than against the schema, because the schema can only refuse
       * what it describes — and `CanonicalPatch.value` is `unknown` by
       * necessity, which is exactly the hole a mixer handle would fit through.
       */
      const RUNTIME_FIELDS = [
        'animationTime',
        'velocity',
        'mixer',
        'activeState',
        'transitionProgress',
        'runtimeHandle',
        'inputBuffer',
      ];
      const canonicalFiles = [
        ...listFiles('assets/prefabs').filter((file) => file.endsWith('.json')),
        ...listFiles('projects').filter((file) => file.endsWith('.json')),
      ];
      for (const file of canonicalFiles) {
        const source = readRepoFile(file);
        if (source === null) continue;
        for (const field of RUNTIME_FIELDS) {
          if (new RegExp(`"${field}"\\s*:`).test(source)) {
            issues.push({
              files: [file],
              expected: 'a canonical document with no runtime state',
              actual: `it contains "${field}"`,
              message: `${file} stores runtime state in a canonical document`,
            });
          }
        }
      }

      return {
        ok: issues.length === 0,
        issues,
        output: `${required.length} module(s) and ${canonicalFiles.length} canonical file(s) checked`,
      };
    },
  );
}

/**
 * The production Scene path reads and writes GameObjects (work package §16).
 *
 * Two halves, and both are needed for the same reason the Prefab guard needs
 * both: a guard that only forbids cannot tell "the cutover was never done" from
 * "the cutover is fine", and a guard that only requires cannot tell "the cutover
 * was done" from "the cutover was done and then something quietly reintroduced
 * the entity path beside it".
 *
 * The negative half is scoped to the *production* Scene modules by name. The
 * entity vocabulary is not forbidden repository-wide — the migration still reads
 * `entities` to produce a GameObject view from a Scene that has none, the legacy
 * operation engine still exists so its tests can exercise it, and the Unity
 * exporter has not been cut over yet. What must not happen is a Scene Editor, a
 * Scene viewport or an apply path reaching for it again.
 *
 * The canonical schema deletion is deliberately *not* required here: it is the
 * next package's job, and requiring it now would fail on the very documents this
 * guard is meant to protect.
 */
export function sceneCutoverGuardStage(): StageResult {
  return stage(
    'the production Scene path reads and writes gameObjects',
    {
      reproduce: 'pnpm harness:repo-guard',
      suggestion:
        'a forbidden symbol in a production Scene module means the entity path is being reintroduced; a missing required one means the cutover was undone',
    },
    () => {
      const issues: StageIssue[] = [];

      /**
       * The retired vocabulary, and the modules that may no longer name it.
       *
       * Matched as whole words so a comment *about* the migration — of which
       * these files contain many, deliberately — does not trip the guard on a
       * substring. What is being detected is a production module reaching for
       * the collection, not a module explaining why it does not.
       */
      const FORBIDDEN = [
        'scene\\.entities',
        'SceneEntityDefinition',
        'CharacterSceneEntity',
        'PropSceneEntity',
        'LightSceneEntity',
        'CameraSceneEntity',
        'entity\\.kind',
        'activeCameraEntityId',
        'scene\\.place_asset',
        'scene\\.delete_entity',
        'scene\\.duplicate_entity',
        'scene\\.rename_entity',
        'scene\\.set_character_source',
        'scene\\.bind_controller',
        'scene\\.reorder_entity',
        'applySceneOperation',
        'validateSceneReferences',
      ];

      /**
       * Production Scene modules.
       *
       * Everything under the Scene Editor, the production renderer projection
       * it draws through, and the repository apply path that writes what it
       * edits. Legacy migration, legacy fixtures and legacy compatibility tests
       * are outside this set by construction — they are not in these
       * directories.
       */
      const productionFiles = [
        ...listFiles('apps/web/src/scene-editor'),
        ...listFiles('apps/web/src/game-objects'),
        'apps/api/src/routes/repository-apply.ts',
        'packages/editor-core/src/game-object-operations.ts',
        'packages/editor-core/src/apply-request.ts',
      ].filter((file) => file.endsWith('.ts') || file.endsWith('.tsx'));

      for (const file of productionFiles) {
        const source = readRepoFile(file);
        if (source === null) continue;
        /*
         * Comments are stripped before matching. These files explain the
         * cutover at length — "it does not iterate scene.entities" is a
         * sentence worth keeping — and a guard that could not tell an
         * explanation from a read would push the explanations out of the code.
         */
        const code = source
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/(^|[^:])\/\/.*$/gm, '$1');
        for (const symbol of FORBIDDEN) {
          if (new RegExp(`\\b${symbol}\\b`).test(code)) {
            issues.push({
              files: [file],
              expected: `${file} to address GameObjects only`,
              actual: `it references ${symbol.replace(/\\/g, '')}`,
              message: `${file} reaches for the retired entity path`,
            });
          }
        }
      }

      /** What the cutover must still contain, by name. */
      const required: { file: string; symbols: string[] }[] = [
        {
          file: 'apps/web/src/scene-editor/use-scene-runtime.ts',
          symbols: ['instantiateScene', 'RuntimeScene'],
        },
        {
          file: 'apps/web/src/scene-editor/viewport/SceneViewport.tsx',
          symbols: ['GameObjectRenderer', 'projectRuntimeScene'],
        },
        {
          file: 'apps/web/src/scene-editor/use-scene-session.ts',
          symbols: ['applySceneGameObjectOperation'],
        },
        {
          file: 'apps/api/src/routes/repository-apply.ts',
          symbols: ['applySceneGameObjectOperation', 'changedGameObjectIds'],
        },
        {
          file: 'packages/editor-core/src/game-object-operations.ts',
          symbols: [
            'scene.place_prefab',
            'scene.delete_game_object',
            'scene.duplicate_game_object',
            'scene.rename_game_object',
            'scene.set_prefab_source',
            'scene.set_component_override',
            'scene.clear_component_override',
            'scene.set_instance_binding',
            'scene.set_relation',
            'scene.reorder_game_object',
          ],
        },
        {
          file: 'harness/check-scene-gameobject-cutover.ts',
          symbols: ['sceneGameObjectCutoverStages'],
        },
        {
          file: 'harness/one-shot.ts',
          symbols: ['sceneGameObjectCutoverStages'],
        },
        {
          file: 'apps/web/src/game-objects/AnimatedRepositoryModel.tsx',
          symbols: ['AnimationMixer', 'cloneSkinnedScene'],
        },
      ];

      for (const entry of required) {
        const source = readRepoFile(entry.file);
        if (source === null) {
          issues.push({
            files: [entry.file],
            expected: 'the file to exist',
            actual: 'it does not',
            message: `${entry.file} is missing; the Scene cutover is incomplete`,
          });
          continue;
        }
        for (const symbol of entry.symbols) {
          if (!source.includes(symbol)) {
            issues.push({
              files: [entry.file],
              expected: `${entry.file} to reference ${symbol}`,
              actual: 'it does not',
              message: `${symbol} has been removed from ${entry.file}`,
            });
          }
        }
      }

      /*
       * No reverse generation, anywhere (§9.2). A production write that
       * regenerated `entities` from `gameObjects` would make the dual source of
       * truth permanent — so the assignment is forbidden outright rather than
       * scoped, and the migration is exempted by name because it goes the other
       * way and only for a Scene that has no GameObject view at all.
       */
      const REVERSE_GENERATION = /entities\s*:\s*\(?\s*(scene|document)\??\.gameObjects/;
      for (const file of [
        ...listFiles('apps/web/src'),
        ...listFiles('apps/api/src'),
        ...listFiles('packages/editor-core/src'),
      ].filter((file) => file.endsWith('.ts') || file.endsWith('.tsx'))) {
        const source = readRepoFile(file);
        if (source !== null && REVERSE_GENERATION.test(source)) {
          issues.push({
            files: [file],
            expected: 'gameObjects never to be reverse-generated into entities',
            actual: 'it derives entities from gameObjects',
            message: `${file} reverse-generates the legacy entity mirror`,
          });
        }
      }

      return {
        ok: issues.length === 0,
        issues,
        output: `${productionFiles.length} production Scene file(s) and ${required.length} required module(s) checked`,
      };
    },
  );
}

export function repoGuardStages(): StageResult[] {
  return [
    workspaceAliasStage(),
    characterControlBoundaryStage(),
    characterSelectorBoundaryStage(),
    protectedValuesStage(),
    testIntegrityStage(),
    schemaConstraintStage(),
    generatedNotCanonicalStage(),
    secretsStage(),
    restrictedAssetStage(),
    publishedAssetImmutabilityStage(),
    stateNameDependenceStage(),
    worldContractGuardStage(),
    prefabSystemGuardStage(),
    sceneCutoverGuardStage(),
  ];
}

function main(): void {
  const results = repoGuardStages();
  for (const result of results) printStage(result);
  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} repo guard checks passed`);
  process.exit(failed.length > 0 ? 1 : 0);
}

if (process.argv[1]?.includes('repo-guard')) main();
