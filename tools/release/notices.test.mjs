import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  NOTICES,
  dataInventory,
  jsEntries,
  jsInventory,
  nativeInventory,
  pythonLicense,
  render,
  withPlatformBuilds,
} from './notices.mjs';

describe('licence inventory', () => {
  it('leaves workspace packages out and sorts by name', () => {
    const entries = jsEntries({
      MIT: [
        { name: 'zod', versions: ['4.6.5'], license: 'MIT' },
        { name: '@aio/schema', versions: ['0.1.0'], license: 'MIT' },
      ],
      'Apache-2.0': [{ name: 'alpha', versions: ['1.0.0', '1.1.0'] }],
    });
    expect(entries.map((e) => [e.name, e.version, e.license])).toEqual([
      ['alpha', '1.0.0, 1.1.0', 'Apache-2.0'],
      ['zod', '4.6.5', 'MIT'],
    ]);
  });

  it('names a Python licence by expression, short text or classifier', () => {
    expect(pythonLicense({ expression: 'MIT', license: 'x' })).toBe('MIT');
    expect(pythonLicense({ license: 'The MIT License (MIT)' })).toBe('MIT');
    expect(
      pythonLicense({
        license: 'Files: *\nCopyright: ...',
        classifiers: ['License :: OSI Approved :: BSD License'],
      }),
    ).toBe('BSD (classifier)');
    expect(pythonLicense({ license: '' })).toBe('see package');
    expect(pythonLicense({ name: 'python-dateutil', license: 'Dual License' })).toBe(
      'Apache-2.0 AND BSD-3-Clause',
    );
  });

  it('renders both sections with counts', () => {
    const md = render(
      [{ name: 'a|b', version: '1', license: 'MIT' }],
      [{ name: 'numpy', version: '2', license: 'BSD-3-Clause' }],
    );
    expect(md).toContain('1 packages: MIT (1).');
    expect(md).toContain('| a\\|b | 1 | MIT |');
    expect(md).toContain('| numpy | 2 | BSD-3-Clause |');
  });

  it('adds the Windows and macOS builds of a native package from the lockfile', () => {
    const lock = [
      "  '@napi-rs/keyring-darwin-arm64@2.1.0':",
      "  '@napi-rs/keyring-darwin-x64@2.1.0':",
      "  '@napi-rs/keyring-linux-x64-gnu@2.1.0':",
      "  '@napi-rs/keyring-win32-x64-msvc@2.1.0':",
    ].join('\n');
    const entries = withPlatformBuilds(
      [{ name: '@napi-rs/keyring-win32-x64-msvc', version: '2.1.0', license: 'MIT', homepage: '' }],
      lock,
    );
    expect(entries.map((e) => [e.name, e.license])).toEqual([
      ['@napi-rs/keyring-darwin-arm64', 'MIT'],
      ['@napi-rs/keyring-darwin-x64', 'MIT'],
      ['@napi-rs/keyring-win32-x64-msvc', 'MIT'],
    ]);
  });

  it('renders the native libraries and the map data (M10 G1)', () => {
    const native = nativeInventory(
      {
        libs: [{ name: 'gdal', version: '3.12', spdx: 'MIT', source: 'https://gdal.org' }],
        ports: [{ name: 'zlib', version: '1.3.2', spdx: 'Zlib' }],
      },
      {
        components: [
          {
            name: 'colmap',
            version: '4.2.1',
            spdx: 'BSD-3-Clause',
            source: 'https://colmap',
            status: 'required',
            includes: [{ name: 'faiss', version: '1.14.1', spdx: 'MIT' }],
          },
          { name: 'texrecon', spdx: 'BSD-3-Clause', status: 'deferred' },
        ],
      },
    );
    expect(native.builds.map((b) => b.name)).toEqual(['colmap', 'faiss (in colmap)']);
    const md = render([], [], native, [
      { name: 'Copernicus DEM GLO-30', kind: 'terrain', license: 'X', attribution: '© DLR' },
    ]);
    expect(md).toContain('## Pipeline pack native libraries');
    expect(md).toContain('| gdal | 3.12 | MIT |');
    expect(md).toContain('| faiss (in colmap) | 1.14.1 | MIT |');
    expect(md).toContain('| zlib | 1.3.2 | Zlib |');
    expect(md).toContain('## Map and imagery data');
    expect(md).toContain('| Copernicus DEM GLO-30 | terrain | X | © DLR |');
    expect(md).not.toContain('texrecon');
  });

  it('lists every native library and data source of the inventories', () => {
    const committed = readFileSync(NOTICES, 'utf8');
    const native = nativeInventory();
    const missing = [...native.libs, ...native.builds, ...native.ports, ...dataInventory()]
      .map((e) => e.name)
      .filter((n) => !committed.includes(`| ${n} `));
    expect(missing).toEqual([]);
  });

  it('lists every npm package that ships (regenerate with node tools/release/notices.mjs)', () => {
    const committed = readFileSync(NOTICES, 'utf8');
    const missing = jsInventory()
      .map((e) => e.name)
      .filter((n) => !committed.includes(`| ${n} `));
    expect(missing).toEqual([]);
  }, 60_000);
});
