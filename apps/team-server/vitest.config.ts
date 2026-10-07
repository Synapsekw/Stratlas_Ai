import { builtinModules } from 'node:module';
import { defineConfig } from 'vitest/config';

/**
 * Tests, and the server bundle for the Docker image (`pnpm build`, `vite build --config
 * vitest.config.ts`): `dist/main.mjs` (the command line and the server) and
 * `dist/healthcheck.mjs`, everything bundled (workspace packages, Fastify, pg, zod), so the image
 * needs Node and the `migrations/` folder only.
 */
export default defineConfig({
  test: { include: ['src/**/*.test.ts'] },
  build: {
    ssr: true,
    target: 'node24',
    outDir: 'dist',
    emptyOutDir: true,
    minify: false,
    sourcemap: false,
    rollupOptions: {
      input: { main: 'src/main.ts', healthcheck: 'src/healthcheck.ts' },
      external: [...builtinModules, ...builtinModules.map((m) => `node:${m}`), 'pg-native'],
      output: { format: 'es', entryFileNames: '[name].mjs', chunkFileNames: '[name].mjs' },
    },
  },
  ssr: { noExternal: true, target: 'node' },
});
