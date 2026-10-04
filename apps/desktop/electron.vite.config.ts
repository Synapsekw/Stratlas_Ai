import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import { cp, readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, normalize, resolve } from 'node:path';
import type { Plugin } from 'vite';

// Workspace packages ship TypeScript source, so they are bundled, never externalized.
const bundled = [/^@aio\//];

/** pdf.js data the viewer loads at runtime (fonts, CMaps, decoders), served from the app. */
const PDFJS_DIRS = ['cmaps', 'standard_fonts', 'wasm', 'iccs'];
const pdfjsRoot = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));

/** Copy pdf.js runtime data into the renderer build as `pdfjs/`, and serve it in dev. */
function pdfjsAssets(): Plugin {
  let outDir = '';
  return {
    name: 'aio-pdfjs-assets',
    configResolved(config) {
      outDir = config.build.outDir;
    },
    configureServer(server) {
      server.middlewares.use('/pdfjs/', (req, res, next) => {
        const rel = normalize(decodeURIComponent((req.url ?? '').split('?')[0] ?? '')).replace(
          /^[\\/]+/,
          '',
        );
        const file = join(pdfjsRoot, rel);
        if (!file.startsWith(pdfjsRoot) || !PDFJS_DIRS.some((d) => rel.startsWith(d))) {
          next();
          return;
        }
        void readFile(file).then(
          (buf) => res.end(buf),
          () => {
            next();
          },
        );
      });
    },
    async closeBundle() {
      for (const d of PDFJS_DIRS) {
        const from = join(pdfjsRoot, d);
        if (await stat(from).catch(() => null)) {
          await cp(from, join(outDir, 'pdfjs', d), { recursive: true });
        }
      }
    },
  };
}

export default defineConfig({
  main: {
    build: {
      externalizeDeps: {
        exclude: ['@aio/schema', '@aio/brand', '@aio/ai', '@aio/project', '@aio/geo'],
      },
      rollupOptions: {
        input: {
          index: resolve(import.meta.dirname, 'src/main/index.ts'),
          // export utility process (utilityProcess.fork)
          exportWorker: resolve(import.meta.dirname, 'src/main/exports/worker.ts'),
        },
        // Native addons load from node_modules at runtime so each platform gets its own binary.
        external: ['electron', /^node:/, /^@napi-rs\/keyring/],
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
    plugins: [react(), pdfjsAssets()],
    resolve: { noExternal: bundled },
    build: {
      rollupOptions: {
        input: {
          index: resolve(import.meta.dirname, 'src/renderer/index.html'),
          // the issue register report, printed from an offscreen window
          report: resolve(import.meta.dirname, 'src/renderer/report.html'),
        },
      },
    },
  },
});
