// The Analytics pack: llama.cpp `llama-server`, the Qwen2.5-VL model and its mmproj, the shipped
// detectors and a manifest (`aio.analytics-pack/1`, packages/schema/src/analytics.ts). It installs
// from an archive like the pipeline pack. Every download is pinned in lock.json by URL, size and
// SHA-256 and refused when the hash differs; the app downloads nothing.
//
//   node tools/analytics-pack/build.mjs --out <dir> [--cache <dir>] [--no-model]
//
// Writes <out>/analytics-pack-<version>/{llama/, model/, licences/, detectors/<assetType>/<id>/, manifest.json}
// and <out>/analytics-pack-<version>-win-x64.tar.gz (manifest.json is the first entry). --no-model
// leaves model/ out and writes manifest.model.sha256 as "none": a local check build, not for install.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  cpSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parseArgs } from 'node:util';
import { BuildError, tarCommand } from '../pipeline-pack/build.mjs';

const here = import.meta.dirname;
export const APP_RANGE = '>=0.25.0 <2.0.0';
export const PLATFORM = 'win-x64';
export const PACK_PREFIX = 'analytics-pack';

export function sha256File(path) {
  return new Promise((ok, fail) => {
    const h = createHash('sha256');
    createReadStream(path)
      .on('data', (c) => h.update(c))
      .on('error', fail)
      .on('end', () => ok(h.digest('hex')));
  });
}

/** The default download: follows redirects and streams to `dest` (the model is 4.7 GB). */
export async function fetchToFile(url, dest) {
  const res = await fetch(url, {
    redirect: 'follow',
    headers: { 'User-Agent': 'aio-analytics-pack' },
  });
  if (!res.ok || !res.body) throw new BuildError(`${url}: HTTP ${String(res.status)}`);
  mkdirSync(dirname(dest), { recursive: true });
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
}

/**
 * A pinned file in the cache (`<cache>/<sha256>-<name>`): reused when it is there and matches,
 * else downloaded with `fetchTo(url, dest)`. A download whose SHA-256 differs from the pin is
 * deleted and refused. Answers the cached path.
 */
export async function pinnedDownload({ pin, cache, fetchTo = fetchToFile, log = () => undefined }) {
  mkdirSync(cache, { recursive: true });
  const cached = join(cache, `${pin.sha256}-${basename(new URL(pin.url).pathname)}`);
  if (existsSync(cached) && (await sha256File(cached)) === pin.sha256) return cached;
  log(`  downloading ${pin.url}`);
  const part = `${cached}.part`;
  rmSync(part, { force: true });
  await fetchTo(pin.url, part);
  const got = await sha256File(part);
  if (got !== pin.sha256) {
    rmSync(part, { force: true });
    throw new BuildError(`${pin.url} has SHA-256 ${got}, expected ${pin.sha256}`);
  }
  renameSync(part, cached);
  return cached;
}

/** Unpack a zip into `dest` with the system tar (bsdtar reads zips). */
export function unzipWithTar(zip, dest) {
  mkdirSync(dest, { recursive: true });
  const { cmd, args } = tarCommand();
  const r = spawnSync(cmd, [...args, '-xf', zip, '-C', dest], {
    stdio: 'inherit',
    windowsHide: true,
  });
  if (r.status !== 0) throw new BuildError(`could not unpack ${zip}`);
}

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.isFile()) out.push(p);
  }
  return out.sort();
}

/** Shipped detectors: `<dir>/<assetType>/<id>/detector.json`. */
function listDetectors(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const t of readdirSync(dir, { withFileTypes: true })) {
    if (!t.isDirectory()) continue;
    for (const d of readdirSync(join(dir, t.name), { withFileTypes: true })) {
      const file = join(dir, t.name, d.name, 'detector.json');
      if (!d.isDirectory() || !existsSync(file)) continue;
      const j = JSON.parse(readFileSync(file, 'utf8'));
      out.push({ assetType: t.name, id: d.name, version: j.version, status: j.status });
    }
  }
  return out;
}

/** The tar call that puts manifest.json first, then everything else in the folder. */
function makeTar(outRoot, packName, tgz) {
  const { cmd, args } = tarCommand();
  const rest = readdirSync(join(outRoot, packName)).filter((n) => n !== 'manifest.json');
  const r = spawnSync(
    cmd,
    [
      ...args,
      '-czf',
      tgz,
      '-C',
      outRoot,
      `${packName}/manifest.json`,
      ...rest.map((n) => `${packName}/${n}`),
    ],
    { stdio: 'inherit', windowsHide: true },
  );
  if (r.status !== 0) throw new BuildError('tar failed');
}

export async function buildAnalyticsPack({
  out,
  cache,
  noModel = false,
  lock = JSON.parse(readFileSync(join(here, 'lock.json'), 'utf8')),
  version = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8')).version,
  detectorsDir = join(here, 'detectors'),
  fetchTo = fetchToFile,
  unzip = unzipWithTar,
  archive = true,
  createdAt = new Date().toISOString(),
  log = () => undefined,
}) {
  const name = `${PACK_PREFIX}-${version}`;
  const packDir = join(resolve(out), name);
  rmSync(packDir, { recursive: true, force: true });
  mkdirSync(packDir, { recursive: true });
  const cacheDir = resolve(cache ?? join(out, '.cache'));

  // Runtime: both zips unpack into llama/ (the cudart DLLs sit beside llama-server.exe).
  for (const asset of lock.runtime.assets) {
    const zip = await pinnedDownload({ pin: asset, cache: cacheDir, fetchTo, log });
    unzip(zip, join(packDir, 'llama'));
  }
  if (!existsSync(join(packDir, lock.runtime.executable)))
    throw new BuildError(`${lock.runtime.executable} is not in the runtime zips`);

  const m = lock.model;
  if (!noModel) {
    for (const f of [m.gguf, m.mmproj]) {
      const src = await pinnedDownload({ pin: f, cache: cacheDir, fetchTo, log });
      mkdirSync(dirname(join(packDir, f.file)), { recursive: true });
      copyFileSync(src, join(packDir, f.file));
    }
  }

  // Licence texts of the two components, pinned like the rest (also in a --no-model build).
  for (const f of lock.licences) {
    const src = await pinnedDownload({ pin: f, cache: cacheDir, fetchTo, log });
    mkdirSync(dirname(join(packDir, f.file)), { recursive: true });
    copyFileSync(src, join(packDir, f.file));
  }

  const detectors = listDetectors(detectorsDir);
  for (const d of detectors) {
    cpSync(join(detectorsDir, d.assetType, d.id), join(packDir, 'detectors', d.assetType, d.id), {
      recursive: true,
    });
  }

  const files = {};
  for (const f of walk(packDir)) {
    files[relative(packDir, f).replaceAll('\\', '/')] = {
      size: statSync(f).size,
      sha256: await sha256File(f),
    };
  }
  const manifest = {
    schema: 'aio.analytics-pack/1',
    version,
    appRange: APP_RANGE,
    platform: PLATFORM,
    createdAt,
    runtime: {
      name: lock.runtime.name,
      release: lock.runtime.release,
      executable: lock.runtime.executable,
    },
    model: {
      id: m.id,
      licence: m.licence,
      gguf: m.gguf.file,
      mmproj: m.mmproj.file,
      sha256: noModel ? 'none' : m.gguf.sha256,
    },
    detectors,
    files,
  };
  writeFileSync(join(packDir, 'manifest.json'), `${JSON.stringify(manifest, null, 1)}\n`);

  let tgz;
  if (archive) {
    tgz = join(resolve(out), `${name}-${PLATFORM}.tar.gz`);
    rmSync(tgz, { force: true });
    makeTar(resolve(out), name, tgz);
  }
  return { packDir, manifest, archive: tgz };
}

async function main() {
  const { values } = parseArgs({
    options: {
      out: { type: 'string' },
      cache: { type: 'string' },
      'no-model': { type: 'boolean' },
    },
  });
  if (!values.out)
    throw new BuildError('Usage: build.mjs --out <dir> [--cache <dir>] [--no-model]');
  const r = await buildAnalyticsPack({
    out: values.out,
    cache: values.cache,
    noModel: values['no-model'],
    log: (s) => process.stdout.write(`${s}\n`),
  });
  process.stdout.write(`${r.packDir}\n${r.archive}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main().catch((e) => {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  });
}
