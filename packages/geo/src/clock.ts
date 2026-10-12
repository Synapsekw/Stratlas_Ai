import { toWgs84 } from './index';

/** The clock offset of a project from its longitude: whole hours, in minutes; 0 when unknown. */
export function defaultUtcOffsetMin(
  origin: readonly [number, number, number],
  epsg: number,
): number {
  try {
    const [lon] = toWgs84([origin[0], origin[1], origin[2]], epsg);
    return Number.isFinite(lon) ? Math.round(lon / 15) * 60 : 0;
  } catch {
    return 0;
  }
}
