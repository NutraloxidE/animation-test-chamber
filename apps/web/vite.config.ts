import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

const repoRoot = resolve(__dirname, '../..');

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Workspace packages are consumed as TypeScript source rather than built
    // artifacts, so there is no build step between editing a package and seeing
    // it in the browser.
    alias: {
      '@atc/schema': resolve(repoRoot, 'packages/schema/src/index.ts'),
      '@atc/runtime-core': resolve(repoRoot, 'packages/runtime-core/src/index.ts'),
      '@atc/animation-runtime': resolve(repoRoot, 'packages/animation-runtime/src/index.ts'),
      '@atc/animation-asset-runtime': resolve(repoRoot, 'packages/animation-asset-runtime/src/index.ts'),
      '@atc/input-runtime': resolve(repoRoot, 'packages/input-runtime/src/index.ts'),
      '@atc/terrain-runtime': resolve(repoRoot, 'packages/terrain-runtime/src/index.ts'),
      '@atc/haptics-runtime': resolve(repoRoot, 'packages/haptics-runtime/src/index.ts'),
      '@atc/replay-runtime': resolve(repoRoot, 'packages/replay-runtime/src/index.ts'),
      '@atc/world-runtime': resolve(repoRoot, 'packages/world-runtime/src/index.ts'),
      '@atc/capability-runtime': resolve(repoRoot, 'packages/capability-runtime/src/index.ts'),
      '@atc/editor-core': resolve(repoRoot, 'packages/editor-core/src/index.ts'),
      '@atc/ai-adapter': resolve(repoRoot, 'packages/ai-adapter/src/index.ts'),
      '@atc/acquisition-core': resolve(repoRoot, 'packages/acquisition-core/src/index.ts'),
      '@chamber/project': resolve(repoRoot, 'projects/demo-character/project.json'),
      '@chamber/animation-assets': resolve(repoRoot, 'generated/animation-assets/library-index.json'),
    },
  },
  server: {
    // Explicit IPv4. Vite's default binds whatever `localhost` resolves to,
    // which on some hosts is `::1` only — and every other address in this repo
    // (the proxy target below, Playwright's baseURL) is spelled 127.0.0.1, so
    // the test runner would wait for a port nothing was listening on.
    host: '127.0.0.1',
    port: 5173,
    fs: {
      // Needed because sources and canonical data live above apps/web.
      allow: [repoRoot],
    },
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    // three.js and the R3F stack dominate the bundle; a higher ceiling keeps
    // the build output readable instead of drowning it in warnings.
    chunkSizeWarningLimit: 1600,
  },
});
