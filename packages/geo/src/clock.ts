import { toWgs84 } from './index';

/**
 * The clock offset of a site from its longitude: whole hours, in minutes. Null when the position
 * cannot be read (no EPSG code, or one outside the bundled registry).
 */
export function siteUtcOffsetMin(
  origin: readonly [number, number, number],
  epsg: number | undefined,
): number | null {
  if (epsg === undefined) return null;
  try {
    const [lon] = toWgs84([origin[0], origin[1], origin[2]], epsg);
    if (!Number.isFinite(lon)) return null;
    const hours = Math.round(lon / 15);
    // never -0: a site just west of Greenwich is UTC+0 like one just east of it
    return hours === 0 ? 0 : hours * 60;
  } catch {
    return null;
  }
}

/** The clock offset of a project from its longitude: whole hours, in minutes; 0 when unknown. */
export function defaultUtcOffsetMin(
  origin: readonly [number, number, number],
  epsg: number,
): number {
  return siteUtcOffsetMin(origin, epsg) ?? 0;
}
