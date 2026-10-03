import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import { resolve } from 'node:path';

// Workspace packages ship TypeScript source, so they are bundled, never externalized.
const bundled = [/^@aio\//];

export default defineConfig({
  main: {
    build: {
      externalizeDeps: {
        exclude: ['@aio/schema', '@aio/brand', '@aio/ai', '@aio/project', '@aio/geo'],
      },
      rollupOptions: {
        input: { index: resolve(import.meta.dirname, 'src/main/index.ts') },
        external: ['electron', /^node:/],
      },
    },
  },
  preload: {
    build: {
      externalizeDeps: { exclude: ['@aio/schema'] },
      rollupOptions: {
        input: { index: resolve(import.meta.dirname, 'src/preload/index.ts') },
        external: ['electron'],
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: resolve(import.meta.dirname, 'src/renderer'),
    plugins: [react()],
    resolve: { noExternal: bundled },
    build: {
      rollupOptions: { input: { index: resolve(import.meta.dirname, 'src/renderer/index.html') } },
    },
  },
});
