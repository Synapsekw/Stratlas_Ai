// Regional geoid packs from PROJ-data (M11 G1, decision 5), for `build-packs.mjs --geoid`.
// A manual tool, never run in CI and never by the app, and it never downloads anything: put the
// PROJ-data grid files on this machine yourself (https://cdn.proj.org/ or the proj-data release
// archive, https://download.osgeo.org/proj/), then build the packs offline:
//
//   node tools/maps/build-packs.mjs --geoid --from=D:/downloads/proj-data [AUSGeoid2020 GEOID18 ...]
//   node tools/maps/build-packs.mjs --geoid --list
//
// Each pack is `<data>/packs/geoid/<id>.tif` with `<id>.json` (`aio.geoid-pack/1`): the grid
// copied byte for byte, its extent (read by the development pipeline Python through rasterio),
// sha256 and size, and the licence and attribution below, which ship with every height the pack
// gives. With no names, every pack whose file is in --from is built; missing files are listed.
//
// Env: QUADRION_DATA (the data root), QUADRION_PIPELINE_PYTHON (default python/.venv).

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { envVar } from '../../packages/brand/src/env.ts';

/**
 * Regional geoid grids of PROJ-data with their licences (M11 plan, decision 5). OSTN15 is the
 * horizontal OSGB36 grid that British National Grid needs; it travels the same way.
 */
export const GEOID_SOURCES = {
  AUSGeoid2020: {
    name: 'AUSGeoid2020 (Australia)',
    projFile: 'au_ga_AUSGeoid2020_20180201.tif',
    horizontalEpsg: 7844,
    verticalEpsg: 9458,
    licence: 'CC-BY-4.0',
    attribution: '© Commonwealth of Australia (Geoscience Australia), AUSGeoid2020, CC BY 4.0',
  },
  GEOID18: {
    name: 'GEOID18 (conterminous United States)',
    projFile: 'us_noaa_g2018u0.tif',
    horizontalEpsg: 6318,
    verticalEpsg: 5703,
    licence: 'public-domain',
    attribution: 'NOAA National Geodetic Survey, GEOID18',
  },
  OSGM15: {
    name: 'OSGM15 (Great Britain)',
    projFile: 'uk_os_OSGM15_GB.tif',
    horizontalEpsg: 4937,
    verticalEpsg: 5701,
    licence: 'BSD-2-Clause',
    attribution: '© Ordnance Survey, OSGM15 (BSD 2-Clause licence)',
  },
  OSTN15: {
    name: 'OSTN15 horizontal grid (Great Britain, for British National Grid)',
    projFile: 'uk_os_OSTN15_NTv2_OSGBtoETRS.tif',
    horizontalEpsg: 27700,
    licence: 'BSD-2-Clause',
    attribution: '© Ordnance Survey, OSTN15 (BSD 2-Clause licence)',
  },
  NZGeoid2016: {
    name: 'NZGeoid2016 (New Zealand)',
    projFile: 'nz_linz_nzgeoid2016.tif',
    horizontalEpsg: 4167,
    verticalEpsg: 7839,
    licence: 'CC-BY-4.0',
    attribution: 'Land Information New Zealand (LINZ), NZGeoid2016, CC BY 4.0',
  },
  CGG2013: {
    name: 'CGG2013a (Canada, NAD83(CSRS))',
    projFile: 'ca_nrc_CGG2013an83.tif',
    horizontalEpsg: 4617,
    verticalEpsg: 6647,
    licence: 'Open Government Licence - Canada',
    attribution:
      'Contains information licensed under the Open Government Licence - Canada (NRCan, CGG2013a)',
  },
};

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** The grid's extent in degrees, read by rasterio in the development pipeline Python. */
function gridBbox(repo, python, path) {
  const code = [
    'import json, sys, rasterio',
    'with rasterio.open(sys.argv[1]) as d:',
    '    b = d.bounds',
    '    print(json.dumps([b.left, b.bottom, b.right, b.top]))',
  ].join('\n');
  const out = execFileSync(python, ['-c', code, path], {
    cwd: join(repo, 'python'),
    encoding: 'utf8',
  });
  const [w, s, e, n] = JSON.parse(out);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const lon = (v) => (v > 180 ? v - 360 : v);
  return [clamp(lon(w), -180, 180), clamp(s, -90, 90), clamp(lon(e), -180, 180), clamp(n, -90, 90)];
}

/** `--geoid` mode of build-packs.mjs: true when it handled the arguments. */
export function geoidPackMode({ argv, repo, dataRoot, log }) {
  if (!argv.includes('--geoid')) return false;
  if (argv.includes('--list')) {
    for (const [id, s] of Object.entries(GEOID_SOURCES)) log(`${id}: ${s.projFile} (${s.licence})`);
    return true;
  }
  const from = argv.find((a) => a.startsWith('--from='))?.slice(7);
  if (!from) throw new Error('--geoid needs --from=<folder with PROJ-data grid files>.');
  const names = argv.filter((a) => !a.startsWith('--'));
  const ids = names.length ? names : Object.keys(GEOID_SOURCES);
  const python =
    envVar(process.env, 'PIPELINE_PYTHON') ??
    join(
      repo,
      'python',
      '.venv',
      process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
    );
  const dir = join(dataRoot, 'packs', 'geoid');
  mkdirSync(dir, { recursive: true });
  for (const id of ids) {
    const s = GEOID_SOURCES[id];
    if (!s) throw new Error(`Unknown geoid pack ${id}; --geoid --list names them.`);
    const src = join(from, s.projFile);
    if (!existsSync(src)) {
      log(`${id}: ${s.projFile} is not in ${from}; skipped (nothing is downloaded).`);
      continue;
    }
    const grid = join(dir, s.projFile);
    copyFileSync(src, grid);
    const meta = {
      schema: 'aio.geoid-pack/1',
      id,
      name: s.name,
      bbox: gridBbox(repo, python, grid),
      horizontalEpsg: s.horizontalEpsg,
      ...(s.verticalEpsg ? { verticalEpsg: s.verticalEpsg } : {}),
      projFile: s.projFile,
      licence: s.licence,
      attribution: s.attribution,
      provenance: `PROJ-data ${s.projFile}, packed ${new Date().toISOString().slice(0, 10)}`,
      sha256: sha256(grid),
      bytes: statSync(grid).size,
    };
    writeFileSync(join(dir, `${id}.json`), `${JSON.stringify(meta, null, 2)}\n`);
    log(`${id}: ${grid}`);
  }
  return true;
}
