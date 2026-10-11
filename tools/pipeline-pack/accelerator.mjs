/* eslint-disable no-console -- CLI output */
// The GPU add-on of the pipeline pack (plan "GPU acceleration for photo processing", WP2): an
// optional folder beside the pack, `<out>/pipeline-addon-cuda-<version>/`, holding CuPy and
// NVIDIA's CUDA runtime, runtime compiler and cuBLAS for photo processing on an NVIDIA card.
//
// It is made of ready-made wheels only, pinned by URL and SHA-256 in accelerator-lock.json:
// each is fetched into the build cache, refused unless its hash matches, and unpacked into
// `site/`. Nothing is compiled and no graphics card is needed to build it. `manifest.json`
// (`aio.pipeline-addon/1`) lists every file with its size and SHA-256, as the pack's does.
//
//   node tools/pipeline-pack/accelerator.mjs --out <runtime folder> [--cache <folder>]
//        [--python <python 3.13>] [--archive <folder>] [--force]
//
// --python compiles the Python files ahead of time (the add-on is read-only once installed);
// --archive also writes the file that reaches a computer into that folder, as
// pipeline-addon-cuda-<version>-win-x64.tar.gz, with the manifest as its first entry.
// The add-on never goes into the installer or the pipeline pack.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
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
import { defaultOutRoot, tarCommand } from './build.mjs';

export const LOCK_FILE = join(import.meta.dirname, 'accelerator-lock.json');
export const ADDON_SCHEMA = 'aio.pipeline-addon/1';
const HEX64 = /^[a-f0-9]{64}$/;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;

export class AddonBuildError extends Error {}

const quiet = () => undefined;

/** The lock as committed, or the reasons it cannot be used. */
export function readLock(path = LOCK_FILE) {
  const lock = JSON.parse(readFileSync(path, 'utf8'));
  const problems = lockProblems(lock);
  if (problems.length > 0) throw new AddonBuildError(`${basename(path)}: ${problems.join('; ')}`);
  return lock;
}

/** What is wrong with a lock document, in words (empty when it can be built). */
export function lockProblems(lock) {
  const out = [];
  if (lock?.schema !== 'accelerator-lock/1') out.push('schema is not accelerator-lock/1');
  if (lock?.kind !== 'gpu-cuda') out.push('kind is not gpu-cuda');
  if (typeof lock?.version !== 'string' || !VERSION.test(lock.version))
    out.push('version is missing or not a plain version');
  for (const key of ['packRange', 'python'])
    if (typeof lock?.[key] !== 'string' || lock[key] === '') out.push(`${key} is missing`);
  if (typeof lock?.runtime?.cuda !== 'string' || typeof lock?.runtime?.minDriver !== 'string')
    out.push('runtime.cuda and runtime.minDriver are missing');
  const platforms = Object.entries(lock?.platforms ?? {});
  if (platforms.length === 0) out.push('no platforms');
  for (const [platform, wheels] of platforms) {
    const names = new Set();
    for (const w of wheels) {
      const where = `${platform} ${String(w?.name)}`;
      if (!w?.name || !w?.version || !w?.license) out.push(`${where}: name, version or license`);
      if (names.has(w?.name)) out.push(`${where}: listed twice`);
      names.add(w?.name);
      if (!/^https:\/\/files\.pythonhosted\.org\/.+\.whl$/.test(w?.url ?? ''))
        out.push(`${where}: not a wheel on files.pythonhosted.org`);
      if (!HEX64.test(w?.sha256 ?? '')) out.push(`${where}: sha256`);
      if (!Number.isInteger(w?.size) || w.size <= 0) out.push(`${where}: size`);
    }
  }
  return out;
}

/** The add-on's folder name: what the app looks for beside `pipeline-pack-<version>`. */
export const addonName = (lock) => `pipeline-addon-cuda-${lock.version}`;

/** The name of the file that reaches a computer (`win32-x64` is written `win-x64`, as the pack's). */
export const archiveName = (lock, platform) =>
  `${addonName(lock)}-${platform.replace(/^win32-/, 'win-')}.tar.gz`;

function sha256File(path) {
  return new Promise((ok, bad) => {
    const h = createHash('sha256');
    createReadStream(path)
      .on('data', (c) => h.update(c))
      .on('end', () => ok(h.digest('hex')))
      .on('error', bad);
  });
}

/**
 * The platform's wheels in `cache`, each downloaded unless a copy with the pinned SHA-256 is
 * already there; a file whose hash differs from the pin is refused and not kept.
 */
export async function fetchWheels({ lock, platform, cache, fetchImpl = fetch, log = quiet }) {
  const wheels = lock.platforms[platform];
  if (!wheels) throw new AddonBuildError(`the add-on lock has no wheels for ${platform}`);
  const dir = join(cache, 'accelerator');
  mkdirSync(dir, { recursive: true });
  const out = [];
  for (const w of wheels) {
    const file = join(dir, `${w.sha256.slice(0, 16)}-${basename(new URL(w.url).pathname)}`);
    if (!existsSync(file) || (await sha256File(file)) !== w.sha256) {
      log(`  downloading ${w.url} (${(w.size / 1e6).toFixed(1)} MB)`);
      const res = await fetchImpl(w.url, {
        redirect: 'follow',
        headers: { 'User-Agent': 'quadrion-pipeline-pack' },
      });
      if (!res.ok) throw new AddonBuildError(`${w.url}: HTTP ${String(res.status)}`);
      const part = `${file}.part`;
      if (res.body) await pipeline(Readable.fromWeb(res.body), createWriteStream(part));
      else writeFileSync(part, Buffer.from(await res.arrayBuffer()));
      const got = await sha256File(part);
      if (got !== w.sha256) {
        rmSync(part, { force: true });
        throw new AddonBuildError(
          `${w.name} from ${w.url} has SHA-256 ${got}, expected ${w.sha256}`,
        );
      }
      renameSync(part, file);
    }
    out.push({ ...w, file });
  }
  return out;
}

function run(cmd, args, what) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true });
  if (r.error) throw new AddonBuildError(`${what}: ${cmd} could not start: ${r.error.message}`);
  if (r.status !== 0)
    throw new AddonBuildError(
      `${what} failed (exit ${String(r.status)}): ${(r.stderr || r.stdout || '').slice(-2000)}`,
    );
  return r.stdout ?? '';
}

/** Unpack one wheel (a zip) into `site`. The system's bsdtar reads zip; GNU tar does not. */
export function unpackWheel(wheel, site, tar = tarCommand()) {
  mkdirSync(site, { recursive: true });
  run(tar.cmd, [...tar.args, '-xf', wheel, '-C', site], `unpacking ${basename(wheel)}`);
}

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

/** Files a computer running the add-on never opens: import libraries and debug symbols. */
export const trimmed = (rel) => /\.(lib|pdb)$/i.test(rel);

/** The manifest of an add-on folder: the lock's identity and every file's size and SHA-256. */
export async function addonManifest({ dir, lock, platform, now = new Date() }) {
  const files = {};
  for (const f of walk(dir).sort()) {
    const rel = relative(dir, f).split('\\').join('/');
    if (rel === 'manifest.json') continue;
    files[rel] = { size: statSync(f).size, sha256: await sha256File(f) };
  }
  return {
    schema: ADDON_SCHEMA,
    kind: lock.kind,
    version: lock.version,
    packRange: lock.packRange,
    python: lock.python,
    platform,
    runtime: { cuda: lock.runtime.cuda, minDriver: lock.runtime.minDriver },
    createdAt: now.toISOString(),
    packages: lock.platforms[platform].map(({ name, version, license }) => ({
      name,
      version,
      license,
    })),
    files,
  };
}

/**
 * Build `<outRoot>/pipeline-addon-cuda-<version>/` and answer `{ dir, bytes, files, manifest }`.
 * `python`, when given, must be the lock's Python line: it compiles the Python files so the
 * installed, read-only add-on never needs to write them.
 */
export async function buildAddon({
  outRoot,
  cache,
  lock = readLock(),
  platform = `${process.platform}-${process.arch}`,
  fetchImpl = fetch,
  python,
  force = false,
  log = quiet,
  unpack = unpackWheel,
  now = new Date(),
}) {
  const dest = join(outRoot, addonName(lock));
  if (existsSync(dest) && !force)
    throw new AddonBuildError(`${dest} exists; pass --force to rebuild it`);
  const wheels = await fetchWheels({ lock, platform, cache, fetchImpl, log });
  const tmp = join(outRoot, `.${addonName(lock)}.tmp-${String(process.pid)}`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(join(tmp, 'site'), { recursive: true });
  try {
    for (const w of wheels) {
      log(`  unpacking ${w.name} ${w.version}`);
      unpack(w.file, join(tmp, 'site'));
    }
    for (const f of walk(tmp)) if (trimmed(relative(tmp, f))) rmSync(f, { force: true });
    if (python) {
      const version = run(
        python,
        ['-c', 'import sys; print("%d.%d" % sys.version_info[:2])'],
        'asking the Python for its version',
      ).trim();
      if (version !== lock.python)
        throw new AddonBuildError(
          `--python is Python ${version}; the add-on is for ${lock.python}`,
        );
      log(`  compiling the Python files with Python ${version}`);
      // hash-based and unchecked: valid whatever the install does to file times
      run(
        python,
        [
          '-I',
          '-m',
          'compileall',
          '-q',
          '-j',
          '0',
          '--invalidation-mode',
          'unchecked-hash',
          join(tmp, 'site'),
        ],
        'compiling the Python files',
      );
    } else {
      log('  no --python: the Python files are not compiled ahead of time');
    }
    const manifest = await addonManifest({ dir: tmp, lock, platform, now });
    writeFileSync(join(tmp, 'manifest.json'), `${JSON.stringify(manifest, null, 1)}\n`);
    const bytes = Object.values(manifest.files).reduce((s, f) => s + f.size, 0);
    rmSync(dest, { recursive: true, force: true });
    renameSync(tmp, dest);
    return { dir: dest, bytes, files: Object.keys(manifest.files).length, manifest };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * The archive that reaches a computer: one top folder, `manifest.json` as its first entry (the
 * app reads only the head of an archive to see what it is), then `site/`.
 */
export function archiveAddon(dir, archive, tar = tarCommand()) {
  const name = basename(dir);
  mkdirSync(dirname(resolve(archive)), { recursive: true });
  run(
    tar.cmd,
    [...tar.args, '-czf', archive, '-C', dirname(dir), `${name}/manifest.json`, `${name}/site`],
    `archiving ${name}`,
  );
  return statSync(archive).size;
}

async function main() {
  const { values } = parseArgs({
    options: {
      out: { type: 'string' },
      cache: { type: 'string' },
      python: { type: 'string' },
      archive: { type: 'string' },
      force: { type: 'boolean', default: false },
    },
  });
  const platform = `${process.platform}-${process.arch}`;
  const outRoot = values.out ? resolve(values.out) : defaultOutRoot(process.platform, process.env);
  if (!outRoot) throw new AddonBuildError('pass --out <runtime folder>');
  const cache = resolve(values.cache ?? join(outRoot, '.cache'));
  const lock = readLock();
  const t0 = Date.now();
  console.log(
    `GPU add-on ${lock.version} (${lock.kind}, CUDA ${lock.runtime.cuda}) for ${platform}`,
  );
  const built = await buildAddon({
    outRoot,
    cache,
    lock,
    platform,
    python: values.python,
    force: values.force,
    log: console.log,
  });
  console.log(
    `Done in ${String(Math.round((Date.now() - t0) / 1000))} s: ${String(built.files)} files, ${(built.bytes / 1e6).toFixed(0)} MB at ${built.dir}`,
  );
  if (values.archive) {
    const file = join(resolve(values.archive), archiveName(lock, platform));
    const size = archiveAddon(built.dir, file);
    console.log(`Archive: ${(size / 1e6).toFixed(0)} MB at ${file}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main().catch((e) => {
    const msg =
      e instanceof AddonBuildError
        ? e.message
        : e instanceof Error
          ? (e.stack ?? e.message)
          : String(e);
    process.stderr.write(`gpu add-on: ${msg}\n`);
    process.exitCode = 1;
  });
}
