#!/usr/bin/env node
// Build the pipeline pack: python-build-standalone CPython 3.13 plus the uv-locked wheels and
// aio_pipelines, as a folder outside the repository and the installer, with a manifest of every
// file's size and SHA-256 (the pack is signed file by file in CI and verified by the app later).
//
//   node tools/pipeline-pack/build.mjs [--out "E:/Stratlas Data/runtime"] [--force]
//
// Output: <out>/pipeline-pack-<version>/{python/, manifest.json}, built in a temp folder next to
// it and renamed into place when complete. The app finds the newest pack in
// <data folder>/runtime/. Builds for the host platform (Windows x64, macOS arm64 or x64).
// Online: downloads CPython once into <out>/.cache and wheels through uv's cache.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';

export const PBS_RELEASE = '20260924';
export const CPYTHON = '3.13.15';
const PBS_BASE = `https://github.com/astral-sh/python-build-standalone/releases/download/${PBS_RELEASE}`;

const TARGETS = {
  'win32-x64': { triple: 'x86_64-pc-windows-msvc', exe: 'python/python.exe' },
  'darwin-arm64': { triple: 'aarch64-apple-darwin', exe: 'python/bin/python3' },
  'darwin-x64': { triple: 'x86_64-apple-darwin', exe: 'python/bin/python3' },
};

const repo = resolve(import.meta.dirname, '..', '..');
const pyDir = join(repo, 'python');

const say = (msg) => process.stdout.write(`${msg}\n`);

/** A build step that failed; its message is shown as is. */
export class BuildError extends Error {}

/** Stop the build. Throws rather than exiting, so the temp folder is always cleaned up. */
function fail(msg) {
  throw new BuildError(msg);
}

const TEMP_DIR = /^\.pipeline-pack-.+\.tmp-(\d+)$/;

/** True while a process with this id runs (signal 0 only checks). */
function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === 'EPERM';
  }
}

/**
 * Temp folders earlier builds left in the output folder (killed or crashed before cleaning up):
 * those whose process no longer runs. A build still running elsewhere keeps its folder.
 */
export function staleTempDirs(names, alive = processAlive) {
  return names.filter((n) => {
    const m = TEMP_DIR.exec(n);
    return m !== null && !alive(Number(m[1]));
  });
}

/**
 * Run `build(tmp)` in a fresh temp folder in `outRoot`, after removing stale ones, and remove the
 * temp folder afterwards whatever happens (a successful build has renamed it into place).
 */
export async function withTempDir(outRoot, version, build, opts = {}) {
  const { pid = process.pid, alive = processAlive, log = say } = opts;
  mkdirSync(outRoot, { recursive: true });
  for (const n of staleTempDirs(readdirSync(outRoot), alive)) {
    log(`  removing ${n}, left by an earlier build that did not finish`);
    rmSync(join(outRoot, n), { recursive: true, force: true });
  }
  const tmp = join(outRoot, `.pipeline-pack-${version}.tmp-${String(pid)}`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  try {
    return await build(tmp);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Where packs go without --out: `<STRATLAS_DATA>/runtime`, else the Windows workstation's data
 * drive. Other systems (a macOS CI runner) have no default and must say where.
 */
export function defaultOutRoot(platform, env) {
  if (env.STRATLAS_DATA) return join(env.STRATLAS_DATA, 'runtime');
  return platform === 'win32' ? 'E:/Stratlas Data/runtime' : null;
}

/** The aio_pipelines version from python/pyproject.toml. */
export function packageVersion(toml) {
  const m = /^\[project\][\s\S]*?^version\s*=\s*"([^"]+)"/m.exec(toml);
  if (!m?.[1]) throw new Error('python/pyproject.toml has no [project] version');
  return m[1];
}

/** The expected SHA-256 for a file name in a SHA256SUMS listing. */
export function expectedSha(sums, name) {
  for (const line of sums.split(/\r?\n/)) {
    const [hash, file] = line.trim().split(/\s+\*?/);
    if (file === name && hash && /^[a-f0-9]{64}$/.test(hash)) return hash;
  }
  return null;
}

function sha256File(path) {
  return new Promise((ok, bad) => {
    const h = createHash('sha256');
    createReadStream(path)
      .on('data', (c) => h.update(c))
      .on('end', () => ok(h.digest('hex')))
      .on('error', bad);
  });
}

async function download(url, dest) {
  say(`  downloading ${url}`);
  const res = await fetch(url, {
    redirect: 'follow',
    headers: { 'User-Agent': 'stratlas-pipeline-pack' },
  });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(`${dest}.part`, buf);
  renameSync(`${dest}.part`, dest);
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    env: { ...process.env, UV_LINK_MODE: 'copy' },
    stdio: opts.capture ? 'pipe' : 'inherit',
    encoding: 'utf8',
    ...opts,
  });
  if (r.error) fail(`${cmd} could not start: ${r.error.message}`);
  if (r.status !== 0)
    fail(
      `${cmd} ${args.join(' ')} failed (exit ${r.status})${opts.capture ? `\n${r.stderr}` : ''}`,
    );
  return r.stdout ?? '';
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

async function main() {
  const { values } = parseArgs({
    options: {
      out: { type: 'string' },
      force: { type: 'boolean', default: false },
      'keep-tests': { type: 'boolean', default: false },
    },
  });
  const platform = `${process.platform}-${process.arch}`;
  const target = TARGETS[platform];
  if (!target) fail(`no python-build-standalone target for ${platform}`);
  const out = values.out ?? defaultOutRoot(process.platform, process.env);
  if (!out) fail('pass --out <folder> or set STRATLAS_DATA (no default data folder on this OS)');
  const outRoot = resolve(out);
  const version = packageVersion(readFileSync(join(pyDir, 'pyproject.toml'), 'utf8'));
  const dest = join(outRoot, `pipeline-pack-${version}`);
  if (existsSync(dest) && !values.force) fail(`${dest} exists; pass --force to rebuild it`);
  const cache = join(outRoot, '.cache');
  mkdirSync(cache, { recursive: true });
  const t0 = Date.now();
  say(`Building pipeline pack ${version} for ${platform} into ${dest}`);

  // 1. CPython from python-build-standalone, checked against the release's SHA256SUMS
  const asset = `cpython-${CPYTHON}+${PBS_RELEASE}-${target.triple}-install_only.tar.gz`;
  const tgz = join(cache, asset);
  const sumsFile = join(cache, `SHA256SUMS-${PBS_RELEASE}`);
  if (!existsSync(sumsFile)) await download(`${PBS_BASE}/SHA256SUMS`, sumsFile);
  const want = expectedSha(readFileSync(sumsFile, 'utf8'), asset);
  if (!want) fail(`${asset} is not listed in SHA256SUMS for ${PBS_RELEASE}`);
  if (!existsSync(tgz)) await download(`${PBS_BASE}/${encodeURIComponent(asset)}`, tgz);
  const got = await sha256File(tgz);
  if (got !== want) {
    rmSync(tgz, { force: true });
    fail(`${asset} has SHA-256 ${got}, expected ${want}; removed it, run again`);
  }
  say(`  CPython ${CPYTHON} (${PBS_RELEASE}) verified`);

  await withTempDir(outRoot, version, async (tmp) => {
    run('tar', ['-xzf', tgz, '-C', tmp]);
    const python = join(tmp, ...target.exe.split('/'));
    if (!existsSync(python)) fail(`the archive has no ${target.exe}`);

    // 2. The locked wheels (hash-checked, binary only) and the aio_pipelines wheel
    const reqs = join(tmp, 'requirements.txt');
    run(
      'uv',
      [
        'export',
        '--frozen',
        '--no-dev',
        '--no-emit-project',
        '--format',
        'requirements-txt',
        '--output-file',
        reqs,
      ],
      { cwd: pyDir, capture: true },
    );
    run('uv', [
      'pip',
      'install',
      '--python',
      python,
      '--break-system-packages',
      '--require-hashes',
      '--no-deps',
      '--only-binary',
      ':all:',
      '-r',
      reqs,
    ]);
    const wheels = join(cache, `wheel-${version}`);
    rmSync(wheels, { recursive: true, force: true });
    run('uv', ['build', '--wheel', '--out-dir', wheels], { cwd: pyDir, capture: true });
    const wheel = readdirSync(wheels).find((f) => f.endsWith('.whl'));
    if (!wheel) fail('uv build made no wheel');
    run('uv', [
      'pip',
      'install',
      '--python',
      python,
      '--break-system-packages',
      '--no-deps',
      join(wheels, wheel),
    ]);
    rmSync(reqs, { force: true });

    // 3. Trim what the pack never runs, then precompile so a signed, read-only pack never writes .pyc
    const lib =
      process.platform === 'win32'
        ? join(tmp, 'python', 'Lib')
        : join(tmp, 'python', 'lib', `python${CPYTHON.split('.').slice(0, 2).join('.')}`);
    if (!values['keep-tests']) {
      for (const d of ['test', 'idlelib', 'tkinter', 'turtledemo', 'ensurepip'])
        rmSync(join(lib, d), { recursive: true, force: true });
    }
    run(python, ['-I', '-m', 'compileall', '-q', '-j', '0', lib], { capture: true });

    // 4. Smoke test through the same entry point the app uses
    const ver = JSON.parse(
      run(python, ['-I', '-m', 'aio_pipelines', '--version'], { capture: true }),
    );
    if (ver.version !== version) fail(`the pack reports ${ver.version}, expected ${version}`);
    const pipelines = JSON.parse(
      run(python, ['-I', '-m', 'aio_pipelines', '--list'], { capture: true }),
    );
    const libs = run(
      python,
      [
        '-I',
        '-c',
        'import numpy, scipy, rasterio, trimesh, skimage, PIL, yaml, rtree, shapely, shapefile; print(rasterio.__gdal_version__)',
      ],
      { capture: true },
    ).trim();
    say(`  ${pipelines.length} pipelines; GDAL ${libs}`);

    // 5. Manifest with every file's size and hash
    const files = {};
    for (const f of walk(tmp).sort()) {
      const rel = relative(tmp, f).split('\\').join('/');
      files[rel] = { size: statSync(f).size, sha256: await sha256File(f) };
    }
    const manifest = {
      schema: 'aio.pipeline-pack/1',
      version,
      protocol: ver.protocol,
      appRange: ver.appRange,
      python: { version: CPYTHON, build: PBS_RELEASE, executable: target.exe },
      platform,
      createdAt: new Date().toISOString(),
      pipelines,
      files,
    };
    writeFileSync(join(tmp, 'manifest.json'), `${JSON.stringify(manifest, null, 1)}\n`);

    rmSync(dest, { recursive: true, force: true });
    renameSync(tmp, dest);
    const bytes = Object.values(files).reduce((a, f) => a + f.size, 0);
    say(
      `Done in ${Math.round((Date.now() - t0) / 1000)} s: ${Object.keys(files).length} files, ${(bytes / 2 ** 20).toFixed(0)} MB at ${dest}`,
    );
  });
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main().catch((e) => {
    const msg =
      e instanceof BuildError ? e.message : e instanceof Error ? (e.stack ?? e.message) : String(e);
    process.stderr.write(`pipeline-pack: ${msg}\n`);
    process.exitCode = 1;
  });
}
