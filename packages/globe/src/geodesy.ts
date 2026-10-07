import { crsDefinition, localToProject, projectToLocal } from '@aio/geo';
import type { Vec3 } from '@aio/schema';
import proj4 from 'proj4';

/**
 * Where the Globe and the site view meet (plan "Two renderers, one truth"): a project's local
 * frame (metres, Y up, X east, Z south around its origin, data-conventions section 1) to Earth-
 * centred, Earth-fixed coordinates and back, through the project CRS in float64 (proj4, the
 * bundled definitions of `@aio/geo`), never through a UTM-as-metres shortcut. Heights: project
 * heights plus `heightOffset` (the geoid separation at the site where heights are above mean sea
 * level) are heights above the WGS84 ellipsoid, which CesiumJS uses.
 */

const A = 6378137;
const F = 1 / 298.257223563;
const E2 = F * (2 - F);
const B = A * (1 - F);
const EP2 = (A * A - B * B) / (B * B);
const RAD = Math.PI / 180;

/** WGS84 longitude, latitude (degrees) and ellipsoidal height (metres) to ECEF metres. */
export function geodeticToEcef(lon: number, lat: number, h: number): Vec3 {
  const l = lon * RAD;
  const p = lat * RAD;
  const sp = Math.sin(p);
  const cp = Math.cos(p);
  const n = A / Math.sqrt(1 - E2 * sp * sp);
  return [(n + h) * cp * Math.cos(l), (n + h) * cp * Math.sin(l), (n * (1 - E2) + h) * sp];
}

/** ECEF metres to WGS84 longitude, latitude (degrees) and ellipsoidal height (Bowring, refined). */
export function ecefToGeodetic(x: number, y: number, z: number): Vec3 {
  const lon = Math.atan2(y, x);
  const p = Math.hypot(x, y);
  // Bowring's initial value, then fixed-point steps on the exact relation (sub-micrometre)
  const t = Math.atan2(z * A, p * B);
  let lat = Math.atan2(z + EP2 * B * Math.sin(t) ** 3, p - E2 * A * Math.cos(t) ** 3);
  let h = 0;
  for (let i = 0; i < 3; i++) {
    const s = Math.sin(lat);
    const n = A / Math.sqrt(1 - E2 * s * s);
    h =
      Math.abs(Math.cos(lat)) > 1e-9
        ? p / Math.cos(lat) - n
        : Math.abs(z) / Math.abs(s) - n * (1 - E2);
    lat = Math.atan2(z, p * (1 - (E2 * n) / (n + h)));
  }
  return [lon / RAD, lat / RAD, h];
}

/** The local east, north and up unit vectors in ECEF at a point. */
export function enuBasis(lon: number, lat: number): { e: Vec3; n: Vec3; u: Vec3 } {
  const l = lon * RAD;
  const p = lat * RAD;
  const sl = Math.sin(l);
  const cl = Math.cos(l);
  const sp = Math.sin(p);
  const cp = Math.cos(p);
  return {
    e: [-sl, cl, 0],
    n: [-sp * cl, -sp * sl, cp],
    u: [cp * cl, cp * sl, sp],
  };
}

/** Column-major 4x4 from east-north-up metres at a point to ECEF (the 3D Tiles convention). */
export function enuToEcefMatrix(lon: number, lat: number, h: number): number[] {
  const { e, n, u } = enuBasis(lon, lat);
  const o = geodeticToEcef(lon, lat, h);
  return [...e, 0, ...n, 0, ...u, 0, ...o, 1];
}

/** How a project sits on the Earth: its CRS, its local-frame origin and its height offset. */
export interface SiteGeoref {
  crs: { epsg: number } | { wkt: string };
  /** The local frame's origin in the project CRS (E, N, H). */
  origin: Vec3;
  /** Added to project heights to get ellipsoidal heights (the geoid separation, or 0). */
  heightOffset: number;
}

const converters = new Map<string, proj4.Converter>();
function converter(crs: SiteGeoref['crs']): proj4.Converter {
  const def = 'epsg' in crs ? crsDefinition(crs.epsg) : crs.wkt;
  let c = converters.get(def);
  if (!c) {
    c = proj4(def, crsDefinition(4326));
    converters.set(def, c);
  }
  return c;
}

/** Whether the Globe can place a project with this CRS (bundled EPSG codes, or a WKT proj4 reads). */
export function canPlace(crs: SiteGeoref['crs']): boolean {
  try {
    converter(crs);
    return true;
  } catch {
    return false;
  }
}

/** Project CRS (E, N, H) to WGS84 longitude, latitude and project height. */
export function projectToLonLat(p: Vec3, crs: SiteGeoref['crs']): Vec3 {
  const [lon, lat] = converter(crs).forward([p[0], p[1]]);
  return [lon, lat, p[2]];
}

/** A local-frame point of the site to ECEF. */
export function localToEcef(local: Vec3, g: SiteGeoref): Vec3 {
  const p = localToProject(local, g.origin);
  const [lon, lat] = converter(g.crs).forward([p[0], p[1]]);
  return geodeticToEcef(lon, lat, p[2] + g.heightOffset);
}

/** An ECEF point to the site's local frame. */
export function ecefToLocal(ecef: Vec3, g: SiteGeoref): Vec3 {
  const [lon, lat, h] = ecefToGeodetic(ecef[0], ecef[1], ecef[2]);
  const [e, n] = converter(g.crs).inverse([lon, lat]);
  return projectToLocal([e, n, h - g.heightOffset], g.origin);
}

/**
 * Column-major 4x4 from the site's local frame to ECEF, linearised at the origin (for a tileset
 * placed in the project frame): its columns are the ECEF images of the local X, Y and Z unit
 * vectors through the project CRS, so grid convergence and scale are in it. Exact at the origin;
 * off by the Earth's curvature away from it (8 mm at 300 m).
 */
export function localToEcefMatrix(g: SiteGeoref): number[] {
  const o = localToEcef([0, 0, 0], g);
  const axis = (v: Vec3): number[] => {
    // central differences over 10 m keep float64 rounding below a micrometre
    const a = localToEcef([v[0] * 10, v[1] * 10, v[2] * 10], g);
    const b = localToEcef([v[0] * -10, v[1] * -10, v[2] * -10], g);
    return [(a[0] - b[0]) / 20, (a[1] - b[1]) / 20, (a[2] - b[2]) / 20, 0];
  };
  return [...axis([1, 0, 0]), ...axis([0, 1, 0]), ...axis([0, 0, 1]), ...o, 1];
}

/** Apply a column-major 4x4 to a point. */
export function applyMatrix(m: readonly number[], p: Vec3): Vec3 {
  const at = (i: number) => m[i] ?? 0;
  return [
    at(0) * p[0] + at(4) * p[1] + at(8) * p[2] + at(12),
    at(1) * p[0] + at(5) * p[1] + at(9) * p[2] + at(13),
    at(2) * p[0] + at(6) * p[1] + at(10) * p[2] + at(14),
  ];
}

/**
 * Tilesets written by `tiles.mesh` and `tiles.cloud` take project heights as ellipsoidal heights
 * (`extras.aio.heights`, G7): the Globe lifts them by the geoid separation at the site, the one
 * vertical shift G7 leaves to it. Null when there is nothing to shift.
 */
export function geoidShift(
  extras: unknown,
  geoid: (lon: number, lat: number) => number,
): Vec3 | null {
  const aio = (extras as { aio?: { heights?: unknown; originLonLat?: unknown } } | undefined)?.aio;
  const ll = aio?.originLonLat;
  if (aio?.heights !== 'project-heights-as-ellipsoidal' || !Array.isArray(ll)) return null;
  const [lon, lat] = ll as [number, number];
  const n = geoid(lon, lat);
  if (!Number.isFinite(n) || n === 0) return null;
  const { u } = enuBasis(lon, lat);
  return [u[0] * n, u[1] * n, u[2] * n];
}
