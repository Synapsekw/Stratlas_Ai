#!/usr/bin/env node
// PDAL and untwine for the pipeline pack: conda-forge's prebuilt `libpdal-core` (the `pdal`
// command-line tool with GDAL, PROJ and GEOS, no plugins) and `untwine` (the out-of-core COPC
// builder, GPL-3.0-or-later), installed by micromamba from an explicit lock and pruned to what the
// tools run: the programs, their shared libraries and the PROJ and GDAL data.
// aio_pipelines/pointcloud.py finds it at <pack>/tools/pdal (Library/bin/pdal.exe on Windows,
// bin/pdal on macOS) and points it at the data (pdal_env). Founder decision of 8 Oct 2026: no
// source build; conda-forge's binaries as they are, licences listed in the notices.
//
//   node tools/pipeline-pack/pdal.mjs --out <folder>   PDAL and untwine for this machine into <folder>
//                                                      (development: AIO_PDAL and AIO_UNTWINE, printed at the end)
//   node tools/pipeline-pack/pdal.mjs --lock           re-solve pdal-lock.json (online)
//
// build.mjs calls installPdal(). Downloads: micromamba once (a single static binary, SHA-256
// pinned below) and the locked packages (SHA-256 in the lock) into a cache in the temp folder.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

export const LOCK_FILE = new URL('./pdal-lock.json', import.meta.url);

/** The conda spec the lock is solved for. */
export const PDAL_SPEC = 'libpdal-core==2.10.2 untwine';

/** micromamba, a single static binary per platform (github.com/mamba-org/micromamba-releases). */
export const MICROMAMBA = {
  version: '2.9.0-0',
  assets: {
    'win32-x64': {
      name: 'micromamba-win-64',
      sha256: 'a6d804394b2418991c4e29562853eaace2f2ce9d9da661a98e74e02e8dbb44b0',
    },
    'darwin-arm64': {
      name: 'micromamba-osx-arm64',
      sha256: 'ec2a072f028e1a7cf20f3e2e74d5a8127cf5a5f27636375b5359811565f4e5be',
    },
    'darwin-x64': {
      name: 'micromamba-osx-64',
      sha256: '1e71054bb3ac9a076e21f7ec48acfef536f9b3f1408f371a942784bf5ef83d8a',
    },
  },
};

/** Pack platform to conda subdir, and the oldest macOS the packages may need. */
export const PLATFORMS = {
  'win32-x64': { subdir: 'win-64' },
  'darwin-arm64': { subdir: 'osx-arm64', osx: '14.0' },
  'darwin-x64': { subdir: 'osx-64', osx: '13.0' },
};

/** The drivers our pipelines use (pointcloud, change, photo, opf, volumetric, modelfit, cleanup). */
export const DRIVERS = [
  'readers.las',
  'readers.copc',
  'writers.las',
  'writers.copc',
  'writers.gdal',
  'filters.smrf',
  'filters.reprojection',
  'filters.crop',
  'filters.sample',
  'filters.range',
  'filters.assign',
  'filters.outlier',
  'filters.elm',
];

const say = (msg) => process.stdout.write(`${msg}\n`);

/** The conda explicit file for a list of locked packages (`url#sha256`). */
export function explicitSpec(packages) {
  return ['@EXPLICIT', ...packages.map((p) => `${p.url}#${p.sha256}`), ''].join('\n');
}

/** A lock's packages for a pack platform (PDAL's unless another lock is given). */
export function lockedPackages(
  platform,
  lock = JSON.parse(readFileSync(LOCK_FILE, 'utf8')),
  label = 'pdal-lock.json',
) {
  const sub = PLATFORMS[platform]?.subdir;
  const list = sub ? lock.platforms?.[sub] : undefined;
  if (!Array.isArray(list) || list.length === 0)
    throw new Error(`${label} has no packages for ${platform}`);
  return list;
}

/**
 * Whether a file of the installed environment (path relative to its prefix, `/` separated) goes
 * into the pack, on Windows: the program, the DLLs (the conda runtime DLLs at the prefix's root are
 * moved next to it) and the PROJ and GDAL data. Everything else (headers, import libraries, other
 * programs, documentation, CMake files, debug symbols) stays out.
 */
export function keepWindows(rel) {
  const r = rel.toLowerCase();
  if (r === 'library/bin/pdal.exe') return 'Library/bin/pdal.exe';
  if (r === 'library/bin/untwine.exe') return 'Library/bin/untwine.exe';
  if (/^library\/share\/(proj|gdal)\//.test(r)) return rel;
  const dll = /^(library\/bin\/)?([^/]+\.dll)$/.exec(r);
  if (dll && !SKIP_DLL.test(dll[2])) return `Library/bin/${basename(rel)}`;
  return null;
}

/** DLLs nothing loads: SpatiaLite's SQLite extension module and PDAL's test plugin. */
const SKIP_DLL = /^(mod_spatialite\.dll|libpdal_plugin_.*\.dll)$/;

/** The dependencies `otool -L` lists that live in the environment (by file name). */
export function otoolLibs(text) {
  const out = [];
  for (const line of text.split('\n').slice(1)) {
    const m = /^\s*(\S+)\s+\(/.exec(line);
    if (!m) continue;
    const p = m[1];
    if (p.startsWith('@rpath/') || p.startsWith('@loader_path/')) out.push(basename(p));
  }
  return out;
}

export function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', stdio: 'pipe', ...opts });
  if (r.error) throw new Error(`${cmd} could not start: ${r.error.message}`);
  if (r.status !== 0)
    throw new Error(`${basename(cmd)} ${args.join(' ')} failed (exit ${r.status})\n${r.stderr}`);
  return r.stdout;
}

/**
 * macOS: the programs and the dylibs they load, followed through `otool -L` from bin/<program>,
 * each copied as a plain file under the name it is loaded by (conda's symlinks are left behind),
 * and the data folders of share/.
 */
function copyMac(prefix, dest, { programs, share = [] }) {
  mkdirSync(join(dest, 'bin'), { recursive: true });
  mkdirSync(join(dest, 'lib'), { recursive: true });
  const todo = [];
  for (const program of programs) {
    const exe = join(dest, 'bin', program);
    copyFileSync(realpathSync(join(prefix, 'bin', program)), exe);
    chmodSync(exe, 0o755);
    todo.push(join(prefix, 'bin', program));
  }
  const seen = new Set();
  while (todo.length > 0) {
    const file = todo.pop();
    for (const name of otoolLibs(run('otool', ['-L', file]))) {
      if (seen.has(name)) continue;
      seen.add(name);
      const src = join(prefix, 'lib', name);
      if (!existsSync(src))
        throw new Error(`${basename(file)} loads ${name}, not in ${prefix}/lib`);
      const real = realpathSync(src);
      copyFileSync(real, join(dest, 'lib', name));
      chmodSync(join(dest, 'lib', name), 0o755);
      todo.push(real);
    }
  }
  for (const d of share)
    cpSync(join(prefix, 'share', d), join(dest, 'share', d), {
      recursive: true,
      dereference: true,
    });
  return seen.size + programs.length;
}

/** Every file below `dir`, relative to it with `/` separators. */
export function walk(dir, base = dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, base));
    else
      out.push(
        p
          .slice(base.length + 1)
          .split('\\')
          .join('/'),
      );
  }
  return out;
}

function copyWindows(prefix, dest, keep) {
  let n = 0;
  for (const rel of walk(prefix)) {
    const to = keep(rel);
    if (!to) continue;
    mkdirSync(dirname(join(dest, to)), { recursive: true });
    copyFileSync(join(prefix, rel), join(dest, to));
    n++;
  }
  return n;
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** The micromamba binary for this platform, downloaded once into `cache` and checked. */
export async function ensureMicromamba(cache, platform, log = say) {
  const asset = MICROMAMBA.assets[platform];
  if (!asset) throw new Error(`no micromamba for ${platform}`);
  const exe = join(
    cache,
    `${asset.name}-${MICROMAMBA.version}${platform.startsWith('win32') ? '.exe' : ''}`,
  );
  if (existsSync(exe) && sha256(exe) === asset.sha256) return exe;
  mkdirSync(cache, { recursive: true });
  const url = `https://github.com/mamba-org/micromamba-releases/releases/download/${MICROMAMBA.version}/${asset.name}`;
  log(`  downloading ${url}`);
  const res = await fetch(url, {
    redirect: 'follow',
    headers: { 'User-Agent': 'quadrion-pipeline-pack' },
  });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const got = createHash('sha256').update(buf).digest('hex');
  if (got !== asset.sha256)
    throw new Error(`${asset.name} has SHA-256 ${got}, expected ${asset.sha256}`);
  writeFileSync(`${exe}.part`, buf);
  renameSync(`${exe}.part`, exe);
  if (!platform.startsWith('win32')) chmodSync(exe, 0o755);
  return exe;
}

/**
 * micromamba's root (its package cache): short, in the temp folder, because a package's deepest
 * header paths pass Windows' 260 characters below a long folder. Kept between builds;
 * `QUADRION_CONDA_ROOT` puts it elsewhere (CI caches it).
 */
export const condaRoot = () => process.env.QUADRION_CONDA_ROOT || join(tmpdir(), 'quadrion-conda');

function micromambaEnv(platform) {
  const env = { ...process.env, MAMBA_ROOT_PREFIX: condaRoot(), MAMBA_NO_BANNER: '1' };
  delete env.CONDA_PREFIX;
  const osx = PLATFORMS[platform]?.osx;
  if (osx) env.CONDA_OVERRIDE_OSX = osx;
  return env;
}

/** Each package's licence files from micromamba's cache into `dest/licenses/<package>/`. */
function copyLicences(packages, dest) {
  const pkgs = join(condaRoot(), 'pkgs');
  const dirs = new Map();
  const find = (dir, depth) => {
    if (depth > 5 || !existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const p = join(dir, e.name);
      if (existsSync(join(p, 'info', 'index.json'))) dirs.set(e.name, p);
      else find(p, depth + 1);
    }
  };
  find(pkgs, 0);
  let missing = 0;
  for (const p of packages) {
    const dir = dirs.get(`${p.name}-${p.version}-${p.build}`);
    const lic = dir ? join(dir, 'info', 'licenses') : null;
    if (lic && existsSync(lic)) cpSync(lic, join(dest, 'licenses', p.name), { recursive: true });
    else missing++;
  }
  return missing;
}

/**
 * A conda-forge tool for `platform` into `dest` (a folder of the pack's tools/): micromamba
 * installs the locked packages (`lock`, solved for `spec`) into a temporary prefix, then `prune`
 * picks what goes over. On Windows `prune.windows(prefix)` returns a function giving, for each
 * file of the environment (path relative to the prefix, `/` separated), its path in `dest` or
 * null; on macOS `prune.mac` names the programs (the dylibs they load follow) and the share/
 * folders. Each package's licence files go to `dest/licenses/<package>/`, the inventory to
 * `conda-packages.json`. Returns the counts `{ packages, files }`.
 */
export async function installCondaTool({
  spec,
  lock,
  dest,
  prune,
  platform,
  cache,
  log = say,
  label,
}) {
  const packages = lockedPackages(platform, lock, label);
  const mm = await ensureMicromamba(cache, platform, log);
  const work = mkdtempSync(join(tmpdir(), 'qconda-'));
  try {
    const explicit = join(work, 'explicit.txt');
    writeFileSync(explicit, explicitSpec(packages));
    const prefix = join(work, 'env');
    run(mm, ['create', '-y', '-q', '-p', prefix, '--file', explicit], {
      env: micromambaEnv(platform),
    });
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dest, { recursive: true });
    const files = platform.startsWith('win32')
      ? copyWindows(prefix, dest, prune.windows(prefix))
      : copyMac(prefix, dest, prune.mac);
    const missing = copyLicences(packages, dest);
    if (missing > 0) log(`  warning: ${missing} conda packages came without licence files`);
    const inventory = packages.map(({ name, version, build, license, url }) => ({
      name,
      version,
      build,
      license,
      url,
    }));
    writeFileSync(
      join(dest, 'conda-packages.json'),
      `${JSON.stringify({ schema: 'conda-packages/1', spec, packages: inventory }, null, 1)}\n`,
    );
    return { packages: packages.length, files };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * PDAL for `platform` into `dest` (the pack's tools/pdal): the program, its libraries, data and
 * licences, with `conda-packages.json` (every package with its version, licence and source).
 */
export async function installPdal({ platform, cache, dest, log = say }) {
  const { packages, files } = await installCondaTool({
    spec: PDAL_SPEC,
    lock: JSON.parse(readFileSync(LOCK_FILE, 'utf8')),
    dest,
    prune: {
      windows: () => keepWindows,
      mac: { programs: ['pdal', 'untwine'], share: ['proj', 'gdal'] },
    },
    platform,
    cache,
    log,
  });
  log(`  PDAL and untwine: ${packages} conda-forge packages, ${files} files kept`);
  return pdalExe(dest, platform);
}

/** The pdal program inside an installPdal folder. */
export function pdalExe(dest, platform = `${process.platform}-${process.arch}`) {
  return platform.startsWith('win32')
    ? join(dest, 'Library', 'bin', 'pdal.exe')
    : join(dest, 'bin', 'pdal');
}

/** The untwine program inside an installPdal folder (beside pdal). */
export function untwineExe(dest, platform = `${process.platform}-${process.arch}`) {
  return platform.startsWith('win32')
    ? join(dest, 'Library', 'bin', 'untwine.exe')
    : join(dest, 'bin', 'untwine');
}

/** A LAS 1.4 file of three points (point format 7, millimetre scale, class 2) for the check. */
export function tinyLas() {
  const header = 375;
  const rec = 36;
  const points = [
    [0, 0, 0],
    [1000, 0, 0],
    [0, 1000, 500],
  ];
  const b = Buffer.alloc(header + points.length * rec);
  b.write('LASF', 0, 'latin1');
  b.writeUInt16LE(0x10, 6); // global encoding: WKT
  b[24] = 1;
  b[25] = 4;
  b.write('Quadrion AI', 26, 'latin1');
  b.write('pack check', 58, 'latin1');
  b.writeUInt16LE(1, 90);
  b.writeUInt16LE(2026, 92);
  b.writeUInt16LE(header, 94);
  b.writeUInt32LE(header, 96);
  b.writeUInt32LE(0, 100);
  b[104] = 7;
  b.writeUInt16LE(rec, 105);
  for (let i = 0; i < 3; i++) b.writeDoubleLE(0.001, 131 + 8 * i);
  [1, 0, 1, 0, 0.5, 0].forEach((v, i) => b.writeDoubleLE(v, 179 + 8 * i));
  b.writeBigUInt64LE(BigInt(points.length), 247);
  b.writeBigUInt64LE(BigInt(points.length), 255);
  points.forEach(([x, y, z], i) => {
    const o = header + i * rec;
    b.writeInt32LE(x, o);
    b.writeInt32LE(y, o + 4);
    b.writeInt32LE(z, o + 8);
    b[o + 14] = 0x11; // return 1 of 1
    b[o + 16] = 2; // ground
  });
  return b;
}

/** The environment pdal runs in (as aio_pipelines' pdal_env): its PROJ and GDAL data. */
export function pdalEnv(exe) {
  const share = join(dirname(dirname(exe)), 'share');
  return {
    ...process.env,
    PROJ_DATA: join(share, 'proj'),
    PROJ_LIB: join(share, 'proj'),
    PROJ_NETWORK: 'OFF',
    GDAL_DATA: join(share, 'gdal'),
  };
}

/** Problems with an installed PDAL: its version line, or the drivers it lacks. */
export function checkPdal(exe) {
  const env = pdalEnv(exe);
  const version =
    run(exe, ['--version'], { env })
      .split('\n')
      .find((l) => /pdal \d/i.test(l))
      ?.trim() ?? '';
  const drivers = new Set(run(exe, ['--drivers'], { env }).match(/^[a-z]+\.[a-z0-9_]+/gm));
  const missing = DRIVERS.filter((d) => !drivers.has(d));
  return { version, missing };
}

/**
 * Whether an installed untwine works: it turns tinyLas() into a COPC file. Answers the problem in
 * words, or null.
 */
export function checkUntwine(exe) {
  if (!existsSync(exe)) return `untwine is missing at ${exe}`;
  const dir = mkdtempSync(join(tmpdir(), 'quntwine-'));
  try {
    const las = join(dir, 'check.las');
    const out = join(dir, 'check.copc.laz');
    writeFileSync(las, tinyLas());
    const r = spawnSync(exe, ['-i', las, '-o', out, '--temp_dir', join(dir, 'tmp')], {
      encoding: 'utf8',
      env: pdalEnv(exe),
      timeout: 120_000,
    });
    if (r.error) return `untwine could not start: ${r.error.message}`;
    if (r.status !== 0) {
      const last = `${r.stderr}\n${r.stdout}`.trim().split('\n').pop();
      return `untwine failed (exit ${r.status}): ${last}`;
    }
    if (!existsSync(out) || readFileSync(out).subarray(0, 4).toString('latin1') !== 'LASF')
      return 'untwine wrote no COPC file';
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Solve `spec` on conda-forge for every pack platform (online) and write the lock to `file`:
 * `{ $comment, schema, spec, channel, platforms: { <subdir>: [package] } }`.
 */
export async function relockConda({ spec, file, schema, comment, cache }) {
  const host = `${process.platform}-${process.arch}`;
  const mm = await ensureMicromamba(cache, host);
  const platforms = {};
  for (const [platform, { subdir }] of Object.entries(PLATFORMS)) {
    const out = run(
      mm,
      ['create', '-n', 'lock', '--dry-run', '--json', '-y', '--platform', subdir].concat([
        '-c',
        'conda-forge',
        '--override-channels',
        ...spec.split(' '),
      ]),
      { env: micromambaEnv(platform), maxBuffer: 64 * 1024 * 1024 },
    );
    const link = JSON.parse(out).actions?.LINK ?? [];
    if (link.length === 0) throw new Error(`micromamba solved nothing for ${subdir}`);
    // the solver's order is the install order (dependencies first): a package's post-link script
    // may run a program that needs the libraries before it (gdk-pixbuf's loaders cache)
    platforms[subdir] = link.map(({ name, version, build, url, sha256: hash, license }) => ({
      name,
      version,
      build,
      license: license ?? '',
      url,
      sha256: hash,
    }));
    say(`  ${subdir}: ${link.length} packages`);
  }
  const lock = { $comment: comment, schema, spec, channel: 'conda-forge', platforms };
  writeFileSync(file, `${JSON.stringify(lock, null, 2)}\n`);
  say(`Wrote ${file instanceof URL ? file.pathname : file}`);
  return lock;
}

/** Re-solve the PDAL lock for every platform (online). */
const relock = (cache) =>
  relockConda({
    spec: PDAL_SPEC,
    file: LOCK_FILE,
    schema: 'pdal-lock/1',
    comment:
      "conda-forge packages of the pack's PDAL (tools/pipeline-pack/pdal.mjs), solved by `node tools/pipeline-pack/pdal.mjs --lock`; do not edit by hand. Installed from these URLs with their SHA-256, never re-solved by a build.",
    cache,
  });

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const { values } = parseArgs({
    options: { out: { type: 'string' }, lock: { type: 'boolean', default: false } },
  });
  const cache = join(condaRoot(), 'bin');
  try {
    if (values.lock) await relock(cache);
    else if (values.out) {
      const platform = `${process.platform}-${process.arch}`;
      const dest = resolve(values.out);
      const exe = await installPdal({ platform, cache, dest });
      const { version, missing } = checkPdal(exe);
      if (missing.length > 0) throw new Error(`PDAL lacks ${missing.join(', ')}`);
      const untwine = untwineExe(dest, platform);
      const problem = checkUntwine(untwine);
      if (problem) throw new Error(problem);
      say(`${version}\nAIO_PDAL=${exe}\nAIO_UNTWINE=${untwine}`);
    } else throw new Error('pass --out <folder> or --lock');
  } catch (e) {
    process.stderr.write(`pdal: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  }
}
