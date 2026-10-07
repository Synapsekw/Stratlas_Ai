// Imagery and terrain packs from open sources (M10 G7, decision 4), for `build-packs.mjs
// --imagery`, `--terrain` and `--estimate`. A manual tool, never run in CI and never by the app:
// download the source tiles yourself (the URLs below), then build the pack offline with the
// development pipeline Python (`python/.venv`), which runs the same `packs.imagery` and
// `packs.terrain` pipelines the app's Import uses. Every source carries its licence, attribution
// and provenance into the pack metadata; only sources whose licence allows offline
// redistribution are listed, and anything else is refused (no EOX cloudless 2018 to 2025, no
// Cesium ion, Bing, Google, Esri, Mapbox or Maxar/Vantor).
//
//   node tools/maps/build-packs.mjs --imagery --source=sentinel2-mosaic --year=2025 \
//        --id=gcc-s2 --label="GCC Sentinel-2 2025" --src=D:/downloads/s2 [--max-zoom=13]
//   node tools/maps/build-packs.mjs --terrain --source=cop-dem-glo30 --id=gcc-dem \
//        --label="GCC terrain" --src=D:/downloads/glo30 [--max-zoom=12]
//   node tools/maps/build-packs.mjs --estimate --bbox=46,16,60,30 --max-zoom=13 [--terrain]
//
// Env: QUADRION_DATA (the data root; packs go to <data>/packs/imagery or packs/terrain),
// QUADRION_PIPELINE_PYTHON (default python/.venv).

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { envVar } from '../../packages/brand/src/env.ts';

/**
 * Open sources we may pack and redistribute (plan, "Imagery and terrain: sources and licences").
 * `{year}` in an attribution is filled from `--year`.
 */
export const RASTER_SOURCES = {
  'sentinel2-mosaic': {
    kind: 'imagery',
    licence: 'Copernicus Sentinel data legal notice (free, full and open)',
    attribution: 'Contains modified Copernicus Sentinel data {year}',
    provenance: 'Copernicus Sentinel-2 Global Mosaic {year}',
    url: 'https://stac.dataspace.copernicus.eu/v1/collections/sentinel-2-global-mosaics',
  },
  'worldcover-2021': {
    kind: 'imagery',
    licence: 'CC-BY-4.0',
    attribution:
      '© ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium',
    provenance: 'ESA WorldCover S2 RGBNIR composite 2021',
    url: 'https://esa-worldcover.org/en/data-access',
  },
  'blue-marble': {
    kind: 'imagery',
    licence: 'public-domain',
    attribution: 'NASA Earth Observatory',
    provenance: 'NASA Blue Marble Next Generation',
    url: 'https://visibleearth.nasa.gov/collection/1484/blue-marble',
  },
  landsat: {
    kind: 'imagery',
    licence: 'public-domain',
    attribution: 'Landsat imagery courtesy of the U.S. Geological Survey',
    provenance: 'USGS Landsat {year}',
    url: 'https://earthexplorer.usgs.gov/',
  },
  'natural-earth': {
    kind: 'imagery',
    licence: 'public-domain',
    attribution: 'Made with Natural Earth',
    provenance: 'Natural Earth II raster',
    url: 'https://www.naturalearthdata.com/downloads/',
  },
  'cop-dem-glo30': {
    kind: 'terrain',
    datum: 'egm2008',
    licence: 'Copernicus WorldDEM-30 licence (free, redistribution allowed)',
    attribution:
      'produced using Copernicus WorldDEM-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved',
    provenance: 'Copernicus DEM GLO-30',
    url: 'https://dataspace.copernicus.eu/explore-data/data-collections/copernicus-contributing-missions/collections-description/COP-DEM',
  },
  'cop-dem-glo90': {
    kind: 'terrain',
    datum: 'egm2008',
    licence: 'Copernicus WorldDEM-90 licence (free, redistribution allowed)',
    attribution:
      'produced using Copernicus WorldDEM-90 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved',
    provenance: 'Copernicus DEM GLO-90',
    url: 'https://dataspace.copernicus.eu/explore-data/data-collections/copernicus-contributing-missions/collections-description/COP-DEM',
  },
  nasadem: {
    kind: 'terrain',
    datum: 'egm96',
    licence: 'public-domain',
    attribution: 'NASADEM, NASA JPL',
    provenance: 'NASADEM',
    url: 'https://www.earthdata.nasa.gov/data/catalog/lpcloud-nasadem-hgt-001',
  },
};

/** Typical bytes per tile, measured on our synthetic and sample builds (WebP 256 px). */
const TILE_BYTES = { imagery: 18_000, terrain: 55_000 };

const arg = (argv, name) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

function tileXY(lon, lat, z) {
  const n = 2 ** z;
  const r = (Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI) / 180;
  return [
    Math.min(n - 1, Math.floor(((lon + 180) / 360) * n)),
    Math.min(n - 1, Math.floor(((1 - Math.asinh(Math.tan(r)) / Math.PI) / 2) * n)),
  ];
}

/** Tiles of a bbox from zoom 0 to `maxZoom`, and the pack size they suggest. */
export function estimateRasterPack(bbox, maxZoom, kind = 'imagery') {
  const [w, s, e, n] = bbox;
  let tiles = 0;
  for (let z = 0; z <= maxZoom; z++) {
    const [x0, y0] = tileXY(w, n, z);
    const [x1, y1] = tileXY(e, s, z);
    tiles += (x1 - x0 + 1) * (y1 - y0 + 1);
  }
  return { tiles, bytes: tiles * TILE_BYTES[kind] };
}

function python(repo) {
  const venv =
    process.platform === 'win32'
      ? join(repo, 'python', '.venv', 'Scripts', 'python.exe')
      : join(repo, 'python', '.venv', 'bin', 'python');
  return envVar(process.env, 'PIPELINE_PYTHON') ?? venv;
}

const RUN = `
import json, sys, threading
from pathlib import Path
from aio_pipelines.pipelines import all_pipelines
from aio_pipelines.runtime import Job
name, work, raw = sys.argv[1], sys.argv[2], sys.argv[3]
params = json.loads(raw)
pipe = all_pipelines()[name]
params = pipe.validate(params)
def emit(method, msg):
    if method == "progress" and msg.get("message"):
        print(f"  {msg['step']}: {msg['message']}", flush=True)
    elif method in ("log", "error"):
        print(f"  {msg.get('message')}", flush=True)
Job("build-" + params["id"], pipe, Path(work), params, emit, threading.Event()).run()
`;

/** `--imagery`, `--terrain` and `--estimate`; returns false when none of them was asked. */
export function rasterPackMode({ argv, repo, dataRoot, log }) {
  const flags = new Set(argv.filter((a) => a.startsWith('--') && !a.includes('=')));
  if (flags.has('--estimate')) {
    const bbox = (arg(argv, 'bbox') ?? '-180,-85,180,85').split(',').map(Number);
    const maxZoom = Number(arg(argv, 'max-zoom') ?? 13);
    const kind = flags.has('--terrain') ? 'terrain' : 'imagery';
    const { tiles, bytes } = estimateRasterPack(bbox, maxZoom, kind);
    log(
      `${kind} pack over ${bbox.join(', ')} to zoom ${maxZoom}: ${tiles.toLocaleString('en')} tiles, about ${(bytes / 2 ** 30).toFixed(2)} GB`,
    );
    return true;
  }
  const kind = flags.has('--imagery') ? 'imagery' : flags.has('--terrain') ? 'terrain' : null;
  if (!kind) return false;
  const sourceName = arg(argv, 'source');
  const source = RASTER_SOURCES[sourceName ?? ''];
  if (!source)
    throw new Error(
      `--source must be one of: ${Object.keys(RASTER_SOURCES).join(', ')} (licences that allow redistribution).`,
    );
  if (source.kind !== kind) throw new Error(`${sourceName} is a ${source.kind} source.`);
  const id = arg(argv, 'id');
  const label = arg(argv, 'label');
  const src = arg(argv, 'src');
  if (!id || !label || !src) throw new Error('--id, --label and --src are required.');
  const year = arg(argv, 'year') ?? String(new Date().getUTCFullYear());
  const fill = (s) => s.replaceAll('{year}', year);
  const dest = join(dataRoot, 'packs', kind);
  const work = join(dataRoot, 'packs', '.jobs');
  mkdirSync(dest, { recursive: true });
  mkdirSync(work, { recursive: true });
  const params = {
    src: src.split(','),
    dest,
    id,
    label,
    licence: source.licence,
    attribution: fill(source.attribution),
    provenance: fill(source.provenance),
    ...(arg(argv, 'max-zoom') ? { maxZoom: Number(arg(argv, 'max-zoom')) } : {}),
    ...(kind === 'imagery' ? { customerLicence: false } : { verticalDatum: source.datum }),
  };
  const py = python(repo);
  if (!existsSync(py)) throw new Error(`No pipeline Python at ${py}: run uv sync in python/.`);
  log(`${kind} pack ${id} from ${sourceName} (${source.url})`);
  execFileSync(py, ['-c', RUN, `packs.${kind}`, work, JSON.stringify(params)], {
    stdio: 'inherit',
    cwd: join(repo, 'python'),
  });
  // how the pack arrived, as street packs say it (RasterPackInfo.source)
  const metaPath = join(dest, `${id}.json`);
  const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
  writeFileSync(metaPath, `${JSON.stringify({ ...meta, source: 'build-tool' }, null, 1)}\n`);
  log(`done: ${join(dest, `${id}.pmtiles`)}`);
  return true;
}
