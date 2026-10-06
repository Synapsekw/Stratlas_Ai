import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { cp, readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, normalize, resolve } from 'node:path';
import type { Plugin } from 'vite';
import { licenseEntries } from './src/main/licenses';

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

/**
 * `virtual:release-notes`: notes of this version from conventional commits since the previous
 * release tag (tools/release/notes.mjs), shown in Settings, About and updates. Without git the
 * notes say they are not available; the build never fails over them.
 */
function releaseNotes(): Plugin {
  const id = 'virtual:release-notes';
  return {
    name: 'aio-release-notes',
    resolveId: (source) => (source === id ? `\0${id}` : null),
    load(loaded) {
      if (loaded !== `\0${id}`) return null;
      const version = (
        JSON.parse(readFileSync(resolve(import.meta.dirname, 'package.json'), 'utf8')) as {
          version: string;
        }
      ).version;
      let notes = { version, markdown: '' };
      try {
        const out = execSync('node tools/release/notes.mjs --json', {
          cwd: resolve(import.meta.dirname, '../..'),
          encoding: 'utf8',
          maxBuffer: 16 * 1024 * 1024,
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        const parsed = JSON.parse(out) as { version: string; markdown: string };
        notes = { version: parsed.version, markdown: parsed.markdown };
      } catch (e) {
        this.warn(`Release notes unavailable: ${String(e)}`);
      }
      return `export default ${JSON.stringify(notes)};`;
    },
  };
}

/**
 * `__STRATLAS_BUILD__`: when and from which commit this bundle was built, shown in Settings,
 * About and on the Projects screen so a stale installed copy is obvious. Without git (a source
 * archive) the commit is "dev"; the build never fails over it.
 */
function buildStamp(): { time: string; commit: string; version: string } {
  let commit = 'dev';
  try {
    commit =
      execSync('git rev-parse --short HEAD', {
        cwd: import.meta.dirname,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim() || 'dev';
  } catch {
    // no git, or not a checkout
  }
  const pkg = JSON.parse(readFileSync(resolve(import.meta.dirname, 'package.json'), 'utf8')) as {
    version?: string;
  };
  return { time: new Date().toISOString(), commit, version: pkg.version ?? '' };
}

export default defineConfig({
  main: {
    plugins: [licenses(), releaseNotes()],
    build: {
      externalizeDeps: {
        exclude: ['@aio/schema', '@aio/brand', '@aio/ai', '@aio/project', '@aio/geo', '@aio/video'],
      },
      rollupOptions: {
        input: {
          index: resolve(import.meta.dirname, 'src/main/index.ts'),
          // export utility process (utilityProcess.fork)
          exportWorker: resolve(import.meta.dirname, 'src/main/exports/worker.ts'),
        },
        // Native addons load from node_modules at runtime so each platform gets its own binary.
        // `original-fs` is Electron's fs without asar support (rollback copies app.asar as a file).
        external: ['electron', 'original-fs', /^node:/, /^@napi-rs\/keyring/],
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
    define: { __STRATLAS_BUILD__: JSON.stringify(buildStamp()) },
    resolve: { noExternal: bundled },
    build: {
      rollupOptions: {
        input: {
          index: resolve(import.meta.dirname, 'src/renderer/index.html'),
          // the issue register report, printed from an offscreen window
          report: resolve(import.meta.dirname, 'src/renderer/report.html'),
          // the house-format project report (BLD-8), printed the same way
          house: resolve(import.meta.dirname, 'src/renderer/house.html'),
        },
      },
    },
  },
});
