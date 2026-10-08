// The native build recipe (M10 G1): pinned, licence-clean options, and the helpers build-native.mjs
// uses. The build itself runs in CI (pack-native); these tests keep the recipe honest on every merge.
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  NATIVE_DIR,
  PDAL_PLUGIN,
  buildOpencv,
  colmapConfigure,
  forbiddenInWheel,
  installedPorts,
  installPdalTool,
  loadComponents,
  checkBuildRequires,
  missingRpathLibs,
  opencvEnv,
  pdalSelect,
  wheelListArgs,
  openmpHints,
  parseCMakeCache,
  pick,
  poissonConfigure,
  pycolmapRequirements,
  pycolmapSettings,
  pycolmapWheelArgs,
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
    pybind11Dir: 'py/pybind11/share/cmake/pybind11',
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

  it('builds the pycolmap wheel the same way on both platforms, with its pinned build requirements', () => {
    // --no-build-isolation: pack-native win32-x64 found no pybind11 config, since our
    // CMAKE_PREFIX_PATH replaces the prefixes scikit-build-core adds
    for (const platform of ['win32', 'darwin']) {
      const reqs = pycolmapRequirements(colmap, platform);
      expect(reqs).toEqual(
        expect.arrayContaining(['scikit-build-core==1.1.1', 'pybind11==3.0.4', 'numpy==2.5.3']),
      );
      expect(reqs).toContain(platform === 'win32' ? 'delvewheel==1.13.1' : 'delocate==0.13.0');
      for (const r of reqs) expect(r, r).toMatch(/^[A-Za-z0-9._-]+==\S+$/);
      const args = pycolmapWheelArgs({
        ...ctx,
        platform,
        raw: 'raw',
        libomp: '/opt/homebrew/opt/libomp',
      });
      expect(args.slice(0, 8)).toEqual([
        '-m',
        'pip',
        'wheel',
        's',
        '--no-deps',
        '--no-build-isolation',
        '-w',
        'raw',
      ]);
      expect(args).toContain(
        '--config-settings=cmake.define.pybind11_DIR=py/pybind11/share/cmake/pybind11',
      );
      expect(args.some((a) => a.includes('OpenMP_omp_LIBRARY'))).toBe(platform === 'darwin');
    }
    expect(() => pycolmapSettings({ ...ctx, platform: 'win32', pybind11Dir: undefined })).toThrow(
      /pybind11/,
    );
  });

  it('covers every build requirement of pycolmap 4.2.1, or says why one is left out', () => {
    // [build-system] requires of colmap/pyproject.toml at the pinned commit
    const upstream = [
      'scikit-build-core>=0.3.3',
      'pybind11==3.0.4',
      'pybind11_stubgen @ git+https://github.com/sarlinpe/pybind11-stubgen@sarlinpe/fix-2025-08-20',
      'numpy',
      'ruff==0.15.20',
      'clang-format==22.1.5',
    ];
    expect(checkBuildRequires(upstream, colmap.pycolmap)).toEqual([]);
    expect(checkBuildRequires(['pybind11==3.0.5', 'cmake>=3.30'], colmap.pycolmap)).toEqual([
      'pybind11==3.0.5: components.json pins pybind11==3.0.4',
      'cmake>=3.30: not in components.json pycolmap.buildRequires',
    ]);
    expect(checkBuildRequires(['Scikit_Build.Core'], colmap.pycolmap)).toEqual([]);
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

  it('patches setup.py so a Windows build without FFmpeg does not require the FFmpeg DLL', () => {
    // pack-native win32-x64: "Exception: Not found: 'bin/opencv_videoio_ffmpeg\d{3}_64\.dll'"
    const c = byName['opencv-python-headless'];
    expect(c.patches).toEqual(['opencv-python/patches/0001-no-ffmpeg-dll.patch']);
    const patch = readFileSync(join(NATIVE_DIR, c.patches[0]), 'utf8');
    expect(patch).toContain('diff --git a/setup.py b/setup.py');
    expect(patch).toContain('-            if os.name == "nt"\n');
    expect(patch).toContain(
      '+            if os.name == "nt" and "-DWITH_FFMPEG=OFF" not in os.environ.get("CMAKE_ARGS", "")\n',
    );
    expect(patch).not.toMatch(/\r\n/);
    // the condition the patch reads is what our environment passes
    expect(opencvEnv(c).CMAKE_ARGS.split(' ')).toContain('-DWITH_FFMPEG=OFF');
  });

  describe('the build step', () => {
    let work;
    beforeEach(() => {
      work = mkdtempSync(join(tmpdir(), 'native-opencv-'));
    });
    afterEach(() => rmSync(work, { recursive: true, force: true }));

    const plan = async (platform) => {
      const calls = [];
      const r = {
        plan: true,
        run: (cmd, args, opts = {}) => {
          calls.push({ cmd, args, opts });
          return '';
        },
      };
      const ctx = { work, out: join(work, 'out'), platform, python: 'python' };
      await buildOpencv(r, byName['opencv-python-headless'], ctx);
      return calls;
    };

    it('applies the patch on Windows before building the wheel, then checks the wheel', async () => {
      const calls = await plan('win32');
      const src = join(work, 'src', 'opencv-python');
      const apply = calls.findIndex((x) => x.cmd === 'git' && x.args.includes('apply'));
      const wheel = calls.findIndex((x) => x.args[2] === 'wheel');
      expect(apply).toBeGreaterThan(0);
      expect(calls[apply].args).toEqual([
        '-C',
        src,
        'apply',
        '--verbose',
        join(NATIVE_DIR, 'opencv-python', 'patches', '0001-no-ffmpeg-dll.patch'),
      ]);
      expect(wheel).toBeGreaterThan(apply);
      expect(calls[wheel].opts.env.CMAKE_ARGS).toContain('-DWITH_FFMPEG=OFF');
      const list = calls.slice(wheel + 1).find((x) => x.args[1]?.includes('zipfile'));
      expect(list?.args.at(-1)).toMatch(/opencv_python_headless-.*\.whl$/);
    });

    it('applies the same patch on macOS, where it changes nothing', async () => {
      const calls = await plan('darwin');
      expect(calls.some((x) => x.cmd === 'git' && x.args.includes('apply'))).toBe(true);
    });
  });

  it('refuses a wheel that holds an FFmpeg DLL or another forbidden file', () => {
    expect(
      forbiddenInWheel([
        'cv2/__init__.py',
        'cv2/cv2.pyd',
        'opencv_python_headless-5.0.0.93.dist-info/RECORD',
      ]),
    ).toEqual([]);
    const bad = forbiddenInWheel([
      'cv2/cv2.pyd',
      'cv2/opencv_videoio_ffmpeg4130_64.dll',
      'opencv_python_headless.libs/avcodec-61.dll',
      'pycolmap.libs/cholmod.dll',
    ]);
    expect(bad).toHaveLength(3);
    expect(bad[0]).toMatch(/opencv_videoio_ffmpeg4130_64\.dll: forbidden \(OpenCV FFmpeg plugin/);
    expect(bad[1]).toMatch(/avcodec-61\.dll: forbidden \(FFmpeg/);
    expect(wheelListArgs('w.whl').at(-1)).toBe('w.whl');
  });
});

describe('PDAL tool files', () => {
  const lib = (name, type = 'file', target) => ({
    name,
    type,
    ...(type === 'symlink' ? { target, targetIsDir: false } : {}),
  });

  it('copies libpdalcpp alone into lib on macOS: no plugins, folders, aliases or archives', () => {
    // pack-native darwin-arm64: "Recursive option not enabled, cannot copy a directory:
    // .../lib/libpdal_plugin_kernel_fauxplugin.20.dylib/", a symbolic link Node's cpSync with
    // `dereference` takes for a folder.
    const { copy, skip } = pdalSelect(
      [
        lib('libpdal_plugin_kernel_fauxplugin.20.1.0.dylib'),
        lib(
          'libpdal_plugin_kernel_fauxplugin.20.dylib',
          'symlink',
          '/v/lib/libpdal_plugin_kernel_fauxplugin.20.1.0.dylib',
        ),
        lib('libpdalcpp.20.1.0.dylib'),
        lib('libpdalcpp.20.dylib', 'symlink', '/v/lib/libpdalcpp.20.1.0.dylib'),
        lib('libpdalcpp.dylib', 'symlink', '/v/lib/libpdalcpp.20.1.0.dylib'),
        lib('libpdalcpp.20.1.0.dylib.dSYM', 'dir'),
        { name: 'libpdalcpp.19.dylib', type: 'symlink', target: '/v/x', targetIsDir: true },
        lib('libgdal.a'),
        lib('pkgconfig', 'dir'),
      ],
      'lib',
      'darwin',
      '/v/lib',
    );
    expect(copy).toEqual([
      { name: 'libpdalcpp.20.1.0.dylib', from: join('/v/lib', 'libpdalcpp.20.1.0.dylib') },
    ]);
    expect(Object.fromEntries(skip.map((s) => [s.name, s.why]))).toEqual({
      'libgdal.a': 'not part of the PDAL tool',
      'libpdal_plugin_kernel_fauxplugin.20.1.0.dylib': 'a PDAL plugin (the pack ships none)',
      'libpdal_plugin_kernel_fauxplugin.20.dylib': 'a PDAL plugin (the pack ships none)',
      'libpdalcpp.19.dylib': 'a folder',
      'libpdalcpp.20.1.0.dylib.dSYM': 'a folder',
      'libpdalcpp.20.dylib': 'a link to libpdalcpp.20.1.0.dylib, which is copied',
      'libpdalcpp.dylib': 'a link to libpdalcpp.20.1.0.dylib, which is copied',
      pkgconfig: 'a folder',
    });
  });

  it('copies a link to a file elsewhere as that file, and refuses a broken link', () => {
    expect(
      pdalSelect(
        [lib('libpdalcpp.20.dylib', 'symlink', '/cellar/libpdalcpp.20.1.0.dylib')],
        'lib',
        'darwin',
        '/v/lib',
      ).copy,
    ).toEqual([{ name: 'libpdalcpp.20.dylib', from: '/cellar/libpdalcpp.20.1.0.dylib' }]);
    expect(() =>
      pdalSelect([lib('libpdalcpp.20.dylib', 'symlink', null)], 'lib', 'darwin', '/v/lib'),
    ).toThrow(/broken symbolic link/);
  });

  it('refuses a native library the recipe does not know rather than drop or ship it', () => {
    expect(() => pdalSelect([lib('libgeos_c.1.dylib')], 'lib', 'darwin', '/v/lib')).toThrow(
      /libgeos_c\.1\.dylib: a native file the PDAL recipe does not ship/,
    );
    expect(() => pdalSelect([lib('zlib1.dll')], 'bin', 'win32', 'C:/v/tools/pdal')).toThrow(
      /zlib1\.dll/,
    );
  });

  it('copies pdal.exe and pdalcpp.dll on Windows, without plugins', () => {
    const { copy, skip } = pdalSelect(
      [
        lib('pdal.exe'),
        lib('pdalcpp.dll'),
        lib('libpdal_plugin_kernel_fauxplugin.dll'),
        lib('pdal.pdb'),
      ],
      'bin',
      'win32',
      'v',
    );
    expect(copy.map((c) => c.name)).toEqual(['pdal.exe', 'pdalcpp.dll']);
    expect(skip.map((s) => s.name)).toEqual(['libpdal_plugin_kernel_fauxplugin.dll', 'pdal.pdb']);
    expect(PDAL_PLUGIN.test('libpdal_plugin_reader_e57.dll')).toBe(true);
    expect(PDAL_PLUGIN.test('libpdalcpp.dylib')).toBe(false);
  });

  it('finds the @rpath libraries the tool links that lib does not have', () => {
    const otool = [
      '/o/tools/pdal/bin/pdal:',
      '\t@rpath/libpdalcpp.20.1.0.dylib (compatibility version 20.0.0, current version 20.1.0)',
      '\t/usr/lib/libc++.1.dylib (compatibility version 1.0.0, current version 1800.101.0)',
      '\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1351.0.0)',
    ].join('\n');
    expect(missingRpathLibs(otool, ['libpdalcpp.20.1.0.dylib'])).toEqual([]);
    expect(missingRpathLibs(otool, ['libpdalcpp.20.dylib'])).toEqual(['libpdalcpp.20.1.0.dylib']);
  });

  describe('on disk', () => {
    let dir;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'native-pdal-'));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    const put = (rel, body = 'x') => {
      const p = join(dir, ...rel.split('/'));
      mkdirSync(join(p, '..'), { recursive: true });
      writeFileSync(p, body);
    };
    const files = (root) =>
      readdirSync(root, { recursive: true, withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => relative(root, join(e.parentPath, e.name)).split('\\').join('/'))
        .sort();
    const runner = (otool) => {
      const calls = [];
      return {
        calls,
        plan: false,
        run: (cmd, args) => {
          calls.push([cmd, ...args].join(' '));
          return cmd === 'otool' ? otool : '';
        },
      };
    };
    const linksWork = () => {
      try {
        symlinkSync('libpdalcpp.20.1.0.dylib', join(dir, 't', 'lib', 'libpdalcpp.20.dylib'));
        symlinkSync(
          'libpdal_plugin_kernel_fauxplugin.20.1.0.dylib',
          join(dir, 't', 'lib', 'libpdal_plugin_kernel_fauxplugin.20.dylib'),
        );
        return true;
      } catch {
        return false; // Windows without the symlink privilege: the folder case still runs
      }
    };

    it('installs the macOS tool from a vcpkg tree with plugins, folders and links', () => {
      put('t/tools/pdal/pdal', 'tool');
      put('t/lib/libpdalcpp.20.1.0.dylib', 'lib');
      put('t/lib/libpdal_plugin_kernel_fauxplugin.20.1.0.dylib', 'faux');
      put('t/lib/libgdal.a', 'a');
      put('t/lib/pkgconfig/pdal.pc', 'pc');
      put('t/share/proj/proj.db', 'db');
      put('t/share/proj/vcpkg.spdx.json', '{}');
      // a folder with a library's name, as the CI error reported one
      mkdirSync(join(dir, 't', 'lib', 'libpdal_plugin_kernel_fauxplugin.dylib'));
      const links = linksWork();
      const r = runner('\t@rpath/libpdalcpp.20.1.0.dylib (compatibility version 20.0.0)\n');
      installPdalTool(r, { platform: 'darwin' }, join(dir, 't'), join(dir, 'out'));
      expect(files(join(dir, 'out'))).toEqual([
        'bin/pdal',
        'lib/libpdalcpp.20.1.0.dylib',
        'share/proj/proj.db',
      ]);
      expect(readFileSync(join(dir, 'out', 'lib', 'libpdalcpp.20.1.0.dylib'), 'utf8')).toBe('lib');
      expect(r.calls.map((c) => c.split(' ')[0])).toEqual([
        'install_name_tool',
        'codesign',
        'otool',
      ]);
      expect(links || process.platform === 'win32').toBe(true);
    });

    it('fails when the tool links a library lib does not have', () => {
      put('t/tools/pdal/pdal', 'tool');
      put('t/lib/libpdalcpp.20.1.0.dylib', 'lib');
      const r = runner('\t@rpath/libpdalcpp.20.dylib (compatibility version 20.0.0)\n');
      expect(() =>
        installPdalTool(r, { platform: 'darwin' }, join(dir, 't'), join(dir, 'out')),
      ).toThrow(/links libpdalcpp\.20\.dylib, which tools\/pdal\/lib does not have/);
    });

    it('installs the Windows tool from tools/pdal alone', () => {
      put('t/tools/pdal/pdal.exe', 'MZ');
      put('t/tools/pdal/pdalcpp.dll', 'MZ');
      put('t/bin/libpdal_plugin_kernel_fauxplugin.dll', 'MZ');
      put('t/share/gdal/gdalvrt.xsd', 'x');
      const r = runner('');
      installPdalTool(r, { platform: 'win32' }, join(dir, 't'), join(dir, 'out'));
      expect(files(join(dir, 'out'))).toEqual([
        'bin/pdal.exe',
        'bin/pdalcpp.dll',
        'share/gdal/gdalvrt.xsd',
      ]);
      expect(r.calls).toEqual([]);
    });
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
