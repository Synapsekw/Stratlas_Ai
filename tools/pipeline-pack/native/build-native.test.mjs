// The native build recipe (M10 G1): pinned, licence-clean options, and the helpers build-native.mjs
// uses. The build itself runs in CI (pack-native); these tests keep the recipe honest on every merge.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  NATIVE_DIR,
  colmapConfigure,
  installedPorts,
  loadComponents,
  opencvEnv,
  openmpHints,
  parseCMakeCache,
  pick,
  poissonConfigure,
  pycolmapSettings,
  targetFor,
  vcpkgConfiguration,
} from './build-native.mjs';

const components = loadComponents();
const byName = Object.fromEntries(components.components.map((c) => [c.name, c]));
const json = (rel) => JSON.parse(readFileSync(join(NATIVE_DIR, rel), 'utf8'));

describe('targets', () => {
  it('builds for Windows x64 and macOS arm64 only (decision 8)', () => {
    expect(targetFor('win32', 'x64', components).triplet).toBe('x64-windows-stratlas');
    expect(targetFor('darwin', 'arm64', components)).toMatchObject({
      triplet: 'arm64-osx-stratlas',
      deploymentTarget: '14.0',
    });
    expect(() => targetFor('darwin', 'x64', components)).toThrow(/Intel Macs/);
    expect(() => targetFor('linux', 'x64', components)).toThrow(/No native build/);
  });

  it('has a triplet file for every target, static with only PDAL shared', () => {
    for (const t of Object.values(components.targets)) {
      const text = readFileSync(
        join(NATIVE_DIR, 'vcpkg-overlay', 'triplets', `${t.triplet}.cmake`),
        'utf8',
      );
      expect(text).toMatch(/set\(VCPKG_LIBRARY_LINKAGE static\)/);
      expect(text).toMatch(/PORT STREQUAL "pdal"\)\s+set\(VCPKG_LIBRARY_LINKAGE dynamic\)/);
      expect(text).toMatch(/set\(VCPKG_BUILD_TYPE release\)/);
      expect(text).toMatch(/EIGEN_MPL2_ONLY/);
    }
  });
});

describe('vcpkg manifests', () => {
  const deps = (m) =>
    Object.fromEntries(m.dependencies.map((d) => (typeof d === 'string' ? [d, {}] : [d.name, d])));

  it('build Ceres without SuiteSparse or LAPACK, and COLMAP without its GPL and online features', () => {
    const m = json('colmap/vcpkg.json');
    const d = deps(m);
    expect(d.ceres).toMatchObject({
      'default-features': false,
      features: ['eigensparse', 'schur'],
    });
    expect(d.openimageio).toMatchObject({ 'default-features': false });
    expect(d['minizip-ng']).toMatchObject({ 'default-features': false, features: ['zlib'] });
    expect(m.features).toBeUndefined();
    expect(m['default-features']).toBeUndefined();
    const text = JSON.stringify(m.dependencies);
    for (const banned of [
      'suitesparse',
      'cgal',
      'qtbase',
      'glew',
      'curl',
      'openssl',
      'cuda',
      'onnx',
    ])
      expect(text, banned).not.toContain(banned);
    expect(d.lapack.platform).toBe('windows');
  });

  it('build PDAL without plugins or network', () => {
    const d = deps(json('pdal/vcpkg.json'));
    for (const p of ['pdal', 'gdal', 'proj', 'curl', 'libxml2', 'sqlite3'])
      expect(d[p]['default-features'], p).toBe(false);
    expect(d.proj.features).toEqual(['tiff']);
    expect(d.pdal.features).toBeUndefined();
  });

  it('pin the registry baseline COLMAP 4.2.1 builds with', () => {
    expect(vcpkgConfiguration(components, { overlayPorts: ['cmake/vcpkg/ports'] })).toEqual({
      'default-registry': {
        kind: 'git',
        repository: 'https://github.com/microsoft/vcpkg',
        baseline: '127402f1c75bb3d5ff6bce04b285faa4930a5aca',
      },
      'overlay-ports': ['cmake/vcpkg/ports'],
      'overlay-triplets': [],
    });
  });
});

describe('COLMAP and pycolmap', () => {
  const colmap = byName.colmap;
  const ctx = {
    src: 's',
    build: 'b',
    install: 'i',
    vcpkgRoot: 'v',
    vcpkgInstalled: 'vi',
    triplet: 'x64-windows-stratlas',
    hostTriplet: 'x64-windows-release',
    overlayTriplets: 'ot',
    fetchContent: 'fc',
    projectInclude: 'pi.cmake',
    deploymentTarget: '14.0',
  };

  it('pins 4.2.1 by commit and applies the CHOLMOD patch', () => {
    expect(colmap).toMatchObject({
      tag: '4.2.1',
      commit: 'bd1fcf654d2dd8fefa1466999c190a246f83f4b9',
    });
    const patch = readFileSync(join(NATIVE_DIR, colmap.patches[0]), 'utf8');
    expect(patch).toContain('option(CHOLMOD_ENABLED');
    expect(patch).toMatch(/\+if\(CHOLMOD_ENABLED\)\n\+ {4}find_package\(CHOLMOD REQUIRED\)/);
    expect(patch).toContain('+set(CHOLMOD_ENABLED @CHOLMOD_ENABLED@)');
    expect(patch).toContain(
      '+#if defined(COLMAP_CHOLMOD_ENABLED)\n #include <Eigen/CholmodSupport>',
    );
    expect(patch).toContain('"without CHOLMOD"');
    expect(patch).not.toMatch(/\r\n/);
  });

  it('configures every option the gate requires, with the value it requires', () => {
    for (const [k, v] of Object.entries(colmap.require)) expect(colmap.cmake[k], k).toBe(v);
    for (const k of [
      'LSD_ENABLED',
      'CGAL_ENABLED',
      'CUDA_ENABLED',
      'GUI_ENABLED',
      'OPENGL_ENABLED',
      'DOWNLOAD_ENABLED',
      'ONNX_ENABLED',
      'CHOLMOD_ENABLED',
    ])
      expect(colmap.require[k], k).toBe('OFF');
    const win = colmapConfigure(colmap, { ...ctx, platform: 'win32' });
    expect(win).toEqual(
      expect.arrayContaining([
        '-DLSD_ENABLED=OFF',
        '-DCHOLMOD_ENABLED=OFF',
        '-DVCPKG_TARGET_TRIPLET=x64-windows-stratlas',
        '-DCMAKE_PROJECT_INCLUDE=pi.cmake',
        '-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreadedDLL',
      ]),
    );
    expect(win.join(' ')).not.toMatch(/CMAKE_CXX_FLAGS=/);
    const mac = colmapConfigure(colmap, {
      ...ctx,
      platform: 'darwin',
      libomp: '/opt/homebrew/opt/libomp',
    });
    expect(mac).toEqual(
      expect.arrayContaining([
        '-G',
        'Ninja',
        '-DCMAKE_OSX_DEPLOYMENT_TARGET=14.0',
        '-DOpenMP_ROOT=/opt/homebrew/opt/libomp',
      ]),
    );
  });

  it('builds pycolmap against that COLMAP, without stubs', () => {
    const s = pycolmapSettings({ ...ctx, platform: 'win32' });
    expect(s).toContain('--config-settings=cmake.define.CMAKE_PREFIX_PATH=i');
    expect(s).toContain('--config-settings=cmake.define.GENERATE_STUBS=OFF');
    expect(s).toContain('--config-settings=cmake.define.CMAKE_PROJECT_INCLUDE=pi.cmake');
    // MSVC's OpenMP needs no hints
    expect(s.join(' ')).not.toMatch(/OpenMP/);
  });

  it('gives COLMAP, pycolmap and PoissonRecon the same libomp hints on macOS', () => {
    // pycolmap's CMakeLists predates policy CMP0074, so OpenMP_ROOT alone is ignored there
    // (pack-native darwin-arm64: "Could NOT find OpenMP_C (missing: OpenMP_C_FLAGS ...)").
    const libomp = '/opt/homebrew/opt/libomp';
    const hints = openmpHints({ platform: 'darwin', libomp });
    expect(hints).toEqual({
      CMAKE_POLICY_DEFAULT_CMP0074: 'NEW',
      OpenMP_ROOT: libomp,
      OpenMP_C_FLAGS: `-Xpreprocessor -fopenmp -I${libomp}/include`,
      OpenMP_CXX_FLAGS: `-Xpreprocessor -fopenmp -I${libomp}/include`,
      OpenMP_C_LIB_NAMES: 'omp',
      OpenMP_CXX_LIB_NAMES: 'omp',
      OpenMP_omp_LIBRARY: `${libomp}/lib/libomp.dylib`,
    });
    expect(openmpHints({ platform: 'win32', libomp })).toEqual({});
    expect(openmpHints({ platform: 'darwin' })).toEqual({});
    const mac = { ...ctx, platform: 'darwin', libomp };
    const settings = pycolmapSettings(mac);
    const configure = colmapConfigure(colmap, mac);
    const poisson = poissonConfigure({ ...mac, src: 's', build: 'b' });
    for (const [k, v] of Object.entries(hints)) {
      expect(settings).toContain(`--config-settings=cmake.define.${k}=${v}`);
      expect(configure).toContain(`-D${k}=${v}`);
      expect(poisson).toContain(`-D${k}=${v}`);
    }
  });

  it('defines EIGEN_MPL2_ONLY without replacing compiler flags', () => {
    expect(readFileSync(join(NATIVE_DIR, 'colmap', 'project-include.cmake'), 'utf8')).toMatch(
      /^add_compile_definitions\(EIGEN_MPL2_ONLY\)$/m,
    );
  });
});

describe('OpenCV', () => {
  it('builds the headless wheel without FFmpeg, GStreamer, videoio, IPP or non-free code', () => {
    const c = byName['opencv-python-headless'];
    expect(c).toMatchObject({ tag: '93', commit: 'b83046cda41133f1bf2e73e99dba16a1248f103a' });
    const env = opencvEnv(c);
    expect(env).toMatchObject({ ENABLE_HEADLESS: '1', ENABLE_CONTRIB: '0' });
    for (const flag of [
      '-DWITH_FFMPEG=OFF',
      '-DWITH_GSTREAMER=OFF',
      '-DBUILD_opencv_videoio=OFF',
      '-DOPENCV_ENABLE_NONFREE=OFF',
      '-DWITH_IPP=OFF',
    ])
      expect(env.CMAKE_ARGS).toContain(flag);
    for (const [k, v] of Object.entries(c.require)) expect(c.cmake[k], k).toBe(v);
  });
});

describe('PoissonRecon (for G3)', () => {
  const c = byName.poissonrecon;

  it('is pinned by commit (no upstream tags) and installs where photo/native.py looks', () => {
    expect(c).toMatchObject({
      status: 'required',
      commit: '262b0f539d404057d1f36e1adc07fc9388678899',
    });
    expect(c.tag).toBeUndefined();
    expect(c.outputs).toEqual([
      'tools/poissonrecon/bin/PoissonRecon*',
      'tools/poissonrecon/bin/SurfaceTrimmer*',
    ]);
  });

  it('builds both tools from upstream sources with the vendored image libraries as C', () => {
    const text = readFileSync(join(NATIVE_DIR, 'poissonrecon', 'CMakeLists.txt'), 'utf8');
    expect(text).toMatch(/foreach\(tool PoissonRecon SurfaceTrimmer\)/);
    expect(text).toMatch(/foreach\(lib ZLIB PNG JPEG\)/);
    expect(text).toMatch(/PROPERTIES LANGUAGE C\)/);
    expect(text).toMatch(/install\(TARGETS PoissonRecon SurfaceTrimmer RUNTIME DESTINATION bin\)/);
    const mac = poissonConfigure({
      platform: 'darwin',
      src: 's',
      build: 'b',
      deploymentTarget: '14.0',
      libomp: '/opt/homebrew/opt/libomp',
    });
    expect(mac).toEqual(
      expect.arrayContaining(['-DPOISSONRECON_SOURCE=s', '-DOpenMP_ROOT=/opt/homebrew/opt/libomp']),
    );
    expect(poissonConfigure({ platform: 'win32', src: 's', build: 'b' })).toContain('-A');
  });
});

describe('build output helpers', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'native-build-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reads options back from a CMake cache', () => {
    const cache = parseCMakeCache(
      [
        '// comment',
        'LSD_ENABLED:BOOL=OFF',
        'CMAKE_BUILD_TYPE:STRING=Release',
        'X:INTERNAL=1',
      ].join('\n'),
    );
    expect(pick(cache, ['LSD_ENABLED', 'CMAKE_BUILD_TYPE', 'MISSING'])).toEqual({
      LSD_ENABLED: 'OFF',
      CMAKE_BUILD_TYPE: 'Release',
    });
  });

  it('lists the ports vcpkg installed with their SBOM licence and linkage', () => {
    const t = 'x64-windows-stratlas';
    mkdirSync(join(dir, 'vcpkg', 'info'), { recursive: true });
    writeFileSync(
      join(dir, 'vcpkg', 'info', `zlib_1.3.2_${t}.list`),
      `${t}/include/zlib.h\n${t}/lib/zs.lib\n`,
    );
    writeFileSync(join(dir, 'vcpkg', 'info', `pdal_2.10.1_${t}.list`), `${t}/bin/pdalcpp.dll\n`);
    writeFileSync(join(dir, 'vcpkg', 'info', `zlib_1.3.2_x64-windows-release.list`), 'host\n');
    mkdirSync(join(dir, t, 'share', 'zlib'), { recursive: true });
    writeFileSync(
      join(dir, t, 'share', 'zlib', 'vcpkg.spdx.json'),
      JSON.stringify({
        packages: [
          {
            name: 'zlib',
            SPDXID: 'SPDXRef-port',
            versionInfo: '1.3.2#2',
            licenseConcluded: 'Zlib',
          },
        ],
      }),
    );
    expect(installedPorts(dir, t).map(({ sbom, ...p }) => ({ ...p, sbom: Boolean(sbom) }))).toEqual(
      [
        { name: 'pdal', version: '2.10.1', licence: null, linkage: 'shared', sbom: false },
        { name: 'zlib', version: '1.3.2', licence: 'Zlib', linkage: 'static', sbom: true },
      ],
    );
  });
});
