import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import type { Plugin } from 'vite';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { licenseEntries } from './src/main/licenses';

// Workspace packages ship TypeScript source, so they are bundled, never externalized.
const bundled = [/^@aio\//];

/**
 * `virtual:licenses`: third-party packages that ship in the app, from pnpm's licence report at
 * build time (Settings, About). Never stale, nothing generated in git.
 */
function licenses(): Plugin {
  const id = 'virtual:licenses';
  return {
    name: 'aio-licenses',
    resolveId: (source) => (source === id ? `\0${id}` : null),
    load(loaded) {
      if (loaded !== `\0${id}`) return null;
      let report: unknown = {};
      try {
        const out = execSync('pnpm licenses list --json --prod -r', {
          cwd: resolve(import.meta.dirname, '../..'),
          encoding: 'utf8',
          maxBuffer: 64 * 1024 * 1024,
        });
        report = JSON.parse(out) as unknown;
      } catch (e) {
        this.warn(`Licence report unavailable, About will list none: ${String(e)}`);
      }
      return `export default ${JSON.stringify(licenseEntries(report))};`;
    },
  };
}

export default defineConfig({
  main: {
    plugins: [licenses()],
    build: {
      externalizeDeps: {
        exclude: ['@aio/schema', '@aio/brand', '@aio/ai', '@aio/project', '@aio/geo'],
      },
      rollupOptions: {
        input: { index: resolve(import.meta.dirname, 'src/main/index.ts') },
        // Native addons load from node_modules at runtime so each platform gets its own binary.
        external: ['electron', /^node:/, /^@napi-rs\/keyring/, 'electron-updater'],
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
