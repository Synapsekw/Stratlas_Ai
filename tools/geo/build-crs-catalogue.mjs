#!/usr/bin/env node
// The EPSG catalogue of the CRS search (M11 G1, data-conventions section 25, ADR 0010).
//
// 1. Runs `python -m aio_pipelines.geodesy.catalogue` in python/ (uv), which reads PROJ's proj.db
//    through pyproj: one row per EPSG projected, geographic, vertical and compound CRS, and for each
//    projected CRS a proj4 candidate with 25 points over its area of use projected by PROJ.
// 2. Keeps `proj4` only where proj4js reproduces PROJ at all 25 points within 1 mm.
// 3. Writes packages/geo/src/catalogue/epsg.json.gz (gzip level 9, no timestamp: reproducible),
//    budget 1.5 MB.
//
// Usage: node tools/geo/build-crs-catalogue.mjs [--from rows.json] [--check]
//   --from   reuse a rows file the python step wrote (skips python)
//   --check  build in memory and fail when it differs from the committed file
// Runs offline: PROJ's database ships in the pyproj wheel.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..');
const OUT = join(repo, 'packages', 'geo', 'src', 'catalogue', 'epsg.json.gz');
const BUDGET = 1.5 * 1024 * 1024;
const TOLERANCE_M = 0.001;

const require = createRequire(join(repo, 'packages', 'geo', 'package.json'));
const proj4 = require('proj4');

/** True when proj4js projects every sample within 1 mm of PROJ. */
export function proj4Matches(check) {
  let conv;
  try {
    conv = proj4(check.geog4, check.proj4);
  } catch {
    return false;
  }
  for (const [lon, lat, x, y] of check.samples) {
    let p;
    try {
      p = conv.forward([lon, lat]);
    } catch {
      return false;
    }
    if (!Array.isArray(p) || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) return false;
    const d = Math.hypot(p[0] - x, p[1] - y) * check.toMetre;
    if (!(d <= TOLERANCE_M)) return false;
  }
  return true;
}

/** Rows of the python step to catalogue entries (proj4 only where it matched). */
export function toEntries(rows) {
  let checked = 0;
  let kept = 0;
  const entries = rows.map((r) => {
    const { _check: check, ...entry } = r;
    if (check) {
      checked++;
      if (proj4Matches(check)) {
        kept++;
        return { ...entry, proj4: check.proj4 };
      }
    }
    return entry;
  });
  return { entries, checked, kept };
}

function pythonRows() {
  const dir = mkdtempSync(join(tmpdir(), 'crs-catalogue-'));
  const file = join(dir, 'rows.json');
  try {
    execFileSync(
      'uv',
      ['run', '--frozen', 'python', '-m', 'aio_pipelines.geodesy.catalogue', '--out', file],
      { cwd: join(repo, 'python'), stdio: ['ignore', 'inherit', 'inherit'] },
    );
    return JSON.parse(readFileSync(file, 'utf8'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function main(argv) {
  const fromIdx = argv.indexOf('--from');
  const meta = fromIdx >= 0 ? JSON.parse(readFileSync(argv[fromIdx + 1], 'utf8')) : pythonRows();
  const { entries, checked, kept } = toEntries(meta.rows);
  const doc = {
    format: 'epsg-catalogue',
    version: 1,
    source: `EPSG dataset in PROJ ${meta.proj} (pyproj ${meta.pyproj})`,
    entries,
  };
  const gz = gzipSync(Buffer.from(JSON.stringify(doc), 'utf8'), { level: 9 });
  process.stdout.write(
    `${entries.length} CRSs; proj4 kept for ${kept} of ${checked} projected; ${(gz.length / 1024).toFixed(0)} KiB gz
`,
  );
  if (gz.length > BUDGET) {
    console.error(`The catalogue is over its 1.5 MB budget (${gz.length} bytes).`);
    process.exit(1);
  }
  if (argv.includes('--check')) {
    const old = gunzipSync(readFileSync(OUT)).toString('utf8');
    if (old !== JSON.stringify(doc)) {
      console.error('The committed catalogue differs from a fresh build.');
      process.exit(1);
    }
    return;
  }
  writeFileSync(OUT, gz);
  process.stdout.write(`Wrote ${OUT}
`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
