import { sampleDsm } from './dsm';
import type { EN, Surface } from './edit';
import type { DsmGrid, PileGrid } from './kitdata';

type Origin = readonly [number, number, number];

/** `[x, z]` in the local frame (x east, z south) to easting and northing. */
export function localToEN(origin: Origin, p: readonly [number, number]): EN {
  return [p[0] + origin[0], origin[1] - p[1]];
}

/** Easting and northing to `[x, z]` in the local frame. */
export function enToLocal(origin: Origin, p: readonly [number, number]): [number, number] {
  return [p[0] - origin[0], origin[1] - p[1]];
}

/**
 * The surface of one survey: the pile's 10 cm grid where it covers the point, else the 0.4 m
 * site DSM (the kit's `surfFn`).
 */
export function pileSurface(p: PileGrid | null, epoch: string, dsm: DsmGrid): Surface {
  const z = p?.ep[epoch]?.z;
  return (E, N) => {
    if (p && z) {
      const x = Math.floor((E - p.x0) / p.res);
      const y = Math.floor((p.y1 - N) / p.res);
      if (x >= 0 && y >= 0 && x < p.w && y < p.h) return (z[y * p.w + x] ?? 0) / 100 + p.zoff;
    }
    return sampleDsm(dsm, E, N);
  };
}
