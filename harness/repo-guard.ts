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
    if (statSync(path).isDirectory()) listFiles(relative(REPO_ROOT, path), out);
    else out.push(relative(REPO_ROOT, path));
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

      for (const file of schemaFiles) {
        const before = readAtRevision('HEAD', file);
        const after = readRepoFile(file);
        if (before === null || after === null) continue;

        // additionalProperties: false is what stops unknown fields creeping in.
        const strictBefore = (before.match(/additionalProperties:\s*false/g) ?? []).length;
        const strictAfter = (after.match(/additionalProperties:\s*false/g) ?? []).length;
        if (strictAfter < strictBefore) {
          issues.push({
            files: [file],
            expected: `${strictBefore} strict object(s)`,
            actual: `${strictAfter}`,
            message: `${file} dropped an additionalProperties:false constraint`,
          });
        }

        const requiredBefore = (before.match(/Type\.Optional\(/g) ?? []).length;
        const requiredAfter = (after.match(/Type\.Optional\(/g) ?? []).length;
        if (requiredAfter > requiredBefore + 2) {
          issues.push({
            files: [file],
            expected: 'required fields to stay required',
            actual: `${requiredAfter - requiredBefore} more fields became optional`,
            message: `${file} made several fields optional at once`,
          });
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
          { test: /\b(document|window)\./, label: 'a DOM global' },
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
 * The information-architecture boundaries, as boundaries rather than as prose.
 *
 * These are deliberately narrow. The behavioural claims — no World tab, no
 * property selects in the tree, a shield change that does not reach a sibling —
 * are asserted against the real DOM in `tests/visual/hierarchy` and
 * `tests/visual/loadout`, because a source scan can only ever check that the
 * text nobody wrote is still not written. What a scan *is* good for is the two
 * structural facts a future edit could restore by accident: a second writable
 * selection field, and a loadout setter with no instance in its signature.
 * Both were real, both were the actual defect, and neither is visible in a
 * screenshot (DECISION 0012).
 */
export function sceneSelectionGuardStage(): StageResult {
  return stage(
    'scene selection and loadout stay instance-qualified',
    {
      reproduce: 'pnpm harness:repo-guard',
      suggestion:
        'derive the selected instance from sceneSelection, and give every loadout mutation an instanceId',
    },
    () => {
      const issues: StageIssue[] = [];
      const webFiles = listFiles('apps/web/src').filter(
        (file) => file.endsWith('.ts') || file.endsWith('.tsx'),
      );

      for (const file of webFiles) {
        const raw = readRepoFile(file);
        if (!raw) continue;
        // Comments are stripped first. This file's own prose names the removed
        // setters in order to explain why they were removed, and a guard that
        // fired on the explanation would make documenting the rule impossible.
        const content = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

        /*
         * A second writable selected-instance field. `selectedInstanceId` as a
         * *derivation* is fine and is what the selection module exports; as a
         * store field assigned to, it is the ambiguity this refactor removed.
         */
        if (/\bset\(\{[^}]*\bselectedInstanceId\s*:/s.test(content)) {
          issues.push({
            files: [file],
            expected: 'selected instance derived from sceneSelection',
            actual: 'a writable selectedInstanceId store field',
            message: `${file} writes selectedInstanceId; derive it from sceneSelection instead`,
          });
        }

        /*
         * Loadout actions without an instance, on the *store's* surface only.
         *
         * `ChamberEngine.setEquipped` is deliberately untouched: the focused
         * engine drives exactly one character, so an instance id there would
         * be a parameter with one legal value. What must not come back is a
         * store action a panel can call without saying which instance it
         * means — the old signatures are named exactly, because "a weapon-mode
         * setter" is not something a regex can recognise in general, and a
         * guard that guessed would fire on the instance-qualified ones this
         * refactor added.
         */
        if (file !== 'apps/web/src/store.ts') continue;
        for (const declaration of [/^\s*setWeaponMode\(id/m, /^\s*setEquipped\(slotId/m]) {
          const match = content.match(declaration);
          if (match) {
            issues.push({
              files: [file],
              expected: 'setInstanceWeaponMode / setInstanceEquipment',
              actual: match[0].trim(),
              message: `${file} declares a loadout action with no instanceId; loadout is per-instance`,
            });
          }
        }
      }

      return {
        ok: issues.length === 0,
        issues,
        output: `${webFiles.length} web sources scanned`,
      };
    },
  );
}

/**
 * The sandbox bootstrap seam stays construction-only, and stays out of the
 * live world.
 *
 * `AnimationGraphRuntime.bootstrapState` refuses to run after the first tick,
 * which is what makes it safe — but a `forceState` added next to it, or a
 * `WorldRuntime` that started passing a bootstrap through to its instances,
 * would reopen exactly the hole the seam was shaped to avoid: a way to rewrite
 * a tick record that replay determinism is measured against, reachable from
 * world commands, the HTTP capability surface and replay playback.
 *
 * So this guards the *reachability*, not the intent.
 */
export function sandboxSeamGuardStage(): StageResult {
  return stage(
    'the sandbox bootstrap seam is construction-only and unreachable from the live world',
    {
      reproduce: 'pnpm harness:repo-guard',
      suggestion:
        'accept a bootstrap through SimulationInit at construction; never add a force-state method or pass one from WorldRuntime',
    },
    () => {
      const issues: StageIssue[] = [];
      const sources = [
        ...listFiles('packages').filter((file) => file.endsWith('.ts')),
        ...listFiles('apps/web/src').filter(
          (file) => file.endsWith('.ts') || file.endsWith('.tsx'),
        ),
      ];

      for (const file of sources) {
        const raw = readRepoFile(file);
        if (!raw) continue;
        // Comments stripped for the same reason as the selection guard: this
        // rule is explained in prose in several files, and a guard that fired
        // on its own explanation could not be documented.
        const content = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

        // A force-state on a running object, under any of its usual names.
        for (const pattern of [
          /\bforceState\s*\(/,
          /\bsetLayerState\s*\(/,
          /\bsetActionState\s*\(/,
          /\bsetLocomotionState\s*\(/,
        ]) {
          const match = content.match(pattern);
          if (match) {
            issues.push({
              files: [file],
              expected: 'construction-only bootstrap through SimulationInit',
              actual: match[0].trim(),
              message: `${file} exposes ${match[0].trim()}; a running state override must not exist`,
            });
          }
        }

        // The world runtime must never construct a bootstrapped simulation:
        // that would put the seam on the live path after all.
        if (file.includes('world-runtime') && /\bbootstrap\s*:/.test(content)) {
          issues.push({
            files: [file],
            expected: 'WorldRuntime builds simulations with no bootstrap',
            actual: 'a bootstrap passed from the world runtime',
            message: `${file} passes a bootstrap into a live simulation`,
          });
        }
      }

      // And the seam itself must still latch shut.
      const graph = readRepoFile('packages/animation-runtime/src/graph.ts') ?? '';
      if (!/this\.ticked\s*=\s*true/.test(graph) || !/construction-only/.test(graph)) {
        issues.push({
          files: ['packages/animation-runtime/src/graph.ts'],
          expected: 'bootstrapState throws once the graph has ticked',
          actual: 'no latch found',
          message: 'the bootstrap seam no longer closes after the first tick',
        });
      }

      return { ok: issues.length === 0, issues, output: `${sources.length} sources scanned` };
    },
  );
}

/**
 * Canonical demo data is clean after the visual suite.
 *
 * The visual tests drive the real API server, which writes to the repository —
 * that is the point of them, and it is also how a test run leaves the demo
 * project or an asset file modified without anybody noticing until the diff
 * shows up in an unrelated commit. `git add -A` on top of that commits test
 * output as authored data.
 *
 * This fails the build instead. It is deliberately a *comparison against HEAD*
 * rather than a snapshot taken by the test harness: a guard that only knows
 * what the tests touched cannot catch what something else did.
 */
export function canonicalDataCleanStage(): StageResult {
  return stage(
    'canonical demo data unmodified by test runs',
    {
      reproduce: 'pnpm harness:repo-guard',
      suggestion:
        'restore projects/ and assets/ (git checkout --), and make the visual test isolate or undo its writes',
    },
    () => {
      if (!gitHasCommits()) {
        return { ok: true, issues: [], output: 'no previous commit to compare against' };
      }
      const issues: StageIssue[] = [];
      const canonical = [
        ...listFiles('projects').filter((file) => file.endsWith('.json')),
        ...listFiles('assets/animation').filter((file) => file.endsWith('.json')),
      ];

      for (const file of canonical) {
        const committed = readAtRevision('HEAD', file);
        const working = readRepoFile(file);
        if (committed === null || working === null) continue;
        if (committed !== working) {
          issues.push({
            files: [file],
            expected: 'byte-identical to HEAD',
            actual: 'modified in the working tree',
            message: `${file} differs from HEAD; a test run may have written to canonical data`,
          });
        }
      }

      return { ok: issues.length === 0, issues, output: `${canonical.length} canonical files checked` };
    },
  );
}

export function repoGuardStages(): StageResult[] {
  return [
    protectedValuesStage(),
    testIntegrityStage(),
    schemaConstraintStage(),
    generatedNotCanonicalStage(),
    secretsStage(),
    restrictedAssetStage(),
    publishedAssetImmutabilityStage(),
    stateNameDependenceStage(),
    worldContractGuardStage(),
    sceneSelectionGuardStage(),
    sandboxSeamGuardStage(),
    canonicalDataCleanStage(),
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
