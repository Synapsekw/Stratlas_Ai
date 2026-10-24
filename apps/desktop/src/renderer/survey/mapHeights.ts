/**
 * Heights for points picked on the 2D map where the 3D stage has nothing under them (volumetrics
 * redesign A4). The map's pick reads the stage first; where that misses, it reads the prepared
 * surface of the date in view from tiles loaded ahead (`warm`), and where that has no data either,
 * the previous vertex's height, then the project origin's height. A map point never falls to 0.
 *
 * `at` is synchronous (a pointer move cannot wait for a tile), so it reads only tiles `warm` has
 * already loaded, with the engine's own bilinear rule (`@aio/survey` `bilinear`: posts at cell
 * centres, a needed post without data makes the sample no data), so it agrees with the card's and
 * the comparisons' heights (`card/pointHistory.ts`).
 */
import type { HeightTiles, SitePoint } from '@aio/schema';
import { TILE, TileSurface } from '@aio/survey';
import { surfaceTiles, type FetchTile } from './card/pointHistory';

/** A box in project E, N (the map's view). */
export interface EnBox {
  minE: number;
  minN: number;
  maxE: number;
  maxN: number;
}

export interface MapHeights {
  /**
   * Load the tiles of `tiles` (the date in view's prepared surface) around `around`, or the whole
   * surface when it is small; null forgets the surface. Resolves once they are cached.
   */
  warm(tiles: HeightTiles | null, around?: EnBox): Promise<void>;
  /** The surface height at (E, N) from the cached tiles; null where nothing is cached or no data. */
  at(e: number, n: number): number | null;
}

/** Tiles kept at once (each is 256 x 256 float64, 512 KB). */
export const MAX_TILES = 16;
/** Positions this close to a post (in cells) are on it, as the engine snaps. */
const SNAP = 1e-9;

const snap = (u: number) => {
  const r = Math.round(u);
  return Math.abs(u - r) <= SNAP ? r : u;
};

/** The height a map pick takes: the surface, else the previous vertex, else the origin height. */
export function fallbackZ(at: number | null, prev: SitePoint | null, originH: number): number {
  if (at !== null && Number.isFinite(at)) return at;
  const z = prev?.[2];
  if (z !== undefined && Number.isFinite(z)) return z;
  return originH;
}

/** The level-0 tiles of `s` a box touches (all of them without a box), nearest its centre first. */
function tilesFor(s: HeightTiles, around: EnBox | undefined): string[] {
  const span = TILE * s.cellM;
  const present = s.tiles;
  if (!around) return present.length <= MAX_TILES ? [...present] : [];
  const c0 = Math.floor((around.minE - s.originE) / span);
  const c1 = Math.floor((around.maxE - s.originE) / span);
  const r0 = Math.floor((around.minN - s.originN) / span);
  const r1 = Math.floor((around.maxN - s.originN) / span);
  const cc = (c0 + c1) / 2;
  const rc = (r0 + r1) / 2;
  return present
    .map((k) => {
      const [c = 0, r = 0] = k.split('_').map(Number);
      return { k, c, r };
    })
    .filter(({ c, r }) => c >= c0 && c <= c1 && r >= r0 && r <= r1)
    .sort((a, b) => Math.hypot(a.c - cc, a.r - rc) - Math.hypot(b.c - cc, b.r - rc))
    .slice(0, MAX_TILES)
    .map(({ k }) => k);
}

/**
 * The map's surface heights for one project. `fetchFor` reads one surface's tiles (defaults to the
 * project's prepared surfaces through the app's protocol, as the card reads them).
 */
export function createMapHeights(
  projectId: string,
  fetchFor: (s: HeightTiles) => FetchTile = (s) => surfaceTiles(projectId, s),
): MapHeights {
  let surface: HeightTiles | null = null;
  let reader: TileSurface | null = null;
  let cached = new Map<string, Float64Array>();
  let run = 0;

  const post = (s: HeightTiles, i: number, j: number): number => {
    if (i < 0 || j < 0 || i >= s.cols * TILE || j >= s.rows * TILE) return Number.NaN;
    const c = Math.floor(i / TILE);
    const r = Math.floor(j / TILE);
    const t = cached.get(`${String(c)}_${String(r)}`);
    return t?.[(j - r * TILE) * TILE + (i - c * TILE)] ?? Number.NaN;
  };

  return {
    async warm(tiles, around) {
      const mine = ++run;
      if (!tiles) {
        surface = null;
        reader = null;
        cached = new Map();
        return;
      }
      if (surface?.id !== tiles.id) {
        surface = tiles;
        reader = new TileSurface(tiles.id, tiles, fetchFor(tiles));
        cached = new Map();
      }
      const r = reader;
      if (!r) return;
      const want = tilesFor(tiles, around);
      const loaded = await Promise.all(
        want.map(async (k) => {
          const [c = 0, row = 0] = k.split('_').map(Number);
          try {
            return [k, await r.tile(c, row)] as const;
          } catch {
            return [k, null] as const;
          }
        }),
      );
      // a later warm (another date, another view) wins
      if (mine !== run) return;
      const next = new Map<string, Float64Array>();
      for (const [k, t] of loaded) if (t) next.set(k, t);
      cached = next;
    },
    at(e, n) {
      const s = surface;
      if (!s || cached.size === 0) return null;
      const u = snap((e - s.originE) / s.cellM - 0.5);
      const v = snap((n - s.originN) / s.cellM - 0.5);
      const i = Math.floor(u);
      const j = Math.floor(v);
      const fu = u - i;
      const fv = v - j;
      const p00 = post(s, i, j);
      const row0 = fu === 0 ? p00 : p00 * (1 - fu) + post(s, i + 1, j) * fu;
      const p01 = fv === 0 ? 0 : post(s, i, j + 1);
      const row1 = fv === 0 ? 0 : fu === 0 ? p01 : p01 * (1 - fu) + post(s, i + 1, j + 1) * fu;
      const z = fv === 0 ? row0 : row0 * (1 - fv) + row1 * fv;
      return Number.isFinite(z) ? z : null;
    },
  };
}
