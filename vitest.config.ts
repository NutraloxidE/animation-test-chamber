import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

const pkg = (name: string): string => resolve(__dirname, `packages/${name}/src/index.ts`);

export default defineConfig({
  resolve: {
    alias: {
      '@atc/schema': pkg('schema'),
      '@atc/runtime-core': pkg('runtime-core'),
      '@atc/animation-runtime': pkg('animation-runtime'),
      '@atc/animation-asset-runtime': pkg('animation-asset-runtime'),
      '@atc/input-runtime': pkg('input-runtime'),
      '@atc/terrain-runtime': pkg('terrain-runtime'),
      '@atc/haptics-runtime': pkg('haptics-runtime'),
      '@atc/replay-runtime': pkg('replay-runtime'),
      '@atc/world-runtime': pkg('world-runtime'),
      '@atc/character-control-runtime': pkg('character-control-runtime'),
      '@atc/scene-runtime': pkg('scene-runtime'),
      '@atc/capability-runtime': pkg('capability-runtime'),
      '@atc/editor-core': pkg('editor-core'),
      '@atc/git-adapter': pkg('git-adapter'),
      '@atc/ai-adapter': pkg('ai-adapter'),
      '@atc/acquisition-core': pkg('acquisition-core'),
      '@atc/unity-export': pkg('unity-export'),
      '@atc/repository-transaction': pkg('repository-transaction'),
      '@atc/prefab-runtime': pkg('prefab-runtime'),
      '@atc/game-object-runtime': pkg('game-object-runtime'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/visual/**', 'node_modules/**'],
  },
});
