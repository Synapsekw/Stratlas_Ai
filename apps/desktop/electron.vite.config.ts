import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { cp, readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, normalize, resolve } from 'node:path';
import { minify, type Plugin } from 'vite';
import { offlineSource } from '../../packages/globe/src/offline';
import { APP_CSP, cspMetaTag, inlineScripts } from './src/main/csp';
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
 * Built pages load from file://, where main's CSP response header never applies, so every
 * renderer HTML entry (index, report, house, guide) gets the app policy as a `<meta>` tag, first
 * in `<head>`, from the same constant main sends as the header in dev (src/main/csp.ts). A meta
 * policy cannot carry `frame-ancestors`, `report-uri` or `sandbox`; those stay header-only.
 * The policy allows no inline script, so a built page with one fails the build here.
 * Build only: in dev the pages come over http from the dev server and main's header applies.
 */
function cspMeta(): Plugin {
  return {
    name: 'aio-csp-meta',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        const inline = inlineScripts(html);
        if (inline.length) {
          throw new Error(
            `${ctx.filename}: inline <script> the app CSP blocks (script-src has no 'unsafe-inline'):\n${inline.join('\n')}`,
          );
        }
        if (/http-equiv\s*=\s*["']?content-security-policy/i.test(html)) {
          throw new Error(`${ctx.filename}: has its own CSP meta; the policy comes from csp.ts`);
        }
        // after `<meta charset>` (which stays first), before every script and stylesheet
        const m = /<meta\s+charset[^>]*>/i.exec(html) ?? /<head(\s[^>]*)?>/i.exec(html);
        if (!m) throw new Error(`${ctx.filename}: no <head> for the CSP meta`);
        const at = m.index + m[0].length;
        return `${html.slice(0, at)}\n    ${cspMetaTag(APP_CSP)}${html.slice(at)}`;
      },
    },
  };
}

/**
 * CesiumJS runtime files the Globe loads by URL (M10 G6): web workers, WebAssembly decoders and
 * the assets the offline globe needs, copied into the renderer build as `cesium/` (served from
 * `'self'`, `CESIUM_BASE_URL`) and served from the package in dev. Left out on purpose: the Bing,
 * Google and ion credit logos (trademarks of online services we never use), the moon, water and
 * lens-flare textures (provenance not stated; the Globe turns those effects off), the Google
 * Earth Enterprise parser, and what the Globe never loads (KMZ zip worker, Gaussian splats, Maki
 * icons).
 */
const cesiumRoot = join(
  dirname(createRequire(import.meta.url).resolve('@cesium/engine/package.json')),
  'Build',
);
const CESIUM_COPY = [
  'Workers',
  'ThirdParty/draco_decoder.wasm',
  'ThirdParty/basis_transcoder.wasm',
  'Assets/approximateTerrainHeights.json',
  'Assets/IAU2006_XYS',
  'Assets/Images/cesium_credit.png',
  'Assets/Textures/NaturalEarthII',
  'Assets/Textures/SkyBox',
];
const cesiumAllowed = (rel: string) =>
  CESIUM_COPY.some((c) => rel === c || rel.startsWith(`${c}/`));

function cesiumAssets(): Plugin {
  let outDir = '';
  return {
    name: 'aio-cesium-assets',
    configResolved(config) {
      outDir = config.build.outDir;
    },
    configureServer(server) {
      server.middlewares.use('/cesium/', (req, res, next) => {
        const rel = normalize(decodeURIComponent((req.url ?? '').split('?')[0] ?? ''))
          .replace(/^[\\/]+/, '')
          .replace(/\\/g, '/');
        const file = join(cesiumRoot, rel);
        if (!file.startsWith(cesiumRoot) || !cesiumAllowed(rel)) {
          next();
          return;
        }
        if (rel.endsWith('.js')) res.setHeader('Content-Type', 'text/javascript');
        if (rel.endsWith('.wasm')) res.setHeader('Content-Type', 'application/wasm');
        void readFile(file).then(
          (buf) => res.end(buf),
          () => {
            next();
          },
        );
      });
    },
    async closeBundle() {
      for (const rel of CESIUM_COPY) {
        const from = join(cesiumRoot, rel);
        if (await stat(from).catch(() => null)) {
          await cp(from, join(outDir, 'cesium', rel), { recursive: true });
        }
      }
    },
  };
}

/**
 * The Globe is offline by construction (decision 3): CesiumJS's sources name the online services
 * it can use (ion, Bing, Google, Esri, Mapbox) as default URLs. Our code never constructs those
 * providers (the lint rule), and this rewrites every such host in the bundled Cesium modules to
 * `offline.invalid` (RFC 2606, never resolves; `@aio/globe` `offlineSource`), so even an
 * unexpected default cannot name a real server; `tools/release/check-bundle.mjs` then proves no
 * online map host is in the build.
 */
function cesiumOffline(): Plugin {
  return {
    name: 'aio-cesium-offline',
    enforce: 'pre',
    transform(code, id) {
      if (!/[\\/]@cesium[\\/]/.test(id) || !/\.m?js$/.test(id.split('?')[0] ?? '')) return null;
      const out = offlineSource(code);
      return out === code ? null : { code: out, map: null };
    },
    // The renderer build is not minified (readable stacks in crash reports); CesiumJS is, as it
    // would be from its own package, to keep the installer growth within decision 6's budget.
    async renderChunk(code, chunk) {
      if (!chunk.moduleIds.some((id) => /[\\/]@cesium[\\/]/.test(id))) return null;
      const out = await minify(chunk.fileName, code, { compress: true, mangle: true });
      if (out.errors.length > 0) {
        this.warn(`CesiumJS chunk not minified: ${out.errors.map((e) => e.message).join('; ')}`);
        return null;
      }
      return { code: out.code, map: null };
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
 * `__QUADRION_BUILD__`: when and from which commit this bundle was built, shown in Settings,
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
        exclude: [
          '@aio/schema',
          '@aio/brand',
          '@aio/ai',
          '@aio/project',
          '@aio/geo',
          '@aio/globe',
          '@aio/video',
        ],
      },
      rollupOptions: {
        input: {
          index: resolve(import.meta.dirname, 'src/main/index.ts'),
          // export utility process (utilityProcess.fork)
          exportWorker: resolve(import.meta.dirname, 'src/main/exports/worker.ts'),
          // local detection utility process (onnxruntime-node, BLD-10)
          inferenceWorker: resolve(import.meta.dirname, 'src/main/inference/workerMain.ts'),
        },
        // Native addons load from node_modules at runtime so each platform gets its own binary.
        // `original-fs` is Electron's fs without asar support (rollback copies app.asar as a file).
        external: ['electron', 'original-fs', /^node:/, /^@napi-rs\/keyring/, 'onnxruntime-node'],
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
    plugins: [react(), pdfjsAssets(), cesiumAssets(), cesiumOffline(), cspMeta()],
    define: { __QUADRION_BUILD__: JSON.stringify(buildStamp()) },
    resolve: { noExternal: bundled },
    build: {
      rollupOptions: {
        input: {
          index: resolve(import.meta.dirname, 'src/renderer/index.html'),
          // the issue register report, printed from an offscreen window
          report: resolve(import.meta.dirname, 'src/renderer/report.html'),
          // the house-format project report (BLD-8), printed the same way
          house: resolve(import.meta.dirname, 'src/renderer/house.html'),
          // the user guide on A4, printed by tools/guide/build-pdf.mjs
          guide: resolve(import.meta.dirname, 'src/renderer/guide.html'),
        },
      },
    },
  },
});
