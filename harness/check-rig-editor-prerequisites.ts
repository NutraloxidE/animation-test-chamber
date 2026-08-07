import { printStage, readRepoFile, run, stage, type StageResult } from './lib.ts';

const REQUIRED: Record<string, string[]> = {
  'packages/schema/src/animation-subject.ts': ['AnimationSubjectDefinition', 'animationSubjectId'],
  'packages/prefab-runtime/src/animation-subject.ts': ['animationSubjectFromPrefab'],
  'packages/animation-asset-runtime/src/resolver.ts': ['resolveAnimationSubject'],
  'apps/web/src/prefab-editor/animation-authoring-session.ts': ['AnimationAuthoringSession'],
  'packages/prefab-runtime/src/adoption.ts': ['AnimationPublicationPlan'],
};

export function rigEditorPrerequisiteStages(): StageResult[] {
  return [
    stage('rig prerequisites: explicit subject core', { reproduce: 'pnpm harness:rig-editor-prerequisites' }, () => {
      const issues = Object.entries(REQUIRED).flatMap(([file, symbols]) => {
        const source = readRepoFile(file);
        return symbols
          .filter((symbol) => !source?.includes(symbol))
          .map((symbol) => ({ files: [file], expected: symbol, actual: source ? 'missing' : 'file missing', message: `${file} must define ${symbol}` }));
      });
      return { ok: issues.length === 0, issues };
    }),
    stage('rig prerequisites: Character-free core', { reproduce: 'pnpm harness:rig-editor-prerequisites' }, () => {
      const core = [
        'packages/schema/src/animation-subject.ts',
        'packages/prefab-runtime/src/animation-subject.ts',
        'apps/web/src/prefab-editor/animation-authoring-session.ts',
      ];
      const forbidden = ['CharacterDefinition', 'activeCharacterId', 'LEGACY_CHARACTER_PREFAB_IDS', 'setActiveCharacter', 'project.characters'];
      const issues = core.flatMap((file) => forbidden.filter((term) => readRepoFile(file)?.includes(term)).map((term) => ({ files: [file], expected: `no ${term}`, actual: term, message: `${file} imports legacy Character state` })));
      return { ok: issues.length === 0, issues };
    }),
    stage('rig prerequisites: focused tests', { reproduce: 'npx vitest run tests/unit/animation-subject tests/unit/prefabs/adoption.test.ts' }, () => {
      const result = run('npx', ['vitest', 'run', 'tests/unit/animation-subject', 'tests/unit/prefabs/adoption.test.ts']);
      return { ok: result.code === 0, issues: result.code === 0 ? [] : [{ files: ['tests/unit/animation-subject', 'tests/unit/prefabs/adoption.test.ts'], expected: 'focused tests pass', actual: result.output.slice(-2000), message: 'rig prerequisite tests failed' }], output: result.output };
    }),
  ];
}

if (process.argv[1]?.includes('check-rig-editor-prerequisites')) {
  const results = rigEditorPrerequisiteStages();
  results.forEach(printStage);
  process.exit(results.every((result) => result.ok) ? 0 : 1);
}
