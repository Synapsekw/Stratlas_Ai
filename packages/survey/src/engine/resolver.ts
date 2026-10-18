/**
 * Surfaces of a project for the TypeScript executor, resolved the way the Python core's
 * `ProjectSurfaces` resolves them: `survey` names a prepared surface, `current` and `previous` the
 * prepared surfaces of the capture a measurement is viewed on and of the capture before it (in
 * date order, among captures that have one; a cleaned `derived` surface first, then `dsm`,
 * `cloud`, `dtm`), and `design` a design surface layer (`aio.tin/1`, its vertical offset added,
 * fingerprinted by the file's SHA-256). Tiles and TINs are read through `fetchBytes` (in the app,
 * `aio://project/<id>/...`), once each.
 */
import type { DesignEntry, HeightTiles, SurfaceRef } from '@aio/schema';
import type { Resolve, ResolvedSurface, Shift, Turn } from './compare';
import { surfaceOfCapture } from '../calc/pickers';
import { sha256Hex } from './fingerprint';
import { TileCache, TileSurface } from './tiles';
import { readTin } from './tin';

export interface ProjectSurfacesInput {
  /** `survey:surfaces`. */
  surfaces: readonly HeightTiles[];
  /** Capture ids in date order (`captureIndex()`). */
  captures: readonly string[];
  /** The capture the measurement is viewed on; absent: the latest with a surface. */
  capture?: string;
  /** `survey:readDesigns` designs. */
  designs?: readonly DesignEntry[];
  /** Bytes of a project file (`survey/...`), or null when it is missing. */
  fetchBytes: (path: string) => Promise<Uint8Array | null>;
  cache?: TileCache;
  /** The line-up each survey date has now (`[eastM, northM]`, absent: none), for fingerprints. */
  shifts?: Readonly<Record<string, Shift>>;
  /** The turn beside each date's line-up now (its `lineUpTurn`, absent: none), for fingerprints. */
  turns?: Readonly<Record<string, Turn>>;
}

/**
 * The shifts of a survey-scoped ring (the capture its measurement belongs to): `ringShift` is what
 * its prepared surface sits at (its `dateShiftM`), added to the stored ring before sampling, so a
 * line-up since then does not move the answer; `ringCurrent` is the date's shift now, for the
 * fingerprint (the result reads stale until the surface is prepared again). `ringTurn` and
 * `ringCurrentTurn` are the turns beside them (the surface's `dateTurn`, the date's turn now),
 * present only when there is one.
 */
export function ringShifts(
  surfaces: readonly HeightTiles[],
  shifts: Readonly<Record<string, Shift>> | undefined,
  capture: string | undefined,
  turns?: Readonly<Record<string, Turn>>,
): { ringShift?: Shift; ringCurrent?: Shift; ringTurn?: Turn; ringCurrentTurn?: Turn } {
  if (capture === undefined) return {};
  const current: Shift = shifts?.[capture] ?? [0, 0];
  const currentTurn = turns?.[capture];
  const s = surfaceOfCapture(surfaces, capture);
  const lined = s && (s.dateShiftM !== undefined || s.dateTurn !== undefined) ? s : null;
  const prepared: Shift = lined
    ? [lined.dateShiftM?.eastM ?? 0, lined.dateShiftM?.northM ?? 0]
    : current;
  const preparedTurn = lined ? lined.dateTurn : currentTurn;
  return {
    ringShift: prepared,
    ringCurrent: current,
    ...(preparedTurn ? { ringTurn: preparedTurn } : {}),
    ...(currentTurn ? { ringCurrentTurn: currentTurn } : {}),
  };
}

export class SurfaceNotFound extends Error {}

export function projectResolver(inp: ProjectSurfacesInput): Resolve {
  const cache = inp.cache ?? new TileCache();
  const grids = new Map<string, TileSurface>();
  const tins = new Map<string, Promise<ResolvedSurface>>();
  const byId = new Map(inp.surfaces.map((s) => [s.id, s]));

  const ofCapture = (c: string): HeightTiles | null => surfaceOfCapture(inp.surfaces, c);

  const grid = (s: HeightTiles, capture?: string): ResolvedSurface => {
    let g = grids.get(s.id);
    if (!g) {
      g = new TileSurface(
        s.id,
        s,
        (c, r) => inp.fetchBytes(`survey/surfaces/${s.id}/0/${c}_${r}.bin`),
        cache,
      );
      grids.set(s.id, g);
    }
    const cap = capture ?? s.capture;
    return {
      kind: 'grid',
      name: s.name,
      fingerprint: s.fingerprint,
      ...(cap !== undefined ? { capture: cap } : {}),
      ...(cap !== undefined && inp.shifts?.[cap] ? { current: inp.shifts[cap] } : {}),
      ...(cap !== undefined && inp.turns?.[cap] ? { currentTurn: inp.turns[cap] } : {}),
      grid: g,
    };
  };

  return (ref: SurfaceRef): Promise<ResolvedSurface> => {
    switch (ref.kind) {
      case 'survey': {
        const s = byId.get(ref.surface);
        if (!s)
          return Promise.reject(
            new SurfaceNotFound(
              `The surface "${ref.surface}" is not prepared; run Prepare surfaces first.`,
            ),
          );
        return Promise.resolve(grid(s, ref.capture));
      }
      case 'current':
      case 'previous': {
        const caps = inp.captures.filter((c) => ofCapture(c));
        const cur =
          inp.capture !== undefined
            ? caps.includes(inp.capture)
              ? inp.capture
              : undefined
            : caps.at(-1);
        const k = cur === undefined ? -1 : caps.indexOf(cur);
        const cap = ref.kind === 'current' ? cur : k > 0 ? caps[k - 1] : undefined;
        const s = cap === undefined ? null : ofCapture(cap);
        if (!s || cap === undefined)
          return Promise.reject(
            new SurfaceNotFound(`There is no ${ref.kind} survey with a prepared surface.`),
          );
        return Promise.resolve(grid(s, cap));
      }
      case 'design': {
        const key = `${ref.design}/${ref.layer}`;
        let p = tins.get(key);
        if (!p) {
          p = (async (): Promise<ResolvedSurface> => {
            const entry = inp.designs?.find((d) => d.id === ref.design);
            const layer = entry?.layers.find((l) => l.id === ref.layer);
            if (!entry || layer?.kind !== 'surface')
              throw new SurfaceNotFound(
                `The design surface "${ref.design}, ${ref.layer}" is not in the designs list.`,
              );
            const bytes = await inp.fetchBytes(`survey/designs/${entry.id}/${layer.file}`);
            if (!bytes)
              throw new SurfaceNotFound(`The design surface file ${layer.file} is missing.`);
            return {
              kind: 'tin',
              name: `${entry.name}, ${layer.name}`,
              fingerprint: `sha256:${await sha256Hex(bytes)}`,
              tin: readTin(bytes, layer.file),
              offsetM: layer.verticalOffsetM,
            };
          })();
          p.catch(() => tins.delete(key));
          tins.set(key, p);
        }
        return p;
      }
      default:
        return Promise.reject(new SurfaceNotFound(`"${ref.kind}" is not a surface.`));
    }
  };
}
