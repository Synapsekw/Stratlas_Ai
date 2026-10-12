/**
 * A project's processed rasters on the Globe: kit pyramids (`aio.tiles/1`, data-conventions
 * section 5) placed on WGS84, the tiles a geographic rectangle needs, and which rasters a site in
 * focus shows and in what order. Pure: the imagery provider in `view/` builds on it.
 */
import { localToProject } from '@aio/geo';
import type { GlobeSite, Vec3 } from '@aio/schema';
import { projectToLonLat, type SiteGeoref } from './geodesy';

/** A kit pyramid index as the Globe reads it. */
export interface PyramidIndex {
  levels: { z: number; tileSize: number; cols: number; rows: number; pattern: string }[]; // coarse to fine
  corners: { tl: Vec3; tr: Vec3; bl: Vec3 };
  legend?: unknown; // passed through for the renderer (`@aio/maps` parseChangeLegend)
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isCount = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0;

function vec3(v: unknown): Vec3 | null {
  if (!Array.isArray(v) || v.length !== 3) return null;
  const [x, y, z] = v as unknown[];
  return isFiniteNumber(x) && isFiniteNumber(y) && isFiniteNumber(z) ? [x, y, z] : null;
}

/** Reads an `aio.tiles/1` index, levels sorted coarse to fine. Null when it is not one. */
export function parsePyramid(json: unknown): PyramidIndex | null {
  if (!isRecord(json) || json.schema !== 'aio.tiles/1') return null;
  const corners = json.corners;
  if (!isRecord(corners)) return null;
  const tl = vec3(corners.tl);
  const tr = vec3(corners.tr);
  const bl = vec3(corners.bl);
  if (!tl || !tr || !bl) return null;
  if (!Array.isArray(json.levels) || json.levels.length === 0) return null;
  const levels: PyramidIndex['levels'] = [];
  for (const l of json.levels as unknown[]) {
    if (!isRecord(l)) return null;
    const { z, tileSize, cols, rows, pattern } = l;
    if (!Number.isInteger(z) || !isCount(tileSize) || !isCount(cols) || !isCount(rows)) return null;
    if (typeof pattern !== 'string' || pattern.length === 0) return null;
    levels.push({ z: z as number, tileSize, cols, rows, pattern });
  }
  levels.sort((a, b) => a.cols - b.cols);
  const index: PyramidIndex = { levels, corners: { tl, tr, bl } };
  if (json.legend !== undefined) index.legend = json.legend;
  return index;
}

/** A pyramid placed on the Earth. */
export interface PyramidPlacement {
  /** West, south, east, north in degrees, with a margin of 1 % of the size. */
  rect: [number, number, number, number];
  /** Lon and lat in degrees to placement fractions (u along tl to tr, v along tl to bl). */
  toUv(lon: number, lat: number): [number, number];
  /** The inverse, for tests and for the corner check. */
  toLonLat(u: number, v: number): [number, number];
  /** Ground metres of one pixel of each level, coarse to fine. */
  metresPerPx: number[];
}

/** Ground size of one pixel of a level, metres (along the top edge, as `@aio/maps` has it). */
function levelMetresPerPx(index: PyramidIndex, level: PyramidIndex['levels'][number]): number {
  const { tl, tr } = index.corners;
  return Math.hypot(tr[0] - tl[0], tr[2] - tl[2]) / (level.cols * level.tileSize);
}

const RECT_MARGIN = 0.01;
/** Ground size a grid cell of the placement may span, metres, and the grid's bounds. */
const GRID_CELL_M = 100;
const GRID_MIN = 2;
// past about 3.2 km cells grow beyond 100 m, still within millimetres on pyramids of a few km
const GRID_MAX = 32;

/**
 * Places a pyramid on WGS84. An (N + 1) by (N + 1) grid over (u, v) is taken exactly through
 * the project CRS (local frame to project with `localToProject`, then `projectToLonLat`), with
 * cells of at most about 100 m on the ground (N from 2 to 32); `toLonLat` interpolates
 * bilinearly within a cell, and `toUv` inverts that by Newton's method, seeded by the affine map
 * of the three corners. The bilinear term a single affine map misses (a degree of longitude
 * shrinks northward: 3 cm at the far corner of a 600 m pyramid) is then left to the cells,
 * where it is well under a millimetre.
 */
export function pyramidPlacement(
  index: PyramidIndex,
  frame: Pick<SiteGeoref, 'crs' | 'origin'>,
): PyramidPlacement {
  const { tl, tr, bl } = index.corners;
  const span = Math.max(
    Math.hypot(tr[0] - tl[0], tr[2] - tl[2]),
    Math.hypot(bl[0] - tl[0], bl[2] - tl[2]),
  );
  const n = Math.min(GRID_MAX, Math.max(GRID_MIN, Math.ceil(span / GRID_CELL_M)));
  // grid[(j * (n + 1) + i) * 2 + 0 | 1] = lon | lat at u = i / n, v = j / n
  const grid = new Float64Array((n + 1) * (n + 1) * 2);
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      const u = i / n;
      const v = j / n;
      const local: Vec3 = [
        tl[0] + u * (tr[0] - tl[0]) + v * (bl[0] - tl[0]),
        tl[1] + u * (tr[1] - tl[1]) + v * (bl[1] - tl[1]),
        tl[2] + u * (tr[2] - tl[2]) + v * (bl[2] - tl[2]),
      ];
      const [lon, lat] = projectToLonLat(localToProject(local, frame.origin), frame.crs);
      const k = (j * (n + 1) + i) * 2;
      grid[k] = lon;
      grid[k + 1] = lat;
    }
  }
  const node = (i: number, j: number, c: 0 | 1): number => grid[(j * (n + 1) + i) * 2 + c] ?? NaN;

  /**
   * The cell holding (u, v) (edge cells reach past the pyramid, so points outside extrapolate),
   * the lon/lat there and its partial derivatives in u and v.
   */
  const evaluate = (u: number, v: number) => {
    const i = Math.min(n - 1, Math.max(0, Math.floor(u * n)));
    const j = Math.min(n - 1, Math.max(0, Math.floor(v * n)));
    const s = u * n - i;
    const t = v * n - j;
    const out = { lonLat: [0, 0] as [number, number], du: [0, 0], dv: [0, 0] };
    for (const c of [0, 1] as const) {
      const p00 = node(i, j, c);
      const p10 = node(i + 1, j, c);
      const p01 = node(i, j + 1, c);
      const p11 = node(i + 1, j + 1, c);
      out.lonLat[c] = p00 * (1 - s) * (1 - t) + p10 * s * (1 - t) + p01 * (1 - s) * t + p11 * s * t;
      out.du[c] = ((p10 - p00) * (1 - t) + (p11 - p01) * t) * n;
      out.dv[c] = ((p01 - p00) * (1 - s) + (p11 - p10) * s) * n;
    }
    return out;
  };

  const toLonLat = (u: number, v: number): [number, number] => evaluate(u, v).lonLat;

  // the affine map of the three corners seeds the inverse
  const lon0 = node(0, 0, 0);
  const lat0 = node(0, 0, 1);
  const a0 = node(n, 0, 0) - lon0;
  const a1 = node(n, 0, 1) - lat0;
  const b0 = node(0, n, 0) - lon0;
  const b1 = node(0, n, 1) - lat0;
  const det = a0 * b1 - a1 * b0;
  const toUv = (lon: number, lat: number): [number, number] => {
    let u = ((lon - lon0) * b1 - (lat - lat0) * b0) / det;
    let v = (a0 * (lat - lat0) - a1 * (lon - lon0)) / det;
    for (let k = 0; k < 50; k++) {
      const { lonLat, du, dv } = evaluate(u, v);
      const r0 = lonLat[0] - lon;
      const r1 = lonLat[1] - lat;
      const [j00 = 0, j10 = 0] = du;
      const [j01 = 0, j11 = 0] = dv;
      const d = j00 * j11 - j01 * j10;
      if (!Number.isFinite(d) || d === 0) break;
      const stepU = (r0 * j11 - r1 * j01) / d;
      const stepV = (j00 * r1 - j10 * r0) / d;
      u -= stepU;
      v -= stepV;
      if (Math.abs(stepU) < 1e-12 && Math.abs(stepV) < 1e-12) break;
    }
    return [u, v];
  };

  let west = Infinity;
  let east = -Infinity;
  let south = Infinity;
  let north = -Infinity;
  for (let k = 0; k < grid.length; k += 2) {
    const lon = grid[k] ?? NaN;
    const lat = grid[k + 1] ?? NaN;
    west = Math.min(west, lon);
    east = Math.max(east, lon);
    south = Math.min(south, lat);
    north = Math.max(north, lat);
  }
  const mw = (east - west) * RECT_MARGIN;
  const mh = (north - south) * RECT_MARGIN;
  return {
    rect: [west - mw, south - mh, east + mw, north + mh],
    toUv,
    toLonLat,
    metresPerPx: index.levels.map((l) => levelMetresPerPx(index, l)),
  };
}

/** One pyramid tile and the part of the placement it covers. */
export interface PyramidTileRef {
  z: number;
  x: number;
  y: number;
  path: string;
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

const fillPattern = (pattern: string, z: number, x: number, y: number): string =>
  pattern.replace(/\{z\}/g, String(z)).replace(/\{x\}/g, String(x)).replace(/\{y\}/g, String(y));

/**
 * The tiles that cover a geographic rectangle (west, south, east, north in degrees): the
 * coarsest level whose pixels are no larger than `metresPerPx`, or the finest when zoomed past
 * it, stepping to coarser levels while the rectangle would need more than `maxTiles`. Null when
 * the rectangle misses the pyramid. The same rule as `@aio/maps` `pyramidView`, worked in the
 * placement's (u, v). The rectangle is clipped to `placement.rect` first: (u, v) beyond the
 * pyramid are extrapolated and mean nothing far from it. The levels of `index` must be coarse
 * to fine, as `parsePyramid` leaves them and `placement.metresPerPx` lists them.
 */
export function pyramidTilesFor(
  index: PyramidIndex,
  placement: PyramidPlacement,
  rect: [number, number, number, number],
  metresPerPx: number,
  maxTiles = 16,
): { z: number; tiles: PyramidTileRef[] } | null {
  const levels = index.levels;
  if (!levels.length) return null;
  const west = Math.max(rect[0], placement.rect[0]);
  const south = Math.max(rect[1], placement.rect[1]);
  const east = Math.min(rect[2], placement.rect[2]);
  const north = Math.min(rect[3], placement.rect[3]);
  if (!(west < east && south < north)) return null;
  const uv = [
    placement.toUv(west, north),
    placement.toUv(east, north),
    placement.toUv(east, south),
    placement.toUv(west, south),
  ];
  if (uv.some(([u, v]) => !Number.isFinite(u) || !Number.isFinite(v))) return null;
  const u0 = Math.max(0, Math.min(...uv.map((p) => p[0])));
  const u1 = Math.min(1, Math.max(...uv.map((p) => p[0])));
  const v0 = Math.max(0, Math.min(...uv.map((p) => p[1])));
  const v1 = Math.min(1, Math.max(...uv.map((p) => p[1])));
  if (u0 >= u1 || v0 >= v1) return null;

  let pick = levels.findIndex(
    (l, i) => (placement.metresPerPx[i] ?? levelMetresPerPx(index, l)) <= metresPerPx * 1.001,
  );
  if (pick < 0) pick = levels.length - 1;
  for (let i = pick; i >= 0; i--) {
    const level = levels[i];
    if (!level) continue;
    const x0 = Math.floor(u0 * level.cols);
    const x1 = Math.min(level.cols - 1, Math.floor(u1 * level.cols - 1e-9));
    const y0 = Math.floor(v0 * level.rows);
    const y1 = Math.min(level.rows - 1, Math.floor(v1 * level.rows - 1e-9));
    const count = (x1 - x0 + 1) * (y1 - y0 + 1);
    if (count > maxTiles && i > 0) continue;
    const tiles: PyramidTileRef[] = [];
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        tiles.push({
          z: level.z,
          x,
          y,
          path: fillPattern(level.pattern, level.z, x, y),
          u0: x / level.cols,
          v0: y / level.rows,
          u1: (x + 1) / level.cols,
          v1: (y + 1) / level.rows,
        });
      }
    }
    return { z: level.z, tiles };
  }
  return null;
}

/** What ordering needs of a raster (`GlobeRaster` has it; zod's optionals may hold undefined). */
interface RasterLike {
  role: string;
  change?: true | undefined;
  capture?: string | undefined;
}

const isOrtho = (r: RasterLike): boolean => r.role === 'ortho' && !r.change;

/**
 * What a site in focus shows before the person touches anything: the ortho of its latest survey
 * date (the first such layer when several share it), or the first ortho when none has a known
 * capture. DSMs and change heat maps are never on by default.
 */
export function defaultShown(site: Pick<GlobeSite, 'captures' | 'rasters'>): string[] {
  const orthos = (site.rasters ?? []).filter(isOrtho);
  const first = orthos[0];
  if (!first) return [];
  const dates = new Map(site.captures.map((c) => [c.id, c.date]));
  let best: { layerId: string; date: string } | null = null;
  for (const r of orthos) {
    const date = r.capture === undefined ? undefined : dates.get(r.capture);
    if (date !== undefined && (best === null || date > best.date))
      best = { layerId: r.layerId, date };
  }
  return [best ? best.layerId : first.layerId];
}

/**
 * Draw order, bottom first: orthos by capture date (those without a known date first), then
 * shaded DSMs, then plans, then change heat maps on top. Otherwise the order given is kept.
 */
export function rasterOrder<R extends RasterLike>(
  rasters: readonly R[],
  captures: readonly { id: string; date: string }[],
): R[] {
  const dates = new Map(captures.map((c) => [c.id, c.date]));
  const rank = (r: R): number => {
    if (r.change) return 3;
    if (r.role === 'ortho') return 0;
    if (r.role === 'dsm') return 1;
    return 2;
  };
  const date = (r: R): string => (r.capture === undefined ? '' : (dates.get(r.capture) ?? ''));
  return rasters
    .map((r, i) => ({ r, i, rank: rank(r), date: rank(r) === 0 ? date(r) : '' }))
    .sort((a, b) =>
      a.rank !== b.rank
        ? a.rank - b.rank
        : a.date !== b.date
          ? a.date < b.date
            ? -1
            : 1
          : a.i - b.i,
    )
    .map((e) => e.r);
}
