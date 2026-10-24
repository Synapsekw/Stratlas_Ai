/**
 * Prepared surfaces from the old stockpile kit's DSM grids. A project imported from the kit has
 * dated terrain meshes and orthos but no DSM raster or point cloud, so `survey.prepare` has nothing
 * to read; the kit's own DSM of each survey (`volumes.json` epoch, `kitDsmPath`) holds the heights
 * its volumes were measured on. The app converts that grid into the same `aio.height-tiles/1`
 * surface a prepare job writes (source `kit-dsm`), one per survey date, so charts, cards, the
 * volume engine and the date states read it like any other. Heights stay as the kit reads them:
 * `zoff + cm / 100`, absolute in the project CRS, with no date line-up.
 */
import type { HeightTiles, ProjectManifest, VolumesFile } from '@aio/schema';
import { encodeTile, TILE } from '@aio/survey';
import { decodeDsm, type DsmGrid } from '@aio/volumetric';
import { kitDsmPath } from './kitHeights';

type Crs = HeightTiles['crs'];
interface TileFile {
  path: string;
  data: Uint8Array<ArrayBuffer>;
}

/** One surface to make from the kit DSM of a survey date. */
export interface KitSurfaceSpec {
  id: string;
  name: string;
  source: { kind: 'kit-dsm'; epoch: string };
  capture: string;
}

/** Version of the conversion; part of each surface's fingerprint. */
const KIT_SURFACE_VERSION = 1;

/** The date has a DSM raster or a point cloud of its own: `survey.prepare` makes its surface. */
const hasOwnSource = (manifest: Pick<ProjectManifest, 'layers'>, capture: string) =>
  manifest.layers.some(
    (l) =>
      l.capture === capture &&
      ((l.kind === 'raster' && l.role === 'dsm') || l.kind === 'pointcloud'),
  );

/**
 * The kit surfaces to make: one per kit survey (epoch) whose date is in the project, has no
 * prepared surface and no DSM or point cloud of its own; only the dates in `only` when given.
 */
export function kitSurfaceSources(
  manifest: Pick<ProjectManifest, 'captures' | 'layers'>,
  volumes: Pick<VolumesFile, 'captures'> | null,
  prepared: readonly HeightTiles[],
  only?: readonly string[],
): KitSurfaceSpec[] {
  if (!volumes) return [];
  const label = new Map(manifest.captures.map((c) => [c.id, c.label]));
  const have = new Set(prepared.flatMap((p) => (p.capture ? [p.capture] : [])));
  const wanted = only ? new Set(only) : null;
  const out: KitSurfaceSpec[] = [];
  const taken = new Set<string>();
  for (const c of volumes.captures) {
    const capture = c.captureId;
    if (!label.has(capture) || have.has(capture) || taken.has(capture)) continue;
    if ((wanted && !wanted.has(capture)) || hasOwnSource(manifest, capture)) continue;
    taken.add(capture);
    out.push({
      id: `kit-dsm-${c.epoch}`.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 80),
      name: `${label.get(capture) ?? capture} kit DSM`,
      source: { kind: 'kit-dsm', epoch: c.epoch },
      capture,
    });
  }
  return out;
}

/** The dates (capture ids) a kit surface can be made for (the date state "missing" until made). */
export function kitSurfaceDates(
  manifest: Pick<ProjectManifest, 'captures' | 'layers'>,
  volumes: Pick<VolumesFile, 'captures'> | null,
): string[] {
  return kitSurfaceSources(manifest, volumes, []).map((s) => s.capture);
}

/** Level 0 of a kit grid: heights in metres, row 0 south (as tiles are), NaN where no data. */
function levelZero(g: DsmGrid): Float64Array {
  const out = new Float64Array(g.w * g.h).fill(Number.NaN);
  for (let jn = 0; jn < g.h; jn++) {
    const js = g.h - 1 - jn;
    for (let i = 0; i < g.w; i++) {
      const k = jn * g.w + i;
      if (g.valid[k]) out[js * g.w + i] = (g.z[k] ?? 0) / 100 + g.zoff;
    }
  }
  return out;
}

/** The next display level: the mean of the valid 2 by 2 cells below (as `survey.prepare`). */
function halve(h: Float64Array, w: number, rows: number) {
  const w2 = Math.ceil(w / 2);
  const r2 = Math.ceil(rows / 2);
  const out = new Float64Array(w2 * r2).fill(Number.NaN);
  for (let j = 0; j < r2; j++)
    for (let i = 0; i < w2; i++) {
      let sum = 0;
      let n = 0;
      for (let dj = 0; dj < 2; dj++)
        for (let di = 0; di < 2; di++) {
          const y = 2 * j + dj;
          const x = 2 * i + di;
          if (x >= w || y >= rows) continue;
          const v = h[y * w + x] ?? Number.NaN;
          if (Number.isFinite(v)) {
            sum += v;
            n++;
          }
        }
      if (n > 0) out[j * w2 + i] = sum / n;
    }
  return { h: out, w: w2, rows: r2 };
}

/**
 * The `aio.height-tiles/1` surface of one kit DSM grid: its `tiles.json` and the tile files
 * (`<level>/<col>_<row>.bin`), on the kit's own cells (cell `(i, j)` of the kit is cell
 * `(i, h - 1 - j)` here, rows from the south).
 */
export async function kitSurfaceTiles(
  g: DsmGrid,
  spec: KitSurfaceSpec,
  opts: { crs: Crs; sha256?: string; now?: string },
): Promise<{ tiles: HeightTiles; files: TileFile[] }> {
  const files: TileFile[] = [];
  const present: string[] = [];
  let zmin = Infinity;
  let zmax = -Infinity;
  let imin = Infinity;
  let imax = -Infinity;
  let jmin = Infinity;
  let jmax = -Infinity;
  let level = { h: levelZero(g), w: g.w, rows: g.h };
  const cols = Math.max(1, Math.ceil(g.w / TILE));
  const rows = Math.max(1, Math.ceil(g.h / TILE));
  let levels = 1;
  for (let lv = 0; ; lv++) {
    const lc = Math.max(1, Math.ceil(level.w / TILE));
    const lr = Math.max(1, Math.ceil(level.rows / TILE));
    for (let r = 0; r < lr; r++)
      for (let c = 0; c < lc; c++) {
        const t = new Float64Array(TILE * TILE).fill(Number.NaN);
        let any = false;
        for (let y = 0; y < TILE; y++) {
          const j = r * TILE + y;
          if (j >= level.rows) break;
          for (let x = 0; x < TILE; x++) {
            const i = c * TILE + x;
            if (i >= level.w) break;
            const v = level.h[j * level.w + i] ?? Number.NaN;
            if (!Number.isFinite(v)) continue;
            t[y * TILE + x] = v;
            any = true;
            if (lv === 0) {
              if (v < zmin) zmin = v;
              if (v > zmax) zmax = v;
              if (i < imin) imin = i;
              if (i > imax) imax = i;
              if (j < jmin) jmin = j;
              if (j > jmax) jmax = j;
            }
          }
        }
        if (!any) continue;
        files.push({
          path: `${String(lv)}/${String(c)}_${String(r)}.bin`,
          data: (await encodeTile(t)) as Uint8Array<ArrayBuffer>,
        });
        if (lv === 0) present.push(`${String(c)}_${String(r)}`);
      }
    if ((lc <= 1 && lr <= 1) || levels >= 20) break;
    level = halve(level.h, level.w, level.rows);
    levels++;
  }
  if (present.length === 0) throw new Error(`The kit DSM of ${spec.name} has no heights.`);
  const originE = g.x0;
  const originN = g.y1 - g.h * g.res;
  const fingerprint = `kit-dsm:${String(KIT_SURFACE_VERSION)}:${spec.source.epoch}:${opts.sha256 ?? `${String(g.w)}x${String(g.h)}`}`;
  const tiles: HeightTiles = {
    schema: 'aio.height-tiles/1',
    id: spec.id,
    name: spec.name,
    source: spec.source,
    capture: spec.capture,
    crs: opts.crs,
    cellM: g.res,
    tileSize: TILE,
    originE,
    originN,
    cols,
    rows,
    levels,
    bounds: [
      originE + imin * g.res,
      originN + jmin * g.res,
      zmin,
      originE + (imax + 1) * g.res,
      originN + (jmax + 1) * g.res,
      zmax,
    ],
    tiles: present,
    ...(opts.sha256 ? { sourceSha256: opts.sha256 } : {}),
    fingerprint,
    preparedAt: opts.now ?? new Date().toISOString(),
  };
  return { tiles, files };
}

export interface KitPrepareDeps {
  /** The project's kit volumes (`project:readVolumes`), null when it has none. */
  readVolumes(): Promise<VolumesFile | null>;
  /** A project file's text (`aio://`), null when it is not there. */
  readText(path: string): Promise<string | null>;
  /** Write one surface (`survey:writeSurface`); an error sentence, or null. */
  write(tiles: HeightTiles, files: TileFile[]): Promise<string | null>;
  /** Called with the dates being made, then with none when done. */
  onPreparing?: (captures: readonly string[]) => void;
}

async function sha256Hex(text: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Make the kit surfaces of the dates that need one (`kitSurfaceSources`), one at a time. Returns
 * the dates made and the first error sentence (a date whose kit DSM is missing is skipped
 * quietly: it stays without a surface).
 */
export async function prepareKitSurfaces(
  manifest: Pick<ProjectManifest, 'captures' | 'layers' | 'crs'>,
  prepared: readonly HeightTiles[],
  deps: KitPrepareDeps,
  only?: readonly string[],
): Promise<{ made: string[]; error: string | null }> {
  const made: string[] = [];
  let volumes: VolumesFile | null;
  try {
    volumes = await deps.readVolumes();
  } catch (e) {
    return { made, error: e instanceof Error ? e.message : String(e) };
  }
  const specs = kitSurfaceSources(manifest, volumes, prepared, only);
  if (specs.length === 0) return { made, error: null };
  let error: string | null = null;
  deps.onPreparing?.(specs.map((s) => s.capture));
  try {
    for (const spec of specs) {
      try {
        const text = await deps.readText(kitDsmPath(spec.source.epoch, volumes));
        if (text === null) continue;
        const grid = await decodeDsm(text);
        const out = await kitSurfaceTiles(grid, spec, {
          crs: manifest.crs,
          sha256: await sha256Hex(text),
        });
        const failed = await deps.write(out.tiles, out.files);
        if (failed) error ??= failed;
        else made.push(spec.capture);
      } catch (e) {
        error ??= `The kit DSM of ${spec.name} could not be read: ${e instanceof Error ? e.message : String(e)}`;
      }
    }
  } finally {
    deps.onPreparing?.([]);
  }
  return { made, error };
}
