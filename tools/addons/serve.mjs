#!/usr/bin/env node
/* eslint-disable no-console -- CLI output */
/**
 * A local test add-on address, so Settings, Models and detection, Add-ons can be tried before any
 * add-on is published: `pnpm addons:serve` builds the three add-ons into a scratch folder and serves
 * them with their `catalogue.json` on 127.0.0.1 only.
 *
 *   pnpm addons:serve [--port 4747] [--out <dir>] [--sam <folder>]
 *
 * - Road defects: the synthetic marker detector of the demos (`tools/demo/onnx-test-model.mjs`),
 *   operator-built with no trained weights. It finds the magenta markers of the change demo.
 * - Ground classifier: `classifier.json` with PDAL SMRF settings.
 * - Segmentation: the real MobileSAM files of an installed pipeline pack when one is found
 *   (`--sam`, `QUADRION_SAM_DIR`, else the newest `runtime/pipeline-pack-*\/models/sam` in the data
 *   folder named in the app's settings), otherwise the synthetic colour segmenter of the tests.
 *
 * The archives go to `--out` (default: `quadrion-addons-serve` in the system temp folder), never
 * into the repository. The port is `--port`, `QUADRION_ADDONS_PORT` or 4747. The address it prints
 * goes into `QUADRION_ADDONS_URL` or Settings, Models and detection, Add-ons, Add-on address. These
 * are test add-ons: nothing here is published.
 */
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { register } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildMarkerDetector } from '../demo/onnx-test-model.mjs';
import { mergeCatalogue, packAddon } from './build-addon.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO = resolve(HERE, '..', '..');
export const DEFAULT_PORT = 4747;
export const PATH_PREFIX = '/addons/';
const SAM_FILES = ['encoder.onnx', 'decoder.onnx', 'model.json'];

const semver = (v) => (v.match(/(\d+)\.(\d+)\.(\d+)/) ?? []).slice(1).map(Number);
const newer = (a, b) => {
  const [x, y] = [semver(a), semver(b)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
};

/** The app's data folder (Settings `dataRoot`), read from its settings file, or null. */
async function appDataRoot(env = process.env) {
  const appData = env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
  try {
    const s = JSON.parse(await readFile(join(appData, 'Quadrion AI', 'settings.json'), 'utf8'));
    return typeof s.dataRoot === 'string' && s.dataRoot ? s.dataRoot : null;
  } catch {
    return null;
  }
}

const hasSam = (dir) => SAM_FILES.every((f) => existsSync(join(dir, f)));

/**
 * The folder of real SAM-class files to build Segmentation from: `sam` when given (refused when it
 * lacks a file), else `QUADRION_SAM_DIR`, else the newest pipeline pack in the app's data folder
 * that carries `models/sam`. Answers `{ dir, from }` or null with why.
 */
export async function findSam({ sam, env = process.env, dataRoot } = {}) {
  const given = sam ?? env.QUADRION_SAM_DIR;
  if (given) {
    if (!hasSam(given))
      throw new Error(
        `${given} does not hold ${SAM_FILES.join(', ')}, so Segmentation cannot be built from it.`,
      );
    return { dir: given, from: given };
  }
  const root = dataRoot === undefined ? await appDataRoot(env) : dataRoot;
  if (!root) return { dir: null, why: 'the app settings name no data folder' };
  const runtime = join(root, 'runtime');
  const packs = (await readdir(runtime).catch(() => []))
    .filter((n) => /^pipeline-pack-\d+\.\d+\.\d+$/.test(n))
    .sort((a, b) => newer(b, a));
  for (const p of packs) {
    const dir = join(runtime, p, 'models', 'sam');
    if (hasSam(dir)) return { dir, from: `${p} in ${runtime}` };
  }
  return { dir: null, why: `no pipeline pack in ${runtime} carries models/sam` };
}

/**
 * The synthetic colour segmenter of the tests (`apps/desktop/src/main/inference/fixtures`), which
 * is TypeScript: plain node loads it with its type stripping and a resolve hook for the
 * extension-less import inside it (registered by `main`).
 */
async function colourSegmenter() {
  const url = pathToFileURL(
    join(REPO, 'apps', 'desktop', 'src', 'main', 'inference', 'fixtures', 'colourSegmenter.ts'),
  ).href;
  const m = await import(url);
  return m.colourSegmenterOnnx();
}

const CLASSIFIER = {
  schema: 'aio.point-classifier/1',
  method: 'smrf',
  smrf: { cell: 1, slope: 0.15, window: 18, threshold: 0.5, scalar: 1.25 },
};

/**
 * Build the three test add-ons into `outDir` and write its `catalogue.json` (archive URLs relative
 * to it). Answers the catalogue and where Segmentation came from.
 */
export async function buildTestAddons({ outDir, sam, env = process.env, dataRoot } = {}) {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  let catalogue = null;
  const add = async (info, files) => {
    const built = await packAddon({ info, files, outDir });
    catalogue = mergeCatalogue(catalogue, built.entry());
    return built;
  };

  const det = buildMarkerDetector();
  await add(
    {
      id: 'road-defects',
      name: 'Road defects',
      version: '1.0.0',
      kind: 'detector',
      licence: 'MIT',
      source: 'Quadrion test detector (tools/demo/onnx-test-model.mjs), no trained weights',
      description: 'Test add-on: the synthetic marker detector of the demos, not a road model.',
    },
    [
      { path: 'model.onnx', data: det.onnx },
      { path: 'model.json', data: Buffer.from(`${JSON.stringify(det.card, null, 2)}\n`) },
    ],
  );

  await add(
    {
      id: 'ground-classifier',
      name: 'Ground classifier',
      version: '1.0.0',
      kind: 'point-classifier',
      licence: 'MIT',
      source: 'PDAL SMRF settings (https://pdal.io/en/latest/stages/filters.smrf.html)',
      description: 'Test add-on: PDAL SMRF settings for marking ground points.',
    },
    [{ path: 'classifier.json', data: Buffer.from(`${JSON.stringify(CLASSIFIER, null, 2)}\n`) }],
  );

  const real = await findSam({ sam, env, dataRoot });
  let segmentation;
  if (real.dir) {
    const card = JSON.parse(await readFile(join(real.dir, 'model.json'), 'utf8'));
    await add(
      {
        id: 'segmentation',
        name: 'Segmentation',
        version: '1.0.0',
        kind: 'segmenter',
        licence: String(card.licence ?? card.license ?? 'Apache-2.0'),
        source: String(card.source ?? 'MobileSAM from the processing tools'),
        description: `Test add-on: the ${String(card.name ?? 'MobileSAM')} files of the processing tools.`,
      },
      SAM_FILES.map((f) => ({ path: f, file: join(real.dir, f) })),
    );
    segmentation = { real: true, from: real.from };
  } else {
    const m = await colourSegmenter();
    await add(
      {
        id: 'segmentation',
        name: 'Segmentation',
        version: '1.0.0',
        kind: 'segmenter',
        licence: 'MIT',
        source:
          'Quadrion test segmenter (apps/desktop/src/main/inference/fixtures), no trained weights',
        description: 'Test add-on: the synthetic colour segmenter of the tests, not SAM.',
      },
      [
        { path: 'encoder.onnx', data: Buffer.from(m.encoder) },
        { path: 'decoder.onnx', data: Buffer.from(m.decoder) },
        { path: 'model.json', data: Buffer.from(`${JSON.stringify(m.card, null, 2)}\n`) },
      ],
    );
    segmentation = { real: false, why: real.why };
  }
  await writeFile(join(outDir, 'catalogue.json'), `${JSON.stringify(catalogue, null, 2)}\n`);
  return { catalogue, segmentation };
}

/**
 * Serve `dir` under `/addons/` on 127.0.0.1 (never another interface). `port` 0 takes a free one.
 * Answers `{ url, close() }`, `url` being the add-on address (ending in `/addons/`).
 */
export function serveAddons({ dir, port = DEFAULT_PORT, log = () => undefined }) {
  const server = createServer(async (req, res) => {
    const path = decodeURIComponent((req.url ?? '/').split('?')[0]);
    const name = path.startsWith(PATH_PREFIX) ? path.slice(PATH_PREFIX.length) : '';
    // one flat folder: no sub-paths, no dot files
    if (!name || name !== basename(name) || name.startsWith('.') || req.method !== 'GET') {
      res.writeHead(404).end();
      return;
    }
    const file = join(dir, name);
    const s = await stat(file).catch(() => null);
    if (!s?.isFile()) {
      res.writeHead(404).end();
      return;
    }
    log(`GET ${path}`);
    res.writeHead(200, {
      'content-length': String(s.size),
      'content-type': name.endsWith('.json') ? 'application/json' : 'application/octet-stream',
    });
    createReadStream(file).pipe(res);
  });
  return new Promise((resolveStart, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      resolveStart({
        url: `http://127.0.0.1:${String(addr.port)}${PATH_PREFIX}`,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
            server.closeAllConnections?.();
          }),
      });
    });
  });
}

function args(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port' || a === '--out' || a === '--sam') o[a.slice(2)] = argv[++i];
    else if (a === '--help' || a === '-h') o.help = true;
    else throw new Error(`Unknown option ${a}. Try --help.`);
  }
  return o;
}

async function main() {
  const a = args(process.argv.slice(2));
  if (a.help) {
    console.log(
      'pnpm addons:serve [--port 4747] [--out <dir>] [--sam <folder with encoder.onnx, decoder.onnx, model.json>]',
    );
    return;
  }
  // the colour segmenter fixture imports './onnx' without an extension: resolve it to the .ts file
  register(
    'data:text/javascript,' +
      encodeURIComponent(
        "export async function resolve(s, c, next) { try { return await next(s, c); } catch (e) { if ((s.startsWith('./') || s.startsWith('../')) && !/\\.[a-z]+$/i.test(s) && c.parentURL?.endsWith('.ts')) return next(s + '.ts', c); throw e; } }",
      ),
  );
  const port = Number(a.port ?? process.env.QUADRION_ADDONS_PORT ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error(`${a.port} is not a port.`);
  const outDir = resolve(a.out ?? join(tmpdir(), 'quadrion-addons-serve'));
  console.log(`Building the test add-ons into ${outDir} ...`);
  const { catalogue, segmentation } = await buildTestAddons({ outDir, sam: a.sam });
  const size = (b) =>
    b < 1024 * 1024 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`;
  for (const e of catalogue.addons)
    console.log(
      `  ${e.manifest.name} ${e.manifest.version}: ${size(e.archive.sizeBytes)}, sha256 ${e.archive.sha256.slice(0, 12)}...`,
    );
  console.log(
    segmentation.real
      ? `  Segmentation is the real MobileSAM model from ${segmentation.from}.`
      : `  Segmentation is the synthetic test segmenter: ${segmentation.why}.`,
  );
  const { url } = await serveAddons({ dir: outDir, port, log: (l) => console.log(`  ${l}`) });
  console.log('');
  console.log(`Add-on address: ${url}`);
  console.log(
    'Paste it into Settings, Models and detection, Add-ons, Add-on address, or start the app with',
  );
  console.log(`  $env:QUADRION_ADDONS_URL = '${url}'; pnpm dev`);
  console.log('Only this computer can reach it. Stop with Ctrl+C.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
