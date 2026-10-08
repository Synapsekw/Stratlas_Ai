import { SiteTransform, type F64Grid } from '@aio/schema';
import proj4 from 'proj4';
import { crsDefinition } from './index';

/**
 * The renderer's side of the site transform (M11 G1, ADR 0010, data-conventions section 25).
 *
 * PROJ in the pipeline pack writes `survey/geodesy/site-transform.json` and its float64 tables
 * (`python/src/aio_pipelines/geodesy/site.py` `write_site_tables`); this module only interpolates
 * them bilinearly, so the renderer never re-implements a datum, a geoid or a calibration:
 *
 * - `grid` (two bands): the display E and N, metres, of each data E, N;
 * - `geoidGrid` (one band): `N_eff`, subtracted from a stored height to give the displayed height
 *   (the geoid undulation, with the calibration's inclined plane folded in when heights follow it).
 *
 * Without a `grid`, horizontal readouts use proj4js with `proj4` (a pure projection PROJ checked
 * at 25 points over the site). All values are metres; units are a display choice (`units.ts`).
 */

/** One float64 table with its header. */
export interface F64Table {
  grid: F64Grid;
  values: Float64Array;
}

/** Read the little-endian float64 bytes of a table, checking their size against its header. */
export function f64Table(grid: F64Grid, bytes: ArrayBuffer | Uint8Array): F64Table {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes, 0, bytes.byteLength);
  const n = grid.rows * grid.cols * grid.bands;
  if (view.byteLength !== n * 8) {
    throw new Error(
      `${grid.file} has ${String(view.byteLength)} bytes; its header says ${String(n * 8)}.`,
    );
  }
  const values = new Float64Array(n);
  const dv = new DataView(view.buffer, view.byteOffset, view.byteLength);
  for (let i = 0; i < n; i++) values[i] = dv.getFloat64(i * 8, true);
  return { grid, values };
}

/**
 * Bilinear interpolation of band `band` at (x, y) in the data CRS; null outside the table or on
 * a nodata (NaN) cell.
 */
export function sampleTable(t: F64Table, x: number, y: number, band = 0): number | null {
  const { originX, originY, spacingM, cols, rows, bands } = t.grid;
  const fx = (x - originX) / spacingM;
  const fy = (y - originY) / spacingM;
  if (!(fx >= 0 && fy >= 0 && fx <= cols - 1 && fy <= rows - 1)) return null;
  const i0 = Math.min(Math.floor(fx), cols - 2);
  const j0 = Math.min(Math.floor(fy), rows - 2);
  const tx = fx - i0;
  const ty = fy - j0;
  const at = (i: number, j: number) => t.values[(j * cols + i) * bands + band] ?? NaN;
  const v =
    (1 - tx) * (1 - ty) * at(i0, j0) +
    tx * (1 - ty) * at(i0 + 1, j0) +
    (1 - tx) * ty * at(i0, j0 + 1) +
    tx * ty * at(i0 + 1, j0 + 1);
  return Number.isFinite(v) ? v : null;
}

/** What a readout shows: display E, N and height, metres, and what they were computed with. */
export interface SiteReadout {
  e: number;
  n: number;
  /** Null when no height was given or the geoid table does not cover the point. */
  z: number | null;
}

export interface SiteTransformer {
  header: SiteTransform;
  /** Data CRS (E, N, z) to the display coordinates; null outside the site's tables. */
  toSite(e: number, n: number, z?: number): SiteReadout | null;
}

/**
 * The transformer of a site from its header and table bytes (as read from
 * `survey/geodesy/<file>`). Throws when the header is not an `aio.site-transform/1` or a table
 * does not match its header.
 */
export function createSiteTransform(
  header: unknown,
  tables: { grid?: ArrayBuffer | Uint8Array; geoidGrid?: ArrayBuffer | Uint8Array } = {},
  /** proj4 of the data CRS for the proj4js path (default: the bundled registry's). */
  fromProj4?: string,
): SiteTransformer {
  const h = SiteTransform.parse(header);
  const grid = h.grid && tables.grid ? f64Table(h.grid, tables.grid) : null;
  if (grid && grid.grid.bands !== 2) throw new Error('The site grid needs two bands (E, N).');
  const geoid = h.geoidGrid && tables.geoidGrid ? f64Table(h.geoidGrid, tables.geoidGrid) : null;
  if (h.geoidGrid && !geoid) throw new Error(`${h.geoidGrid.file} was not given.`);
  let projector: proj4.Converter | null = null;
  if (!grid) {
    const from = fromProj4 ?? ('epsg' in h.from ? crsDefinition(h.from.epsg) : undefined);
    if (!h.proj4 || !from) {
      throw new Error('The site transform has no grid and no proj4 definition to use.');
    }
    projector = proj4(from, h.proj4);
  }
  const toMetre = proj4ToMetre(h.proj4);
  return {
    header: h,
    toSite(e, n, z) {
      let x: number;
      let y: number;
      if (grid) {
        const gx = sampleTable(grid, e, n, 0);
        const gy = sampleTable(grid, e, n, 1);
        if (gx === null || gy === null) return null;
        x = gx;
        y = gy;
      } else if (projector) {
        const [px, py] = projector.forward([e, n]);
        if (!Number.isFinite(px) || !Number.isFinite(py)) return null;
        x = px * toMetre;
        y = py * toMetre;
      } else return null;
      let height: number | null = z ?? null;
      if (height !== null && geoid) {
        const nEff = sampleTable(geoid, e, n, 0);
        height = nEff === null ? null : height - nEff;
      }
      return { e: x, n: y, z: height };
    },
  };
}

/** Metres per unit of a proj4 string (`+units=us-ft`, `+to_meter=`), 1 by default. */
function proj4ToMetre(def: string | undefined): number {
  if (!def) return 1;
  const to = /\+to_meter=([\d.eE+-]+)/.exec(def);
  if (to?.[1]) return Number(to[1]);
  if (/\+units=us-ft\b/.test(def)) return 1200 / 3937;
  if (/\+units=ft\b/.test(def)) return 0.3048;
  return 1;
}
