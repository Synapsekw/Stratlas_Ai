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
  chmodSync,
  copyFileSync,
  cpSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadInventory, portLinkage, readSbom } from '../../release/native-licences.mjs';

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

/**
 * CMake hints for Homebrew's libomp with AppleClang (macOS), as `{ NAME: value }`; none elsewhere
 * (MSVC's OpenMP is found by FindOpenMP without hints). `OpenMP_ROOT` alone is not enough: a
 * project whose `cmake_minimum_required` predates 3.12 (pycolmap's) leaves policy CMP0074 unset,
 * so `find_package(OpenMP)` from COLMAP's installed config ignores it ("Could NOT find OpenMP_C").
 * The flags, library names and library path below need no search at all; the policy default is
 * set as well so any other `<Package>_ROOT` is honoured the same way.
 */
export function openmpHints(ctx) {
  if (ctx.platform !== 'darwin' || !ctx.libomp) return {};
  const flags = `-Xpreprocessor -fopenmp -I${ctx.libomp}/include`;
  return {
    CMAKE_POLICY_DEFAULT_CMP0074: 'NEW',
    OpenMP_ROOT: ctx.libomp,
    OpenMP_C_FLAGS: flags,
    OpenMP_CXX_FLAGS: flags,
    OpenMP_C_LIB_NAMES: 'omp',
    OpenMP_CXX_LIB_NAMES: 'omp',
    OpenMP_omp_LIBRARY: `${ctx.libomp}/lib/libomp.dylib`,
  };
}

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
      ...defines(openmpHints(ctx)),
    );
  }
  return args;
}

/** A Python project name as pip compares it (PEP 503). */
const normName = (n) => n.toLowerCase().replace(/[-_.]+/g, '-');

/** `name==version` (or a bare name) to its normalised name and pinned version. */
function parseRequirement(req) {
  const m = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*(.*)$/.exec(req);
  if (!m?.[1]) throw new Error(`Not a requirement: ${req}`);
  const pin = /^==\s*([^\s,;]+)\s*$/.exec(m[2] ?? '');
  return { name: normName(m[1]), spec: (m[2] ?? '').trim(), pinned: pin?.[1] };
}

/**
 * pycolmap's build requirements against our pins: every `[build-system] requires` of the
 * source's pyproject.toml is installed pinned (an exact pin there must be ours) or left out
 * with a reason. Returns the problems; a COLMAP bump that adds or repins one fails the build.
 */
export function checkBuildRequires(requires, pycolmap) {
  const ours = new Map(pycolmap.buildRequires.map((r) => [parseRequirement(r).name, r]));
  const skipped = new Set(Object.keys(pycolmap.notInstalled ?? {}).map(normName));
  const problems = [];
  for (const req of requires) {
    const { name, pinned } = parseRequirement(req);
    if (skipped.has(name)) continue;
    const pin = ours.get(name);
    if (!pin) problems.push(`${req}: not in components.json pycolmap.buildRequires`);
    else if (pinned && parseRequirement(pin).pinned !== pinned)
      problems.push(`${req}: components.json pins ${pin}`);
  }
  return problems;
}

/** What the build Python needs for the pycolmap wheel: its build requirements and the repair tool. */
export function pycolmapRequirements(c, platform) {
  const repair = c.pycolmap.repair[platform];
  if (!repair) throw new Error(`No wheel repair tool for ${platform}`);
  return [...c.pycolmap.buildRequires, repair];
}

/**
 * pip config settings for the pycolmap wheel (scikit-build-core), built against our COLMAP.
 * `ctx.pybind11Dir` is `python -m pybind11 --cmakedir` of the build Python: our
 * CMAKE_PREFIX_PATH replaces the prefixes scikit-build-core would add for pybind11, so without
 * it `find_package(pybind11)` fails (pack-native win32-x64).
 */
export function pycolmapSettings(ctx) {
  if (!ctx.pybind11Dir) throw new Error('pycolmap needs the CMake folder of pybind11');
  const d = {
    CMAKE_TOOLCHAIN_FILE: `${ctx.vcpkgRoot}/scripts/buildsystems/vcpkg.cmake`,
    VCPKG_TARGET_TRIPLET: ctx.triplet,
    VCPKG_HOST_TRIPLET: ctx.hostTriplet,
    VCPKG_INSTALLED_DIR: ctx.vcpkgInstalled,
    VCPKG_OVERLAY_TRIPLETS: ctx.overlayTriplets,
    CMAKE_PREFIX_PATH: ctx.install,
    CMAKE_PROJECT_INCLUDE: ctx.projectInclude,
    pybind11_DIR: ctx.pybind11Dir,
    GENERATE_STUBS: 'OFF',
    CCACHE_ENABLED: 'OFF',
  };
  if (ctx.platform === 'win32') d.CMAKE_MSVC_RUNTIME_LIBRARY = 'MultiThreadedDLL';
  if (ctx.platform === 'darwin') {
    d.CMAKE_OSX_ARCHITECTURES = 'arm64';
    Object.assign(d, openmpHints(ctx));
  }
  return Object.entries(d).map(([k, v]) => `--config-settings=cmake.define.${k}=${v}`);
}

/** `python <args>` building the pycolmap wheel from `ctx.src` into `ctx.raw`, on both platforms. */
export const pycolmapWheelArgs = (ctx) => [
  '-m',
  'pip',
  'wheel',
  ctx.src,
  '--no-deps',
  '--no-build-isolation',
  '-w',
  ctx.raw,
  ...pycolmapSettings(ctx),
];

/**
 * Environment for the opencv-python build: headless, no contrib, our CMake options. Its setup.py
 * reads CMAKE_ARGS, and our patch (opencv-python/patches) reads -DWITH_FFMPEG=OFF there to stop
 * requiring the FFmpeg plugin DLL on Windows.
 */
export function opencvEnv(c) {
  return { ...c.env, CMAKE_ARGS: defines(c.cmake).join(' ') };
}

/**
 * The entries of a built wheel (`names`, paths inside the zip) that the native licence gate
 * forbids (native-libs.json `forbiddenFiles`: FFmpeg, opencv_videoio_ffmpeg, CHOLMOD...), as
 * problems. Checked as soon as a wheel is built, before the pack's own gate sees it installed.
 */
export function forbiddenInWheel(names, inventory = loadInventory()) {
  const rules = (inventory.forbiddenFiles ?? []).map((f) => ({
    re: new RegExp(f.pattern, 'i'),
    why: f.why,
  }));
  const out = [];
  for (const n of names) {
    const bad = rules.find((x) => x.re.test(basename(n)));
    if (bad) out.push(`${n}: forbidden (${bad.why})`);
  }
  return out;
}

/**
 * The CMake cache of opencv-python's OpenCV build: scikit-build configures OpenCV in
 * `_skbuild/<platform>/cmake-build`. Other CMakeCache.txt files lie under `_skbuild` too (try-compile
 * and sub-projects); reading the first one found gave the gate none of the recipe's options
 * (pack-native win32-x64: "built with WITH_FFMPEG=unset"). Answers `{ path, cache }`, or throws
 * unless there is exactly one such cache and it is OpenCV's (CMAKE_HOME_DIRECTORY .../opencv).
 */
export function opencvCache(src) {
  const root = join(src, '_skbuild');
  const found = existsSync(root)
    ? readdirSync(root)
        .map((d) => join(root, d, 'cmake-build', 'CMakeCache.txt'))
        .filter((p) => existsSync(p))
    : [];
  if (found.length !== 1)
    throw new Error(
      `expected one _skbuild/<platform>/cmake-build/CMakeCache.txt in ${src}, found ${String(found.length)}`,
    );
  const cache = parseCMakeCache(readFileSync(found[0], 'utf8'));
  const home = String(cache.CMAKE_HOME_DIRECTORY ?? '')
    .split('\\')
    .join('/');
  if (!/\/opencv\/?$/.test(home))
    throw new Error(`${found[0]} is not OpenCV's cache (CMAKE_HOME_DIRECTORY=${home || 'unset'})`);
  return { path: found[0], cache };
}

/** The `require` options a CMake read-back does not meet (an unset option never does). */
export function unmetRequire(require, cmake) {
  return Object.entries(require ?? {})
    .filter(([k, v]) => String(cmake[k]).toUpperCase() !== String(v).toUpperCase())
    .map(([k, v]) => `${k}=${cmake[k] ?? 'unset'}, the recipe requires ${String(v)}`);
}

/** `python <args>` installing the built OpenCV wheel and its pinned probe needs into `dir`. */
export const opencvProbeInstallArgs = (c, wheel, dir) => [
  '-m',
  'pip',
  'install',
  '--no-deps',
  '--target',
  dir,
  wheel,
  ...(c.probeRequires ?? []),
];

/** Python run with `sys.argv[1]` the folder `opencvProbeInstallArgs` filled. */
export const OPENCV_PROBE =
  'import json,sys;sys.path.insert(0,sys.argv[1]);import cv2;' +
  'print(json.dumps({"file":cv2.__file__,"videoCapture":hasattr(cv2,"VideoCapture"),' +
  '"info":cv2.getBuildInformation()}))';

/** The lines of one section of cv2.getBuildInformation() (up to the next blank line). */
function buildInfoSection(info, title) {
  const at = info.indexOf(`${title}:`);
  if (at < 0) return [];
  return info
    .slice(at)
    .split(/\r?\n/)
    .slice(1)
    .join('\n')
    .split(/\n\s*\n/)[0]
    .split('\n');
}

/**
 * What the probe of a built cv2 (`{ file, videoCapture, info }`) says against the recipe: it must
 * be the wheel's cv2 (under `dir`), without the videoio module (no VideoCapture, not in "To be
 * built"), without an FFmpeg or GStreamer backend, without Intel IPP and without non-free code.
 */
export function opencvProbeProblems(p, dir) {
  const out = [];
  const norm = (s) =>
    String(s ?? '')
      .split('\\')
      .join('/')
      .toLowerCase();
  if (!norm(p.file).startsWith(norm(dir)))
    out.push(`cv2 came from ${String(p.file)}, not the built wheel`);
  const info = String(p.info ?? '');
  const modules = /^\s*To be built:\s*(.*)$/m.exec(info)?.[1];
  if (modules === undefined) out.push('cv2.getBuildInformation() lists no modules');
  else if (/(^|\s)videoio(\s|$)/.test(modules)) out.push('the videoio module is built');
  if (p.videoCapture) out.push('cv2 has VideoCapture (videoio)');
  for (const line of buildInfoSection(info, 'Video I/O'))
    if (/ffmpeg|gstreamer|avcodec|avformat/i.test(line) && !/:\s*NO\b/.test(line))
      out.push(`video backend: ${line.trim()}`);
  const ipp = /^\s*Intel IPP:\s*(.*)$/m.exec(info)?.[1];
  if (ipp !== undefined && !/^NO\b/.test(ipp.trim())) out.push(`Intel IPP: ${ipp.trim()}`);
  const nonfree = /^\s*Non-free algorithms:\s*(\S+)/m.exec(info)?.[1];
  if (nonfree !== 'NO') out.push(`Non-free algorithms: ${nonfree ?? 'not reported'}`);
  return out;
}

/** `python <args>` printing the entries of a wheel as JSON. */
export const wheelListArgs = (wheel) => [
  '-c',
  'import json,sys,zipfile;print(json.dumps(zipfile.ZipFile(sys.argv[1]).namelist()))',
  wheel,
];

/**
 * PDAL plugins (`libpdal_plugin_<type>_<name>`): the pack ships none. PDAL 2.10 builds its test
 * plugin `fauxplugin` whatever WITH_TESTS says (plugins/CMakeLists.txt adds plugins/faux
 * unconditionally), so vcpkg installs it beside libpdalcpp.
 */
export const PDAL_PLUGIN = /^(lib)?pdal_plugin_/i;

/** The PDAL files we ship, by the folder of the vcpkg install they come from. */
const PDAL_SHIPS = {
  // <triplet>/tools/pdal: the tool (and on Windows the DLL vcpkg deploys beside it)
  bin: {
    win32: [/^pdal\.exe$/i, /^pdalcpp[^\\/]*\.dll$/i],
    darwin: [/^pdal$/],
  },
  // <triplet>/lib (macOS): the library the tool links; its dependencies are static
  lib: { darwin: [/^libpdalcpp(\.\d+)*\.dylib$/] },
};
const NATIVE_LIB = /\.(dll|dylib|so)$|\.so\.\d+(\.\d+)*$|\.exe$/i;

/**
 * Which entries of a vcpkg PDAL folder go into the pack. `entries` are `{ name, type, target,
 * targetIsDir }` (see `readEntries`: `type` is 'file', 'symlink' or 'dir'; `target` the resolved
 * path of a link, null when it is broken). Answers `{ copy: [{ name, from }], skip: [{ name, why
 * }] }` and throws on a native library the recipe does not know (a tool that needs it would
 * break, a pack that ships it would fail the gate).
 *
 * Folders are skipped. Plugins are skipped. A link to a file we copy from the same folder (the
 * `libpdalcpp.20.dylib -> libpdalcpp.20.1.0.dylib` aliases) is skipped: the tool links the full
 * name (checked with otool) and a CI artifact would turn the link into a second copy; any other
 * link is copied as the file it points to. Node's cpSync is not used here: with `dereference` it
 * takes every symlink for a folder ("Recursive option not enabled, cannot copy a directory").
 */
export function pdalSelect(entries, folder, platform, dir = folder) {
  const ships = PDAL_SHIPS[folder]?.[platform];
  if (!ships) throw new Error(`No PDAL ${folder} files for ${platform}`);
  const wanted = (e) => ships.some((re) => re.test(e.name));
  const files = new Set(entries.filter((e) => e.type === 'file' && wanted(e)).map((e) => e.name));
  const copy = [];
  const skip = [];
  for (const e of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    const from = join(dir, e.name);
    if (e.type === 'dir' || (e.type === 'symlink' && e.targetIsDir)) {
      skip.push({ name: e.name, why: 'a folder' });
      continue;
    }
    if (PDAL_PLUGIN.test(e.name)) {
      skip.push({ name: e.name, why: 'a PDAL plugin (the pack ships none)' });
      continue;
    }
    if (!wanted(e)) {
      if (NATIVE_LIB.test(e.name))
        throw new Error(
          `${from}: a native file the PDAL recipe does not ship (add it to build-native.mjs and native-libs.json, or exclude it)`,
        );
      skip.push({ name: e.name, why: 'not part of the PDAL tool' });
      continue;
    }
    if (e.type === 'symlink') {
      if (!e.target) throw new Error(`${from}: a broken symbolic link`);
      if (files.has(basename(e.target)))
        skip.push({ name: e.name, why: `a link to ${basename(e.target)}, which is copied` });
      else copy.push({ name: e.name, from: e.target });
      continue;
    }
    copy.push({ name: e.name, from });
  }
  return { copy, skip };
}

/** A folder's entries for `pdalSelect`, links resolved. */
export function readEntries(dir) {
  return readdirSync(dir, { withFileTypes: true }).map((e) => {
    const p = join(dir, e.name);
    if (e.isSymbolicLink()) {
      let target = null;
      try {
        target = realpathSync(p);
      } catch {
        /* broken link: pdalSelect refuses it */
      }
      return {
        name: e.name,
        type: 'symlink',
        target,
        targetIsDir: target ? statSync(target).isDirectory() : false,
      };
    }
    return { name: e.name, type: e.isDirectory() ? 'dir' : 'file' };
  });
}

/**
 * Copy one file, following links, keeping its mode (the tool's executable bit) but writable by us
 * (install_name_tool and codesign rewrite it; Homebrew installs its libraries read-only).
 */
function copyResolved(from, to) {
  const real = realpathSync(from);
  copyFileSync(real, to);
  chmodSync(to, (statSync(real).mode & 0o777) | 0o200);
}

/** Copy the PDAL files of a vcpkg folder into `to`; answers what was copied. */
function copyPdal(from, to, folder, platform) {
  const { copy, skip } = pdalSelect(readEntries(from), folder, platform, from);
  mkdirSync(to, { recursive: true });
  for (const s of skip) process.stdout.write(`  skip ${folder}/${s.name}: ${s.why}\n`);
  for (const c of copy) {
    process.stdout.write(`  copy ${folder}/${c.name}\n`);
    copyResolved(c.from, join(to, c.name));
  }
  return copy.map((c) => c.name);
}

/**
 * The `@rpath/` libraries `otool -L` lists for a tool that are not among `shipped`: the tool would
 * not start. Each must be a file we copied into its lib folder.
 */
export function missingRpathLibs(otoolOutput, shipped) {
  const have = new Set(shipped);
  const out = [];
  for (const m of otoolOutput.matchAll(/^\s*@rpath\/(\S+)/gm)) if (!have.has(m[1])) out.push(m[1]);
  return out;
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

/** Remove earlier wheels of one project from an output folder (a rebuild replaces them). */
function removeWheels(dir, prefix) {
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir))
    if (f.startsWith(prefix) && f.endsWith('.whl')) rmSync(join(dir, f), { force: true });
}

/** Clone a pinned tag and check that it is the pinned commit. */
function fetchSource(r, c, src) {
  rmSync(src, { recursive: true, force: true });
  if (c.tag)
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
  else {
    // No release tag upstream: the pinned commit.
    r.run('git', ['-c', 'core.autocrlf=false', 'clone', '--filter=blob:none', c.source, src]);
    r.run('git', ['-C', src, '-c', 'advice.detachedHead=false', 'checkout', c.commit]);
  }
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
  // --no-build-isolation: the build Python holds pycolmap's build requirements, pinned
  const requires = r.run(
    ctx.python,
    [
      '-c',
      'import json,sys,tomllib;print(json.dumps(tomllib.load(open(sys.argv[1],"rb"))["build-system"]["requires"]))',
      join(src, 'pyproject.toml'),
    ],
    { capture: true },
  );
  if (!r.plan) {
    const problems = checkBuildRequires(JSON.parse(requires), c.pycolmap);
    if (problems.length) throw new Error(`pycolmap build requirements:\n${problems.join('\n')}`);
  }
  r.run(ctx.python, ['-m', 'pip', 'install', ...pycolmapRequirements(c, ctx.platform)]);
  const cmakedir = r.run(ctx.python, ['-m', 'pybind11', '--cmakedir'], { capture: true });
  const pybind11Dir = r.plan
    ? '$(python -m pybind11 --cmakedir)'
    : cmakedir.trim().split('\\').join('/');
  r.run(ctx.python, pycolmapWheelArgs({ ...cctx, raw, pybind11Dir }), {
    env: ctx.platform === 'darwin' ? { MACOSX_DEPLOYMENT_TARGET: ctx.deploymentTarget } : {},
  });
  const wheelsOut = join(ctx.out, 'wheels');
  if (!r.plan) removeWheels(wheelsOut, 'pycolmap-');
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
  // The wheel must carry the OpenMP runtime it links (Homebrew's libomp is not on users' Macs).
  if (ctx.platform === 'darwin' && !r.plan)
    for (const w of readdirSync(wheelsOut).filter((f) => /^pycolmap-.*\.whl$/.test(f))) {
      const listing = r.run(ctx.python, ['-m', 'zipfile', '-l', join(wheelsOut, w)], {
        capture: true,
      });
      if (!/\.dylibs\/libomp[^/\s]*\.dylib/.test(listing))
        throw new Error(`${w}: delocate did not bundle libomp.dylib`);
    }
  if (!r.plan)
    for (const w of readdirSync(wheelsOut).filter((f) => /^pycolmap-.*\.whl$/.test(f)))
      checkWheel(r, ctx, join(wheelsOut, w));
  return {
    cmake,
    ports: r.plan ? [] : installedPorts(vcpkgInstalled, ctx.triplet),
    sources: [src],
  };
}

/**
 * Refuse a built wheel that holds a file the licence gate forbids (an FFmpeg DLL above all: our
 * OpenCV is built without FFmpeg, and our patch only stops setup.py from asking for its DLL).
 */
function checkWheel(r, ctx, wheel) {
  const listing = r.run(ctx.python, wheelListArgs(wheel), { capture: true });
  if (r.plan) return;
  const problems = forbiddenInWheel(JSON.parse(listing));
  if (problems.length)
    throw new Error(`${basename(wheel)} holds forbidden files:\n${problems.join('\n')}`);
}

export async function buildOpencv(r, c, ctx) {
  const src = join(ctx.work, 'src', 'opencv-python');
  // Applies opencv-python/patches: setup.py no longer requires the FFmpeg DLL on Windows.
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
  const wheels = r.plan
    ? ['opencv_python_headless-5.0.0.93.whl']
    : readdirSync(raw).filter((f) => f.startsWith('opencv') && f.endsWith('.whl'));
  if (wheels.length !== 1)
    throw new Error(`expected one OpenCV wheel in ${raw}, found ${wheels.join(', ') || 'none'}`);
  const wheel = join(raw, wheels[0]);
  checkWheel(r, ctx, wheel);

  // Second source: the built cv2 itself reports no videoio, FFmpeg, GStreamer, IPP or non-free.
  const probe = join(ctx.work, 'probe', 'opencv');
  rmSync(probe, { recursive: true, force: true });
  r.run(ctx.python, opencvProbeInstallArgs(c, wheel, probe));
  const answer = r.run(ctx.python, ['-c', OPENCV_PROBE, probe], { capture: true });
  if (!r.plan) {
    const problems = opencvProbeProblems(JSON.parse(answer), probe);
    if (problems.length)
      throw new Error(`${wheels[0]} reports what the recipe forbids:\n${problems.join('\n')}`);
  }

  let cmake = {};
  if (!r.plan) {
    // The options read back from OpenCV's own CMake cache (the gate's first source).
    cmake = pick(opencvCache(src).cache, Object.keys(c.cmake));
    const unmet = unmetRequire(c.require, cmake);
    if (unmet.length)
      throw new Error(`opencv-python's CMake cache misses the recipe:\n${unmet.join('\n')}`);
    removeWheels(join(ctx.out, 'wheels'), 'opencv_python_headless-');
    mkdirSync(join(ctx.out, 'wheels'), { recursive: true });
    for (const w of wheels) cpSync(join(raw, w), join(ctx.out, 'wheels', w));
  }
  return { cmake, ports: [], sources: [src] };
}

/**
 * <pack>/tools/pdal from vcpkg's install for the triplet (`t`): bin/pdal(.exe) where
 * aio_pipelines/pointcloud.py looks, libpdalcpp beside it (Windows) or in lib (macOS), and PROJ's
 * and GDAL's data in share. Only the files `pdalSelect` names: no plugins, folders or aliases.
 */
export function installPdalTool(r, ctx, t, dest) {
  rmSync(dest, { recursive: true, force: true });
  copyPdal(join(t, 'tools', 'pdal'), join(dest, 'bin'), 'bin', ctx.platform);
  if (ctx.platform === 'darwin') {
    const libs = copyPdal(join(t, 'lib'), join(dest, 'lib'), 'lib', ctx.platform);
    const tool = join(dest, 'bin', 'pdal');
    // vcpkg points the tool at @loader_path/../../lib; ours lives one level up from bin.
    r.run('install_name_tool', ['-add_rpath', '@loader_path/../lib', tool]);
    r.run('codesign', ['--force', '--sign', '-', tool]);
    const missing = missingRpathLibs(r.run('otool', ['-L', tool], { capture: true }), libs);
    if (missing.length)
      throw new Error(`${tool} links ${missing.join(', ')}, which tools/pdal/lib does not have`);
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
  if (!r.plan)
    installPdalTool(r, ctx, join(installed, ctx.triplet), join(ctx.out, 'tools', 'pdal'));
  return { cmake: {}, ports: r.plan ? [] : installedPorts(installed, ctx.triplet), sources: [] };
}

/**
 * The configure command for our PoissonRecon CMake project (poissonrecon/CMakeLists.txt): zlib,
 * libpng and libjpeg-turbo from vcpkg in manifest mode (poissonrecon/vcpkg.json, copied with its
 * configuration into `ctx.manifestDir`), installed into `ctx.vcpkgInstalled`.
 */
export function poissonConfigure(ctx) {
  const args = [
    '-S',
    join(NATIVE_DIR, 'poissonrecon').split('\\').join('/'),
    '-B',
    ctx.build,
    ...(ctx.platform === 'win32' ? ['-A', 'x64'] : ['-G', 'Ninja']),
    `-DPOISSONRECON_SOURCE=${ctx.src}`,
    '-DCMAKE_BUILD_TYPE=Release',
    `-DCMAKE_TOOLCHAIN_FILE=${ctx.vcpkgRoot}/scripts/buildsystems/vcpkg.cmake`,
    `-DVCPKG_MANIFEST_DIR=${ctx.manifestDir}`,
    `-DVCPKG_TARGET_TRIPLET=${ctx.triplet}`,
    `-DVCPKG_HOST_TRIPLET=${ctx.hostTriplet}`,
    `-DVCPKG_INSTALLED_DIR=${ctx.vcpkgInstalled}`,
    `-DVCPKG_OVERLAY_TRIPLETS=${ctx.overlayTriplets}`,
  ];
  if (ctx.platform === 'win32') args.push('-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreadedDLL');
  if (ctx.platform === 'darwin') {
    args.push(
      '-DCMAKE_OSX_ARCHITECTURES=arm64',
      `-DCMAKE_OSX_DEPLOYMENT_TARGET=${ctx.deploymentTarget}`,
      ...defines(openmpHints(ctx)),
    );
  }
  return args;
}

async function buildPoissonRecon(r, c, ctx) {
  const src = join(ctx.work, 'src', 'poissonrecon');
  const build = join(ctx.work, 'build', 'poissonrecon');
  const dest = join(ctx.out, 'tools', 'poissonrecon');
  const manifestDir = join(ctx.work, 'manifests', 'poissonrecon');
  const vcpkgInstalled = join(ctx.work, 'vcpkg_installed', 'poissonrecon');
  // Applies poissonrecon/patches: PNG.inl against libpng 1.6.
  fetchSource(r, c, src);
  rmSync(build, { recursive: true, force: true });
  rmSync(dest, { recursive: true, force: true });
  if (!r.plan) {
    mkdirSync(manifestDir, { recursive: true });
    cpSync(join(NATIVE_DIR, c.manifest), join(manifestDir, 'vcpkg.json'));
    writeFileSync(
      join(manifestDir, 'vcpkg-configuration.json'),
      `${JSON.stringify(vcpkgConfiguration(ctx.components, { overlayTriplets: [ctx.overlayTriplets] }), null, 2)}\n`,
    );
  }
  r.run('cmake', poissonConfigure({ ...ctx, src, build, manifestDir, vcpkgInstalled }));
  r.run('cmake', ['--build', build, '--config', 'Release', '--parallel']);
  r.run('cmake', ['--install', build, '--config', 'Release', '--prefix', dest]);
  if (ctx.platform === 'darwin' && !r.plan) {
    // Homebrew's libomp goes beside the tools, which then load it from there.
    mkdirSync(join(dest, 'lib'), { recursive: true });
    // Not cpSync with `dereference`: it takes a symbolic link for a folder (see pdalSelect).
    copyResolved(join(ctx.libomp, 'lib', 'libomp.dylib'), join(dest, 'lib', 'libomp.dylib'));
    r.run('install_name_tool', ['-id', '@rpath/libomp.dylib', join(dest, 'lib', 'libomp.dylib')]);
    r.run('codesign', ['--force', '--sign', '-', join(dest, 'lib', 'libomp.dylib')]);
    for (const tool of ['PoissonRecon', 'SurfaceTrimmer']) {
      const exe = join(dest, 'bin', tool);
      const deps = r.run('otool', ['-L', exe], { capture: true });
      const old = /^\s*(\S*libomp\.dylib)/m.exec(deps)?.[1];
      if (old)
        r.run('install_name_tool', ['-change', old, '@executable_path/../lib/libomp.dylib', exe]);
      r.run('codesign', ['--force', '--sign', '-', exe]);
    }
  }
  return {
    cmake: {},
    ports: r.plan ? [] : installedPorts(vcpkgInstalled, ctx.triplet),
    sources: [src],
  };
}

const BUILDERS = {
  colmap: buildColmap,
  'opencv-python-headless': buildOpencv,
  pdal: buildPdal,
  poissonrecon: buildPoissonRecon,
};

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
    schema: 'native-manifest/1',
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
