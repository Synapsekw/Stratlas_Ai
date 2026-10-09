/**
 * Plain helpers of the **Geoid packs** settings block (M11, decision 5): how a pack's region and
 * vertical datum read, which packs can be removed, and the import form's checks.
 */
import type { GeoidPackMeta } from '@aio/schema';

/** The global grids of the pipeline pack: listed, never removed. */
export const GLOBAL_GEOID_IDS: readonly string[] = ['egm96', 'egm2008'];

export function isGlobalGeoid(pack: Pick<GeoidPackMeta, 'id'>): boolean {
  return GLOBAL_GEOID_IDS.includes(pack.id.toLowerCase());
}

const deg = (v: number, pos: string, neg: string) =>
  `${String(Math.round(Math.abs(v) * 100) / 100)}°${v < 0 ? neg : pos}`;

/** "Worldwide", or "112.5°E to 154°E, 44°S to 9°S". */
export function regionText(bbox: GeoidPackMeta['bbox']): string {
  const [w, s, e, n] = bbox;
  if (w <= -179.9 && e >= 179.9 && s <= -89.9 && n >= 89.9) return 'Worldwide';
  return `${deg(w, 'E', 'W')} to ${deg(e, 'E', 'W')}, ${deg(s, 'N', 'S')} to ${deg(n, 'N', 'S')}`;
}

/** "EPSG 5773", or why there is none. */
export function verticalText(pack: Pick<GeoidPackMeta, 'verticalEpsg'>): string {
  return pack.verticalEpsg ? `EPSG ${String(pack.verticalEpsg)}` : 'Not stated';
}

/** The import form as typed. */
export interface GeoidDraft {
  path: string;
  name: string;
  licence: string;
  attribution: string;
  /** The vertical CRS's EPSG code as typed; empty when not known. */
  verticalEpsg: string;
}

/** The `geoidPacks:import` request of a draft, or the first thing to fix. */
export function geoidImportRequest(d: GeoidDraft):
  | {
      ok: true;
      request: {
        path: string;
        name: string;
        licence: string;
        attribution: string;
        verticalEpsg?: number;
      };
    }
  | { ok: false; error: string } {
  const name = d.name.trim();
  const licence = d.licence.trim();
  const attribution = d.attribution.trim();
  if (!name) return { ok: false, error: 'Give the geoid a name.' };
  if (!licence) return { ok: false, error: 'State the licence the grid is under.' };
  if (!attribution) return { ok: false, error: 'State the attribution the licence asks for.' };
  const epsgText = d.verticalEpsg.trim().replace(/^epsg[:\s]*/i, '');
  let verticalEpsg: number | undefined;
  if (epsgText) {
    const n = Number(epsgText);
    if (!Number.isInteger(n) || n <= 0)
      return { ok: false, error: 'The vertical datum is an EPSG code, for example 5711.' };
    verticalEpsg = n;
  }
  return {
    ok: true,
    request: {
      path: d.path,
      name: name.slice(0, 200),
      licence: licence.slice(0, 200),
      attribution: attribution.slice(0, 1000),
      ...(verticalEpsg ? { verticalEpsg } : {}),
    },
  };
}
