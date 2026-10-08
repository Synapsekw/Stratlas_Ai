import type { CrsCatalogueEntry } from '@aio/schema';

/**
 * Search of the EPSG catalogue (`epsg.json.gz`, built by `tools/geo/build-crs-catalogue.mjs` from
 * PROJ's `proj.db`). Pure: main loads and caches the file and answers `geodesy:searchCrs` with it;
 * nothing here touches the file system, so the renderer may use it too.
 */

export type CrsKind = CrsCatalogueEntry['kind'];

/**
 * The decompressed catalogue file: a build artefact bundled with the app, never a project or user
 * file, so it has a format name and version rather than an `aio.*` file schema id.
 */
export interface CrsCatalogue {
  format: 'epsg-catalogue';
  version: 1;
  /** The EPSG dataset and PROJ version it was read from. */
  source: string;
  entries: CrsCatalogueEntry[];
}

export interface CrsSearch {
  query: string;
  /** Longitude and latitude, degrees: ranks CRSs whose area of use holds it first. */
  near?: readonly [number, number];
  kinds?: readonly CrsKind[];
  limit?: number;
}

/** Parse the catalogue's JSON text, refusing anything that is not a catalogue. */
export function parseCatalogue(text: string): CrsCatalogue {
  const doc = JSON.parse(text) as Partial<CrsCatalogue>;
  if (doc.format !== 'epsg-catalogue' || doc.version !== 1 || !Array.isArray(doc.entries)) {
    throw new Error('Not an EPSG catalogue this build reads (epsg-catalogue version 1).');
  }
  return {
    format: doc.format,
    version: doc.version,
    source: doc.source ?? '',
    entries: doc.entries,
  };
}

/** Does a west, south, east, north box (degrees, may cross the antimeridian) hold a point? */
export function bboxHolds(
  bbox: readonly [number, number, number, number],
  [lon, lat]: readonly [number, number],
): boolean {
  const [w, s, e, n] = bbox;
  if (lat < s || lat > n) return false;
  return w <= e ? lon >= w && lon <= e : lon >= w || lon <= e;
}

function bboxArea([w, s, e, n]: readonly [number, number, number, number]): number {
  const dx = w <= e ? e - w : e + 360 - w;
  return Math.max(1e-6, dx * (n - s));
}

const isWgs84Utm = (code: number) =>
  (code > 32600 && code <= 32660) || (code > 32700 && code <= 32760);

/**
 * Search by code ("32639", "EPSG:2240"), by words of the name or the area of use ("Georgia ftUS",
 * "Kuwait"), or with an empty query by `near` alone. Every word must match the code, the name or
 * the area. Ranked: exact code, name matches before area matches, CRSs whose area holds `near`
 * (WGS 84 UTM zones first, as in the GCC), smaller areas of use, current before deprecated.
 */
export function searchCatalogue(
  entries: readonly CrsCatalogueEntry[],
  req: CrsSearch,
): CrsCatalogueEntry[] {
  const limit = Math.max(1, Math.min(500, req.limit ?? 50));
  const kinds = req.kinds && req.kinds.length > 0 ? new Set(req.kinds) : null;
  const q = req.query.trim().toLowerCase();
  const code = /^(?:epsg\s*:?\s*)?(\d{3,6})$/.exec(q);
  const words = q.split(/[\s,;/()]+/).filter((w) => w.length > 0 && w !== 'epsg' && w !== 'epsg:');
  const near = req.near;
  if (!q && !near) return [];

  const scored: { e: CrsCatalogueEntry; score: number }[] = [];
  for (const e of entries) {
    if (kinds && !kinds.has(e.kind)) continue;
    let score = 0;
    if (code) {
      if (e.code !== Number(code[1])) continue;
      score += 1000;
    } else if (words.length > 0) {
      const name = e.name.toLowerCase();
      const area = (e.area ?? '').toLowerCase();
      const codeText = String(e.code);
      let ok = true;
      for (const w of words) {
        if (name.includes(w)) score += name.startsWith(w) ? 12 : 10;
        else if (codeText === w) score += 20;
        else if (area.includes(w)) score += 4;
        else {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      if (name === q) score += 100;
      else if (name.includes(q)) score += 25;
    }
    if (near) {
      const holds = e.bbox !== undefined && bboxHolds(e.bbox, near);
      if (!q && !holds) continue;
      if (holds && e.bbox) {
        score += 30 + (isWgs84Utm(e.code) ? 15 : 0);
        // more local areas of use rank higher (a state plane zone before a continent)
        score += Math.max(0, 8 - Math.log10(bboxArea(e.bbox)) * 2);
      }
    }
    if (e.deprecated) score -= 40;
    if (e.kind === 'projected') score += 1;
    scored.push({ e, score });
  }
  scored.sort((a, b) => b.score - a.score || a.e.code - b.e.code);
  return scored.slice(0, limit).map((s) => s.e);
}
