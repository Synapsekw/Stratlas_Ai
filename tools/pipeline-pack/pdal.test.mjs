import { describe, expect, it } from 'vitest';
import {
  explicitSpec,
  keepWindows,
  lockedPackages,
  MICROMAMBA,
  otoolLibs,
  PDAL_SPEC,
  PLATFORMS,
} from './pdal.mjs';

describe('the PDAL lock', () => {
  it('has every pack platform, each with PDAL, GDAL and PROJ pinned by SHA-256', () => {
    for (const platform of Object.keys(PLATFORMS)) {
      const pkgs = lockedPackages(platform);
      const names = pkgs.map((p) => p.name);
      expect(names).toEqual(expect.arrayContaining(['libpdal-core', 'libgdal-core', 'proj']));
      expect(pkgs.find((p) => p.name === 'libpdal-core').version).toBe(PDAL_SPEC.split('==')[1]);
      for (const p of pkgs) {
        expect(p.url).toMatch(/^https:\/\/conda\.anaconda\.org\/conda-forge\//);
        expect(p.url).toMatch(new RegExp(`/(${PLATFORMS[platform].subdir}|noarch)/`));
        expect(p.sha256).toMatch(/^[a-f0-9]{64}$/);
      }
      expect(MICROMAMBA.assets[platform].sha256).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it('refuses a platform it has no packages for', () => {
    expect(() => lockedPackages('linux-x64')).toThrow('no packages for linux-x64');
  });

  it('becomes a conda explicit file', () => {
    expect(explicitSpec([{ url: 'https://x/a-1-0.conda', sha256: 'ab' }])).toBe(
      '@EXPLICIT\nhttps://x/a-1-0.conda#ab\n',
    );
  });
});

describe('what of the environment goes into the pack', () => {
  it('keeps the program, its DLLs and the PROJ and GDAL data on Windows', () => {
    expect(keepWindows('Library/bin/pdal.exe')).toBe('Library/bin/pdal.exe');
    expect(keepWindows('Library/bin/gdal.dll')).toBe('Library/bin/gdal.dll');
    expect(keepWindows('vcruntime140.dll')).toBe('Library/bin/vcruntime140.dll');
    expect(keepWindows('Library/share/proj/proj.db')).toBe('Library/share/proj/proj.db');
    expect(keepWindows('Library/share/gdal/gdalvrt.xsd')).toBe('Library/share/gdal/gdalvrt.xsd');
  });

  it('leaves out other programs, headers, import libraries, symbols and plugins', () => {
    for (const rel of [
      'Library/bin/gdalinfo.exe',
      'Library/bin/libcrypto-3-x64.pdb',
      'Library/include/pdal/pdal.hpp',
      'Library/lib/gdal.lib',
      'Library/share/doc/proj/LICENSE',
      'Library/bin/mod_spatialite.dll',
      'Library/bin/libpdal_plugin_kernel_fauxplugin.dll',
      'conda-meta/proj-9.9.0.json',
    ])
      expect(keepWindows(rel), rel).toBeNull();
  });

  it('follows the dylibs a macOS program loads from the environment', () => {
    const text = [
      '/env/bin/pdal:',
      '\t@rpath/libpdalcpp.19.dylib (compatibility version 19.0.0, current version 19.2.0)',
      '\t@loader_path/../lib/libgdal.37.dylib (compatibility version 37.0.0, current version 37.3.13)',
      '\t/usr/lib/libc++.1.dylib (compatibility version 1.0.0, current version 1700.255.0)',
      '\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1345.100.2)',
    ].join('\n');
    expect(otoolLibs(text)).toEqual(['libpdalcpp.19.dylib', 'libgdal.37.dylib']);
  });
});
