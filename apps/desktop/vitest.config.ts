import { defineConfig } from 'vitest/config';
import { inlineImports } from './src/build/inlineImports.ts';

export default defineConfig({
  // `?script` and `?datauri` imports, as the renderer build serves them
  plugins: [inlineImports()],
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    // Main-process tests write projects, packs and updates to disk and renderer tests build large
    // module graphs. Each takes well under a second alone, but while several checks share the
    // computer the 5 s default failed a different file each run (collab, packages, panos,
    // websiteStorage, compareStore, 30 Oct 2026). A real hang still fails, after 20 s. Files that
    // need more (ffmpeg, engineer IPC) set their own allowance.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
