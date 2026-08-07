import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { printStage, readRepoFile, REPO_ROOT, run, stage, type StageIssue, type StageResult } from './lib.ts';

const required: Record<string, string[]> = {
  'apps/web/src/app/routes.ts': ['prefabAnimationWorkspacePath'],
  'apps/web/src/app/router.tsx': ['legacyRigWorkspaceRedirect', 'prefabAnimationWorkspacePath'],
  'apps/web/src/animation-chamber/AnimationChamberFacade.ts': ['AnimationPreviewWorldSession', 'AnimationPublicationController'],
  'apps/web/src/animation-chamber/AnimationChamber.tsx': ['PrefabAnimationHierarchy', 'AnimationAssetLibrary', 'SubjectConflictBanner'],
  'apps/web/src/animation-chamber/AnimationPanelRegistry.ts': ["label: 'World', implemented: true", "label: 'Import', implemented: true"],
  'apps/web/src/animation-chamber/PrefabAnimationHierarchy.tsx': ['animation-component-current-subject', 'NESTED SOURCE'],
  'apps/web/src/animation-chamber/AnimationPreviewWorldPanel.tsx': ['PREVIEW WORLD', 'Not saved to a Scene'],
  'apps/web/src/animation-chamber/AnimationSaveDestination.tsx': ['publish-only'],
};

const nativeFiles = [
  'apps/web/src/animation-chamber',
  'apps/web/src/prefab-editor/AnimationWorkspaceRoute.tsx',
];

function sourceFiles(path: string): string[] {
  const result = run('git', ['ls-files', `${path}/**`, path]);
  return result.output.split(/\r?\n/).filter((file) => /\.(ts|tsx)$/.test(file));
}

export function rigEditorNativeRestorationStages(): StageResult[] {
  return [
    stage('native rig editor: required surfaces', { reproduce: 'pnpm harness:rig-editor-native-restoration', blocksCommit: true }, () => {
      const issues = Object.entries(required).flatMap(([file, needles]) => {
        const source = readRepoFile(file);
        return needles.filter((needle) => !source?.includes(needle)).map((needle): StageIssue => ({ files: [file], expected: needle, actual: source ? 'missing' : 'file missing', message: `${file} must contain ${needle}` }));
      });
      return { ok: issues.length === 0, issues };
    }),
    stage('native rig editor: Character-free boundary', { reproduce: 'pnpm harness:rig-editor-native-restoration', blocksCommit: true }, () => {
      const forbidden = ['CharacterDefinition', 'Project.characters', 'activeCharacterId', 'setActiveCharacter', 'resolveCharacterAnimation', 'useCharacterPresentation', 'useCharacterBindings', 'LEGACY_CHARACTER_PREFAB_IDS', 'legacyCharacterIdForAnimationSubject'];
      const issues: StageIssue[] = [];
      for (const file of nativeFiles.flatMap(sourceFiles)) {
        const code = (readRepoFile(file) ?? '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
        for (const term of forbidden) if (code.includes(term)) issues.push({ files: [file], expected: `no ${term}`, actual: term, message: `${file} crosses the Character boundary` });
      }
      return { ok: issues.length === 0, issues };
    }),
    stage('native rig editor: legacy workspace absent', { reproduce: 'pnpm harness:rig-editor-native-restoration', blocksCommit: true }, () => {
      const removed = ['apps/web/src/prefab-editor/AnimationWorkspace.tsx', 'apps/web/src/prefab-editor/legacy-animation-workspace-adapter.ts'];
      const prefabEditor = readRepoFile('apps/web/src/prefab-editor/PrefabEditorPage.tsx') ?? '';
      const issues = [
        ...removed.filter((file) => existsSync(resolve(REPO_ROOT, file))).map((file): StageIssue => ({ files: [file], expected: 'deleted', actual: 'present', message: `${file} remains` })),
        ...(prefabEditor.includes('<AnimationWorkspace') ? [{ files: ['apps/web/src/prefab-editor/PrefabEditorPage.tsx'], expected: 'no embedded workspace', actual: '<AnimationWorkspace', message: 'Prefab Editor still embeds animation authoring' }] : []),
      ];
      return { ok: issues.length === 0, issues };
    }),
    stage('native rig editor: focused tests', { reproduce: 'pnpm harness:rig-editor-native-restoration', blocksCommit: true }, () => {
      const result = run('npx', ['vitest', 'run', 'tests/unit/animation-chamber', 'tests/unit/routing']);
      return { ok: result.code === 0, issues: result.code === 0 ? [] : [{ files: ['tests/unit/animation-chamber', 'tests/unit/routing'], expected: 'focused tests pass', actual: result.output.slice(-2000), message: 'native restoration tests failed' }], output: result.output };
    }),
  ];
}

if (process.argv[1]?.includes('check-rig-editor-native-restoration')) {
  const results = rigEditorNativeRestorationStages();
  results.forEach(printStage);
  process.exit(results.every((result) => result.ok) ? 0 : 1);
}
