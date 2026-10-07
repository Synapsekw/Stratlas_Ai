#!/usr/bin/env node
// Build the native components of the pipeline pack (M10 G1) from pinned sources: COLMAP 4.2.1
// and pycolmap without any GPL, AGPL or non-commercial part, OpenCV without FFmpeg, and the PDAL
// command-line tool. Windows x64 and macOS arm64 only (decision 8).
//
//   node tools/pipeline-pack/native/build-native.mjs --out <dir> [--work <dir>]
//        [--only colmap,opencv-python-headless,pdal] [--vcpkg <vcpkg root>] [--sources] [--plan]
//
// Output (<out>), read by the native licence gate (tools/release/native-licences.mjs --native)
// and by the pack build (tools/pipeline-pack/build.mjs --native):
//   wheels/*.whl                    pycolmap and opencv-python-headless, cp313 / abi3
//   tools/pdal/{bin,lib,share}      the PDAL tool, its shared library and PROJ's data
//   sbom/<component>/<port>.spdx.json  the SBOM vcpkg wrote for every port of every component
//   native-manifest.json            components (with the CMake options read back from each
//                                   build), ports (version, licence, linkage), file hashes
//   pack-sources-<version>.tar.zst  with --sources: the sources, patches and vcpkg downloads
//
// Needs git, CMake 3.28 or later, a C++17 compiler (Visual Studio 2022 or later on Windows; Xcode and
// Ninja, and libomp from Homebrew, on macOS) and Python 3.13 with pip. vcpkg is cloned at the
// pinned baseline into <work>/vcpkg unless --vcpkg is given; set VCPKG_BINARY_SOURCES for a
// binary cache (CI uses a files cache in the GitHub Actions cache). Cold builds take 1 to 2 hours.
// --plan prints the commands without running anything.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { portLinkage, readSbom } from '../../release/native-licences.mjs';

export const NATIVE_DIR = import.meta.dirname;
const repo = resolve(NATIVE_DIR, '..', '..', '..');

export function loadComponents(path = join(NATIVE_DIR, 'components.json')) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** The target for this machine, or an error that says why there is none. */
export function targetFor(platform, arch, components) {
  const key = `${platform}-${arch}`;
  const target = components.targets[key];
  if (target) return { key, ...target };
  if (key === 'darwin-x64')
    throw new Error(
      'Photogrammetry is not offered on Intel Macs (M10 decision 8): build the pack without --native.',
    );
  throw new Error(
    `No native build for ${key} (only ${Object.keys(components.targets).join(', ')}).`,
  );
}

/** vcpkg-configuration.json for a manifest: the pinned registry, overlay ports and triplets. */
export function vcpkgConfiguration({ vcpkg }, { overlayPorts = [], overlayTriplets = [] } = {}) {
  return {
    'default-registry': { kind: 'git', repository: vcpkg.repository, baseline: vcpkg.baseline },
    'overlay-ports': overlayPorts,
    'overlay-triplets': overlayTriplets,
  };
}

/** `-DKEY=VALUE` arguments for a component's CMake options. */
export const defines = (options) =>
  Object.entries(options ?? {}).map(([k, v]) => `-D${k}=${String(v)}`);

/** The configure command for COLMAP. */
export function colmapConfigure(c, ctx) {
  const args = [
    '-S',
    ctx.src,
    '-B',
    ctx.build,
    // Windows: CMake's default generator, the newest Visual Studio on the machine.
    ...(ctx.platform === 'win32' ? ['-A', 'x64'] : ['-G', 'Ninja']),
    `-DCMAKE_TOOLCHAIN_FILE=${ctx.vcpkgRoot}/scripts/buildsystems/vcpkg.cmake`,
    `-DVCPKG_TARGET_TRIPLET=${ctx.triplet}`,
    `-DVCPKG_HOST_TRIPLET=${ctx.hostTriplet}`,
    `-DVCPKG_INSTALLED_DIR=${ctx.vcpkgInstalled}`,
    `-DVCPKG_OVERLAY_TRIPLETS=${ctx.overlayTriplets}`,
    `-DCMAKE_INSTALL_PREFIX=${ctx.install}`,
    `-DFETCHCONTENT_BASE_DIR=${ctx.fetchContent}`,
    `-DCMAKE_PROJECT_INCLUDE=${ctx.projectInclude}`,
    ...defines(c.cmake),
  ];
  if (ctx.platform === 'win32') args.push('-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreadedDLL');
  if (ctx.platform === 'darwin') {
    args.push(
      '-DCMAKE_OSX_ARCHITECTURES=arm64',
      `-DCMAKE_OSX_DEPLOYMENT_TARGET=${ctx.deploymentTarget}`,
    );
    if (ctx.libomp) args.push(`-DOpenMP_ROOT=${ctx.libomp}`);
  }
  return args;
}

/** pip config settings for the pycolmap wheel (scikit-build-core), built against our COLMAP. */
export function pycolmapSettings(ctx) {
  const d = {
    CMAKE_TOOLCHAIN_FILE: `${ctx.vcpkgRoot}/scripts/buildsystems/vcpkg.cmake`,
    VCPKG_TARGET_TRIPLET: ctx.triplet,
    VCPKG_HOST_TRIPLET: ctx.hostTriplet,
    VCPKG_INSTALLED_DIR: ctx.vcpkgInstalled,
    VCPKG_OVERLAY_TRIPLETS: ctx.overlayTriplets,
    CMAKE_PREFIX_PATH: ctx.install,
    CMAKE_PROJECT_INCLUDE: ctx.projectInclude,
    GENERATE_STUBS: 'OFF',
    CCACHE_ENABLED: 'OFF',
  };
  if (ctx.platform === 'win32') d.CMAKE_MSVC_RUNTIME_LIBRARY = 'MultiThreadedDLL';
  if (ctx.platform === 'darwin') {
    d.CMAKE_OSX_ARCHITECTURES = 'arm64';
    if (ctx.libomp) d.OpenMP_ROOT = ctx.libomp;
  }
  return Object.entries(d).map(([k, v]) => `--config-settings=cmake.define.${k}=${v}`);
}

/** Environment for the opencv-python build: headless, no contrib, our CMake options. */
export function opencvEnv(c) {
  return { ...c.env, CMAKE_ARGS: defines(c.cmake).join(' ') };
}

/** CMakeCache.txt to { NAME: value }. */
export function parseCMakeCache(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Za-z0-9_.-]+):[A-Z_]+=(.*)$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/** The values of `keys` in a CMake cache (missing ones left out). */
export function pick(cache, keys) {
  return Object.fromEntries(keys.filter((k) => k in cache).map((k) => [k, cache[k]]));
}

/**
 * The ports vcpkg installed for `triplet` under `installedDir`: version, licence (from each
 * port's SBOM) and linkage (from the files it installed).
 */
export function installedPorts(installedDir, triplet) {
  const info = join(installedDir, 'vcpkg', 'info');
  if (!existsSync(info)) return [];
  const out = [];
  for (const f of readdirSync(info)) {
    const m = new RegExp(`^(.+?)_(.+)_${triplet.replace(/[-]/g, '\\-')}\\.list$`).exec(f);
    if (!m) continue;
    const files = readFileSync(join(info, f), 'utf8').split(/\r?\n/).filter(Boolean);
    const sbomPath = join(installedDir, triplet, 'share', m[1], 'vcpkg.spdx.json');
    const sbom = existsSync(sbomPath) ? readSbom(JSON.parse(readFileSync(sbomPath, 'utf8'))) : null;
    out.push({
      name: m[1],
      version: sbom?.version ?? m[2].split('#')[0],
      licence: sbom?.licence ?? null,
      linkage: portLinkage(files),
      sbom: existsSync(sbomPath) ? sbomPath : null,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
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

function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile()) yield p;
  }
}

class Runner {
  constructor(plan) {
    this.plan = plan;
  }
  run(cmd, args, opts = {}) {
    const shown = [cmd, ...args].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ');
    const env = Object.entries(opts.env ?? {})
      .map(([k, v]) => `${k}=${v} `)
      .join('');
    process.stdout.write(`${opts.cwd ? `[${opts.cwd}] ` : ''}${env}${shown}\n`);
    if (this.plan) return '';
    // Node runs a .bat only through cmd.exe.
    if (/\.bat$/i.test(cmd)) [cmd, args] = ['cmd.exe', ['/d', '/s', '/c', cmd, ...args]];
    const r = spawnSync(cmd, args, {
      stdio: opts.capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
      encoding: 'utf8',
      shell: false,
      ...opts,
      env: { ...process.env, ...opts.env },
    });
    if (r.error) throw new Error(`${cmd} could not start: ${r.error.message}`);
    if (r.status !== 0) throw new Error(`${shown} failed (exit ${String(r.status)})`);
    return r.stdout ?? '';
  }
}

/** Clone a pinned tag and check that it is the pinned commit. */
function fetchSource(r, c, src) {
  rmSync(src, { recursive: true, force: true });
  r.run('git', [
    '-c',
    'core.autocrlf=false',
    'clone',
    '--depth',
    '1',
    '--branch',
    c.tag,
    c.source,
    src,
  ]);
  if (!r.plan) {
    const head = r.run('git', ['-C', src, 'rev-parse', 'HEAD'], { capture: true }).trim();
    if (head !== c.commit)
      throw new Error(`${c.name} ${c.tag} is ${head}, the recipe pins ${c.commit}`);
  }
  for (const p of c.patches ?? [])
    r.run('git', ['-C', src, 'apply', '--verbose', join(NATIVE_DIR, p)]);
}

async function buildColmap(r, c, ctx) {
  const src = join(ctx.work, 'src', 'colmap');
  const build = join(ctx.work, 'build', 'colmap');
  const install = join(ctx.work, 'install', 'colmap');
  const vcpkgInstalled = join(ctx.work, 'vcpkg_installed', 'colmap');
  fetchSource(r, c, src);
  // Our manifest replaces COLMAP's (no suitesparse, gui, download, cuda); its overlay ports for
  // METIS and GKlib stay (see its cmake/vcpkg/ports/README.md).
  if (!r.plan) {
    cpSync(join(NATIVE_DIR, c.manifest), join(src, 'vcpkg.json'));
    writeFileSync(
      join(src, 'vcpkg-configuration.json'),
      `${JSON.stringify(
        vcpkgConfiguration(ctx.components, {
          overlayPorts: ['cmake/vcpkg/ports'],
          overlayTriplets: [ctx.overlayTriplets],
        }),
        null,
        2,
      )}\n`,
    );
  }
  const cctx = { ...ctx, src, build, install, vcpkgInstalled };
  r.run('cmake', colmapConfigure(c, cctx));
  r.run('cmake', ['--build', build, '--config', 'Release', '--parallel']);
  r.run('cmake', ['--install', build, '--config', 'Release']);
  const cmake = r.plan
    ? {}
    : pick(parseCMakeCache(readFileSync(join(build, 'CMakeCache.txt'), 'utf8')), [
        ...Object.keys(c.cmake),
        'CMAKE_CXX_COMPILER_VERSION',
      ]);

  // pycolmap from the same tree, then its native dependencies bundled into the wheel.
  const raw = join(ctx.work, 'wheels-raw', 'pycolmap');
  rmSync(raw, { recursive: true, force: true });
  r.run(ctx.python, [
    '-m',
    'pip',
    'install',
    'scikit-build-core>=0.10',
    'pybind11==3.0.4',
    'numpy',
    ctx.platform === 'win32' ? 'delvewheel' : 'delocate',
  ]);
  r.run(
    ctx.python,
    [
      '-m',
      'pip',
      'wheel',
      src,
      '--no-deps',
      '--no-build-isolation',
      '-w',
      raw,
      ...pycolmapSettings(cctx),
    ],
    { env: ctx.platform === 'darwin' ? { MACOSX_DEPLOYMENT_TARGET: ctx.deploymentTarget } : {} },
  );
  const wheelsOut = join(ctx.out, 'wheels');
  for (const w of r.plan
    ? ['pycolmap-4.2.1.whl']
    : readdirSync(raw).filter((f) => f.endsWith('.whl'))) {
    if (ctx.platform === 'win32')
      r.run(ctx.python, [
        '-m',
        'delvewheel',
        'repair',
        '-w',
        wheelsOut,
        '--add-path',
        `${install}/bin;${vcpkgInstalled}/${ctx.triplet}/bin`,
        join(raw, w),
      ]);
    else r.run('delocate-wheel', ['-w', wheelsOut, '-v', join(raw, w)]);
  }
  return {
    cmake,
    ports: r.plan ? [] : installedPorts(vcpkgInstalled, ctx.triplet),
    sources: [src],
  };
}

async function buildOpencv(r, c, ctx) {
  const src = join(ctx.work, 'src', 'opencv-python');
  fetchSource(r, c, src);
  const raw = join(ctx.work, 'wheels-raw', 'opencv');
  rmSync(raw, { recursive: true, force: true });
  // setup.py checks out the opencv submodule itself (not contrib, not extra).
  r.run(ctx.python, ['-m', 'pip', 'wheel', src, '--no-deps', '-w', raw, '--verbose'], {
    cwd: src,
    env: {
      ...opencvEnv(c),
      ...(ctx.platform === 'darwin' ? { MACOSX_DEPLOYMENT_TARGET: ctx.deploymentTarget } : {}),
    },
  });
  let cmake = {};
  if (!r.plan) {
    const cache = [...walk(join(src, '_skbuild'))].find((p) => basename(p) === 'CMakeCache.txt');
    if (!cache) throw new Error('opencv-python left no CMakeCache.txt under _skbuild');
    cmake = pick(parseCMakeCache(readFileSync(cache, 'utf8')), Object.keys(c.cmake));
    mkdirSync(join(ctx.out, 'wheels'), { recursive: true });
    for (const w of readdirSync(raw).filter((f) => f.startsWith('opencv') && f.endsWith('.whl')))
      cpSync(join(raw, w), join(ctx.out, 'wheels', w));
  }
  return { cmake, ports: [], sources: [src] };
}

async function buildPdal(r, c, ctx) {
  const root = join(ctx.work, 'manifests', 'pdal');
  const installed = join(ctx.work, 'vcpkg_installed', 'pdal');
  if (!r.plan) {
    mkdirSync(root, { recursive: true });
    cpSync(join(NATIVE_DIR, c.manifest), join(root, 'vcpkg.json'));
    writeFileSync(
      join(root, 'vcpkg-configuration.json'),
      `${JSON.stringify(vcpkgConfiguration(ctx.components, { overlayTriplets: [ctx.overlayTriplets] }), null, 2)}\n`,
    );
  }
  r.run(ctx.vcpkgExe, [
    'install',
    `--x-manifest-root=${root}`,
    `--x-install-root=${installed}`,
    `--triplet=${ctx.triplet}`,
    `--host-triplet=${ctx.hostTriplet}`,
    `--overlay-triplets=${ctx.overlayTriplets}`,
    '--clean-after-build',
  ]);
  if (!r.plan) {
    // <pack>/tools/pdal/bin/pdal(.exe) is where aio_pipelines/pointcloud.py looks.
    const t = join(installed, ctx.triplet);
    const dest = join(ctx.out, 'tools', 'pdal');
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(join(dest, 'bin'), { recursive: true });
    cpSync(join(t, 'tools', 'pdal'), join(dest, 'bin'), { recursive: true });
    if (ctx.platform === 'darwin') {
      mkdirSync(join(dest, 'lib'), { recursive: true });
      for (const f of readdirSync(join(t, 'lib')).filter((n) => n.endsWith('.dylib')))
        cpSync(join(t, 'lib', f), join(dest, 'lib', f), { dereference: true });
      // vcpkg points the tool at @loader_path/../../lib; ours lives one level up from bin.
      r.run('install_name_tool', ['-add_rpath', '@loader_path/../lib', join(dest, 'bin', 'pdal')]);
      r.run('codesign', ['--force', '--sign', '-', join(dest, 'bin', 'pdal')]);
    }
    for (const d of ['proj', 'gdal']) {
      const from = join(t, 'share', d);
      if (existsSync(from))
        cpSync(from, join(dest, 'share', d), {
          recursive: true,
          filter: (s) => !/vcpkg|copyright|usage|\.cmake$/i.test(basename(s)),
        });
    }
  }
  return { cmake: {}, ports: r.plan ? [] : installedPorts(installed, ctx.triplet), sources: [] };
}

const BUILDERS = { colmap: buildColmap, 'opencv-python-headless': buildOpencv, pdal: buildPdal };

async function main() {
  const { values } = parseArgs({
    options: {
      out: { type: 'string' },
      work: { type: 'string' },
      only: { type: 'string' },
      vcpkg: { type: 'string' },
      python: { type: 'string' },
      sources: { type: 'boolean', default: false },
      plan: { type: 'boolean', default: false },
    },
  });
  if (!values.out) throw new Error('Pass --out <folder>.');
  const components = loadComponents();
  const target = targetFor(process.platform, process.arch, components);
  const out = resolve(values.out);
  const work = resolve(values.work ?? join(out, '..', 'native-work'));
  const r = new Runner(values.plan);
  const only = values.only ? new Set(values.only.split(',')) : null;
  const wanted = components.components.filter(
    (c) => c.status === 'required' && (!only || only.has(c.name)),
  );
  if (!values.plan) {
    mkdirSync(out, { recursive: true });
    mkdirSync(work, { recursive: true });
  }

  // vcpkg at the pinned baseline (its tool and its registry), bootstrapped without telemetry.
  let vcpkgRoot = values.vcpkg ? resolve(values.vcpkg) : join(work, 'vcpkg');
  if (!values.vcpkg && !existsSync(join(vcpkgRoot, '.git'))) {
    r.run('git', ['clone', '--filter=blob:none', components.vcpkg.repository, vcpkgRoot]);
    r.run('git', ['-C', vcpkgRoot, 'checkout', components.vcpkg.baseline]);
  }
  const vcpkgExe = join(vcpkgRoot, process.platform === 'win32' ? 'vcpkg.exe' : 'vcpkg');
  if (!existsSync(vcpkgExe))
    r.run(
      join(vcpkgRoot, process.platform === 'win32' ? 'bootstrap-vcpkg.bat' : 'bootstrap-vcpkg.sh'),
      ['-disableMetrics'],
    );
  vcpkgRoot = vcpkgRoot.split('\\').join('/');

  const libomp =
    process.platform === 'darwin' && !values.plan
      ? spawnSync('brew', ['--prefix', 'libomp'], { encoding: 'utf8' }).stdout?.trim()
      : process.platform === 'darwin'
        ? '$(brew --prefix libomp)'
        : undefined;
  const ctx = {
    components,
    platform: process.platform,
    triplet: target.triplet,
    hostTriplet: target.hostTriplet,
    deploymentTarget: target.deploymentTarget,
    out,
    work,
    vcpkgRoot,
    vcpkgExe,
    overlayTriplets: join(NATIVE_DIR, 'vcpkg-overlay', 'triplets').split('\\').join('/'),
    fetchContent: join(work, 'fetchcontent'),
    projectInclude: join(NATIVE_DIR, 'colmap', 'project-include.cmake').split('\\').join('/'),
    python: values.python ?? (process.platform === 'win32' ? 'python' : 'python3'),
    libomp,
  };

  const manifest = {
    schema: 'aio.native-manifest/1',
    platform: target.key,
    triplet: target.triplet,
    createdAt: new Date().toISOString(),
    vcpkg: components.vcpkg,
    components: [],
    ports: [],
    files: {},
  };
  const sourceDirs = [];
  for (const c of components.components) {
    const base = {
      name: c.name,
      version: c.version ?? null,
      spdx: c.spdx,
      source: c.source,
      commit: c.commit ?? null,
      require: c.require ?? {},
    };
    if (!wanted.includes(c)) {
      manifest.components.push({ ...base, status: c.status === 'required' ? 'skipped' : c.status });
      continue;
    }
    process.stdout.write(`\n== ${c.name} ${c.version ?? ''}\n`);
    const t0 = Date.now();
    const res = await BUILDERS[c.name](r, c, ctx);
    sourceDirs.push(...res.sources);
    manifest.components.push({
      ...base,
      status: 'built',
      cmake: res.cmake,
      seconds: Math.round((Date.now() - t0) / 1000),
    });
    for (const p of res.ports) {
      manifest.ports.push({
        component: c.name,
        name: p.name,
        version: p.version,
        licence: p.licence,
        linkage: p.linkage,
      });
      if (p.sbom && !values.plan) {
        mkdirSync(join(out, 'sbom', c.name), { recursive: true });
        cpSync(p.sbom, join(out, 'sbom', c.name, `${p.name}.spdx.json`));
      }
    }
  }
  if (values.plan) return;

  for (const f of walk(out)) {
    const rel = relative(out, f).split('\\').join('/');
    if (rel === 'native-manifest.json' || rel.startsWith('pack-sources-')) continue;
    manifest.files[rel] = { size: statSync(f).size, sha256: await sha256File(f) };
  }
  writeFileSync(join(out, 'native-manifest.json'), `${JSON.stringify(manifest, null, 1)}\n`);

  if (values.sources) {
    // Exact sources for audits and the MPL and LGPL obligations: patched trees, the recipe and
    // every source archive vcpkg downloaded.
    const version = /^version\s*=\s*"([^"]+)"/m.exec(
      readFileSync(join(repo, 'python', 'pyproject.toml'), 'utf8'),
    )?.[1];
    const stage = join(work, `pack-sources-${String(version)}`);
    rmSync(stage, { recursive: true, force: true });
    const skip = (s) => !/[\\/](\.git|_skbuild)$/.test(s);
    const parts = [
      ...sourceDirs.map((d) => [d, basename(d)]),
      [NATIVE_DIR, 'recipe'],
      [join(vcpkgRoot, 'downloads'), 'vcpkg-downloads'],
      [ctx.fetchContent, 'fetchcontent'],
    ];
    for (const [from, to] of parts)
      if (existsSync(from)) cpSync(from, join(stage, to), { recursive: true, filter: skip });
    r.run(
      'cmake',
      ['-E', 'tar', 'cf', join(out, `${basename(stage)}.tar.zst`), '--zstd', basename(stage)],
      {
        cwd: work,
      },
    );
    rmSync(stage, { recursive: true, force: true });
  }
  process.stdout.write(
    `\nNative build done: ${String(Object.keys(manifest.files).length)} files in ${out}\n`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main().catch((e) => {
    process.stderr.write(`build-native: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  });
}
