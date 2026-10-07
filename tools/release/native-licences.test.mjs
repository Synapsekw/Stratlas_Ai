// The native licence gate (M10 G1) on fixture SBOMs and fixture packs: a planted suitesparse-spqr,
// an LGPL static library and an unknown DLL each fail, a clean set passes, and the inventory the
// repository commits (native-libs.json) is consistent with the policy.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadPolicy } from './licence-policy.mjs';
import {
  checkComponents,
  checkFiles,
  checkPorts,
  distOwners,
  globToRegExp,
  loadInventory,
  nativeFiles,
  portLinkage,
  pythonLicence,
  readSbom,
  runGate,
} from './native-licences.mjs';

let root;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'native-gate-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const put = (rel, body = 'x') => {
  const p = join(root, ...rel.split('/'));
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, body);
  return p;
};

const policy = loadPolicy({
  allowed: {
    spdx: ['MIT', 'BSD-3-Clause', 'Apache-2.0', 'BSL-1.0', 'Zlib'],
    native: ['libpng-2.0'],
  },
  mpl: [{ name: 'eigen', aliases: ['eigen3'], ecosystem: 'native', approved: '2026-10-07' }],
  lgplShared: [
    { name: 'geos', ecosystem: 'native', approved: '2026-10-07' },
    { name: 'libiconv', ecosystem: 'native', approved: 'pending' },
  ],
  runtimes: [],
});

const inventory = {
  forbiddenPorts: [
    { name: 'suitesparse-spqr', why: 'GPL' },
    { name: 'curl', why: 'no downloads in COLMAP', components: ['colmap'] },
  ],
  forbiddenFiles: [{ pattern: 'cholmod|spqr', why: 'SuiteSparse' }],
  ports: [
    { name: 'boost-*', version: '1.92.0', spdx: 'BSL-1.0' },
    { name: 'eigen3', version: '5.0.1', spdx: 'MPL-2.0' },
    { name: 'zlib', version: '1.3.2', spdx: 'Zlib' },
    { name: 'curl', version: '8.21.0', spdx: 'MIT' },
    { name: 'gdal', version: '3.12.4', spdx: 'MIT' },
    { name: 'geos', version: '3.14.1', spdx: 'LGPL-2.1-only' },
  ],
  libs: [
    { name: 'gdal', spdx: 'MIT', files: ['**/rasterio.libs/gdal*.dll'], linkage: 'shared' },
    { name: 'geos', spdx: 'LGPL-2.1-only', files: ['**/*.libs/geos*.dll'], linkage: 'shared' },
    { name: 'libiconv', spdx: 'LGPL-2.1-or-later', files: ['**/*.libs/iconv*.dll'] },
    { name: 'pdal', spdx: 'BSD-3-Clause', files: ['tools/pdal/bin/pdal.exe'] },
  ],
};

const sbom = (name, version, licence) => ({
  packages: [
    {
      name,
      SPDXID: 'SPDXRef-port',
      versionInfo: version,
      licenseConcluded: licence,
      licenseDeclared: 'NOASSERTION',
    },
    { name: `${name}:x64-windows`, SPDXID: 'SPDXRef-binary', versionInfo: 'abc' },
  ],
});

describe('globs', () => {
  it('match folders with ** and names with *, ignoring case', () => {
    const re = globToRegExp('**/rasterio.libs/gdal*.dll');
    expect(re.test('python/Lib/site-packages/rasterio.libs/gdal-ca23e679.dll')).toBe(true);
    expect(re.test('rasterio.libs/GDAL.dll')).toBe(true);
    expect(re.test('python/rasterio.libs/sub/gdal.dll')).toBe(false);
    expect(globToRegExp('tools/pdal/bin/pdal').test('tools/pdal/bin/pdal')).toBe(true);
    expect(globToRegExp('tools/pdal/bin/pdal').test('x/tools/pdal/bin/pdal')).toBe(false);
  });
});

describe('vcpkg SBOMs', () => {
  it('reads the port package of an SBOM', () => {
    expect(readSbom(sbom('zlib', '1.3.2#1', 'Zlib'))).toEqual({
      name: 'zlib',
      version: '1.3.2',
      licence: 'Zlib',
    });
    expect(readSbom(sbom('gdal', '3.12.4', 'NOASSERTION')).licence).toBeNull();
    expect(readSbom(sbom('clapack', '3.2.1', 'LicenseRef-vcpkg-null')).licence).toBeNull();
  });

  it('tells shared from static ports by their installed files', () => {
    expect(portLinkage(['x64-windows/bin/geos.dll', 'x64-windows/lib/geos.lib'])).toBe('shared');
    expect(portLinkage(['arm64-osx/lib/libgeos.3.14.dylib'])).toBe('shared');
    expect(portLinkage(['x64-windows/lib/geos.lib', 'x64-windows/include/geos.h'])).toBe('static');
    expect(portLinkage(['x64-windows/include/Eigen/Core'])).toBe('header');
  });

  const ports = (list) => checkPorts(list, inventory, policy);

  it('passes a clean set, header-only MPL and a shared LGPL port', () => {
    const r = ports([
      { name: 'boost-graph', version: '1.92.0', licence: 'BSL-1.0', linkage: 'static' },
      { name: 'eigen3', version: '5.0.1', licence: 'MPL-2.0', linkage: 'header' },
      { name: 'zlib', version: '1.3.2', licence: 'Zlib', linkage: 'static' },
      { name: 'gdal', version: '3.12.4', licence: null, linkage: 'static' },
      { name: 'geos', version: '3.14.1', licence: 'LGPL-2.1-only', linkage: 'shared' },
      { name: 'curl', version: '8.21.0', licence: 'MIT', linkage: 'static', component: 'pdal' },
    ]);
    expect(r.problems).toEqual([]);
  });

  it('fails a planted suitesparse-spqr', () => {
    const r = ports([
      {
        name: 'suitesparse-spqr',
        version: '4.3.6',
        licence: 'GPL-2.0-or-later',
        linkage: 'static',
      },
    ]);
    expect(r.problems.join('\n')).toMatch(/suitesparse-spqr.*forbidden.*GPL/);
  });

  it('fails curl only inside COLMAP', () => {
    const r = ports([
      { name: 'curl', version: '8.21.0', licence: 'MIT', linkage: 'static', component: 'colmap' },
    ]);
    expect(r.problems.join('\n')).toMatch(/curl.*colmap.*no downloads/);
  });

  it('fails an LGPL port linked statically', () => {
    const r = ports([
      { name: 'geos', version: '3.14.1', licence: 'LGPL-2.1-only', linkage: 'static' },
    ]);
    expect(r.problems.join('\n')).toMatch(/geos.*LGPL.*static/);
  });

  it('fails an unknown port, a new version and a GPL licence', () => {
    const r = ports([
      { name: 'leftpad', version: '1.0', licence: 'MIT', linkage: 'static' },
      { name: 'zlib', version: '1.3.3', licence: 'Zlib', linkage: 'static' },
      { name: 'gdal', version: '3.12.4', licence: 'GPL-2.0-only', linkage: 'static' },
    ]);
    const text = r.problems.join('\n');
    expect(text).toMatch(/leftpad.*no row in native-libs.json/);
    expect(text).toMatch(/zlib 1\.3\.3.*native-libs.json says 1\.3\.2/);
    expect(text).toMatch(/gdal.*GPL-2.0-only/);
  });
});

describe('pack files', () => {
  const sitePackages = 'python/Lib/site-packages';
  const dist = (name, version, licence, files, extra = '') => {
    const info = `${sitePackages}/${name}-${version}.dist-info`;
    put(
      `${info}/METADATA`,
      `Metadata-Version: 2.4\nName: ${name}\nVersion: ${version}\n${licence}${extra}\n`,
    );
    put(
      `${info}/RECORD`,
      [...files, `${name}-${version}.dist-info/RECORD,,`].map((f) => `${f},sha256=x,1`).join('\n'),
    );
    for (const f of files) put(`${sitePackages}/${f}`);
  };

  it('finds native files by extension, and executables under tools/ by their header', () => {
    put('python/DLLs/_ssl.pyd');
    put('python/Lib/site-packages/x/_core.cpython-313-darwin.so');
    put('python/vendor/libz.so.1');
    put('tools/pdal/bin/pdal', Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0]));
    put('tools/pdal/share/proj/proj.db', 'SQLite format 3');
    put('python/Lib/os.py');
    expect(nativeFiles(root).sort()).toEqual([
      'python/DLLs/_ssl.pyd',
      'python/Lib/site-packages/x/_core.cpython-313-darwin.so',
      'python/vendor/libz.so.1',
      'tools/pdal/bin/pdal',
    ]);
  });

  it('maps files to the distribution that installed them, with its licence', () => {
    dist('rasterio', '1.5.2', 'License-Expression: BSD-3-Clause', [
      'rasterio/_io.cp313-win_amd64.pyd',
      'rasterio.libs/gdal-ca23e679.dll',
    ]);
    const owners = distOwners(root);
    expect(owners.get(`${sitePackages}/rasterio/_io.cp313-win_amd64.pyd`)).toMatchObject({
      name: 'rasterio',
      licence: 'BSD-3-Clause',
    });
  });

  it('names a Python licence by expression, short text or classifier', () => {
    expect(pythonLicence({ expression: 'MIT' })).toBe('MIT');
    expect(pythonLicence({ license: 'The MIT License (MIT)' })).toBe('MIT');
    expect(pythonLicence({ license: 'Apache 2.0' })).toBe('Apache-2.0');
    expect(pythonLicence({ license: 'Files: *\n...', classifiers: ['BSD License'] })).toBe(
      'BSD-3-Clause',
    );
    expect(pythonLicence({ license: 'Copyright (c) someone' })).toBeNull();
  });

  const gate = () => {
    const files = nativeFiles(root);
    return checkFiles(files, distOwners(root), inventory, policy, { root });
  };

  it('passes a clean pack: extension modules by their distribution, vendored DLLs by rows', () => {
    dist('rasterio', '1.5.2', 'License-Expression: BSD-3-Clause', [
      'rasterio/_io.cp313-win_amd64.pyd',
      'rasterio.libs/gdal-ca23e679.dll',
      'rasterio.libs/geos_c-ee12.dll',
    ]);
    put('tools/pdal/bin/pdal.exe', 'MZ');
    const r = gate();
    expect(r.problems).toEqual([]);
    expect(r.pending).toEqual([]);
  });

  it('fails an unknown DLL with its file name', () => {
    dist('rasterio', '1.5.2', 'License-Expression: BSD-3-Clause', ['rasterio.libs/mystery-1.dll']);
    expect(gate().problems.join('\n')).toMatch(/rasterio\.libs\/mystery-1\.dll.*no row/);
  });

  it('fails a forbidden file even when a row would match it', () => {
    dist('pycolmap', '4.2.1', 'License-Expression: BSD-3-Clause', ['pycolmap.libs/cholmod.dll']);
    expect(gate().problems.join('\n')).toMatch(/cholmod\.dll.*forbidden.*SuiteSparse/);
  });

  it('fails an LGPL static archive', () => {
    put('tools/pdal/lib/geos.lib');
    put('tools/pdal/lib/libgeos.a');
    const text = gate().problems.join('\n');
    expect(text).toMatch(/geos\.lib.*LGPL.*static/);
    expect(text).toMatch(/libgeos\.a.*LGPL.*static/);
  });

  it('fails an extension module of a GPL or unknown distribution', () => {
    dist('gplthing', '1.0', 'License-Expression: GPL-3.0-only', ['gplthing/_x.pyd']);
    dist('mystery', '1.0', 'License: see LICENSE file', ['mystery/_y.pyd']);
    const text = gate().problems.join('\n');
    expect(text).toMatch(/gplthing.*GPL-3.0-only/);
    expect(text).toMatch(/mystery.*cannot classify/);
  });

  it('reports an LGPL library waiting for approval as pending, not as a problem', () => {
    dist('rasterio', '1.5.2', 'License-Expression: BSD-3-Clause', ['rasterio.libs/iconv-2-ab.dll']);
    const r = gate();
    expect(r.problems).toEqual([]);
    expect(r.pending).toEqual(['libiconv']);
  });
});

describe('built components', () => {
  it('fails a component built with a forbidden option or licence', () => {
    const r = checkComponents(
      [
        {
          name: 'colmap',
          spdx: 'BSD-3-Clause',
          status: 'built',
          require: { LSD_ENABLED: 'OFF', CHOLMOD_ENABLED: 'OFF' },
          cmake: { LSD_ENABLED: 'ON', CHOLMOD_ENABLED: 'OFF' },
        },
        { name: 'faiss', spdx: 'MIT', status: 'built' },
        { name: 'thing', spdx: 'AGPL-3.0-only', status: 'built' },
        { name: 'texrecon', spdx: 'BSD-3-Clause', status: 'deferred' },
      ],
      policy,
    );
    expect(r.problems.join('\n')).toMatch(/colmap.*LSD_ENABLED=ON.*OFF/);
    expect(r.problems.join('\n')).toMatch(/thing.*AGPL/);
    expect(r.problems).toHaveLength(2);
  });
});

describe('the committed inventory', () => {
  it('judges every row and port of native-libs.json under the real policy', () => {
    const inv = loadInventory();
    const real = loadPolicy();
    const r = checkPorts(
      inv.ports.map((p) => ({
        name: p.name === 'boost-*' ? 'boost-graph' : p.name,
        version: p.version,
        licence: p.spdx,
        linkage: 'static',
      })),
      inv,
      real,
    );
    expect(r.problems).toEqual([]);
    for (const row of inv.libs) {
      expect(row.files.length, row.name).toBeGreaterThan(0);
      expect(row.source, row.name).toMatch(/^https?:\/\//);
    }
  });

  it('runs end to end on a folder and reports what it found', () => {
    put('tools/pdal/bin/pdal.exe', 'MZ');
    const out = runGate({ scan: [root], policy, inventory });
    expect(out.problems).toEqual([]);
    expect(out.files).toBe(1);
  });
});
