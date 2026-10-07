import { fromWgs84, isKnownCrs, toWgs84 } from '@aio/geo';
import type { ProjectManifest } from '@aio/schema';

/**
 * The project local frame and the Earth-centred frame (ECEF) of our 3D Tiles.
 *
 * The local frame (data-conventions section 1: x east, y up, z south, metres) is the project CRS
 * shifted to the origin: `E = ox + x`, `N = oy - z`, `H = oz + y`. It is flat in the CRS, not a
 * tangent plane, so no single matrix maps ECEF onto it: 1 km from the origin the Earth's curve
 * alone is 8 cm. Tilesets (written per vertex in ECEF by `tiles.mesh` and `tiles.cloud`) are placed
 * with one matrix per tile, fitted at the tile's centre (`ecefToLocalAt`), which is within a
 * millimetre over a leaf tile; the tileset as a whole uses the matrix fitted at the origin
 * (`ecefToLocalAt(origin)`) for its level-of-detail and culling sums.
 *
 * Heights: the project height is taken as height above the ellipsoid, as the pipelines do
 * (`extras.aio.heights`), so the site view and the tiles agree exactly.
 */

const A = 6378137.0;
const F = 1 / 298.257223563;
const E2 = F * (2 - F);
const RAD = Math.PI / 180;

export type V3 = [number, number, number];
/** Column-major 4 x 4 (three.js `Matrix4.elements` order). */
export type M4 = number[];

export function geodeticToEcef(lon: number, lat: number, h: number): V3 {
  const sl = Math.sin(lat * RAD);
  const cl = Math.cos(lat * RAD);
  const n = A / Math.sqrt(1 - E2 * sl * sl);
  return [
    (n + h) * cl * Math.cos(lon * RAD),
    (n + h) * cl * Math.sin(lon * RAD),
    (n * (1 - E2) + h) * sl,
  ];
}

/** ECEF to longitude, latitude (degrees) and ellipsoidal height (Bowring, then refined). */
export function ecefToGeodetic([x, y, z]: V3): V3 {
  const lon = Math.atan2(y, x);
  const p = Math.hypot(x, y);
  let lat = Math.atan2(z, p * (1 - E2));
  let h = 0;
  for (let i = 0; i < 6; i++) {
    const sl = Math.sin(lat);
    const n = A / Math.sqrt(1 - E2 * sl * sl);
    h = p / Math.cos(lat) - n;
    lat = Math.atan2(z, p * (1 - (E2 * n) / (n + h)));
  }
  return [lon / RAD, lat / RAD, h];
}

export interface SiteFrame {
  readonly epsg: number;
  readonly origin: V3;
  localToEcef(p: V3): V3;
  ecefToLocal(p: V3): V3;
  /** Matrix from ECEF to the local frame, exact (to first order) at `ecef`. */
  ecefToLocalAt(ecef: V3): M4;
}

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

function invert3(m: number[]): number[] {
  // m row-major 3 x 3
  const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, g = 0, h = 0, i = 0] = m;
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-18) throw new Error('A singular frame');
  return [
    (e * i - f * h) / det,
    (c * h - b * i) / det,
    (b * f - c * e) / det,
    (f * g - d * i) / det,
    (a * i - c * g) / det,
    (c * d - a * f) / det,
    (d * h - e * g) / det,
    (b * g - a * h) / det,
    (a * e - b * d) / det,
  ];
}

/** The frame of a project with an EPSG CRS the app knows offline; null otherwise (WKT). */
export function siteFrame(manifest: Pick<ProjectManifest, 'crs' | 'origin'>): SiteFrame | null {
  if (!('epsg' in manifest.crs) || !isKnownCrs(manifest.crs.epsg)) return null;
  const epsg = manifest.crs.epsg;
  const [ox, oy, oz] = manifest.origin;
  const localToEcef = ([x, y, z]: V3): V3 => {
    const [lon, lat] = toWgs84([ox + x, oy - z, 0], epsg);
    return geodeticToEcef(lon, lat, oz + y);
  };
  const ecefToLocal = (p: V3): V3 => {
    const [lon, lat, h] = ecefToGeodetic(p);
    const [e, n] = fromWgs84([lon, lat, 0], epsg);
    return [e - ox, h - oz, oy - n];
  };
  const ecefToLocalAt = (ecef: V3): M4 => {
    const l0 = ecefToLocal(ecef);
    const c = localToEcef(l0);
    const d = 10;
    const cols = [0, 1, 2].map((k) => {
      const q: V3 = [l0[0], l0[1], l0[2]];
      q[k] = (q[k] ?? 0) + d;
      return sub(localToEcef(q), c).map((v) => v / d) as V3;
    });
    // J: local to ECEF (columns: the image of each local axis); invert for ECEF to local
    const [c0, c1, c2] = cols as [V3, V3, V3];
    const j = [c0[0], c1[0], c2[0], c0[1], c1[1], c2[1], c0[2], c1[2], c2[2]];
    const r = invert3(j);
    const [r0 = 0, r1 = 0, r2 = 0, r3 = 0, r4 = 0, r5 = 0, r6 = 0, r7 = 0, r8 = 0] = r;
    // local = l0 + R (p - c)  =>  translation t = l0 - R c
    const t: V3 = [
      l0[0] - (r0 * c[0] + r1 * c[1] + r2 * c[2]),
      l0[1] - (r3 * c[0] + r4 * c[1] + r5 * c[2]),
      l0[2] - (r6 * c[0] + r7 * c[1] + r8 * c[2]),
    ];
    return [r0, r3, r6, 0, r1, r4, r7, 0, r2, r5, r8, 0, t[0], t[1], t[2], 1];
  };
  return { epsg, origin: [ox, oy, oz], localToEcef, ecefToLocal, ecefToLocalAt };
}

/** Apply a column-major 4 x 4 to a point. */
export function applyM4(m: M4, [x, y, z]: V3): V3 {
  const e = (i: number) => m[i] ?? 0;
  return [
    e(0) * x + e(4) * y + e(8) * z + e(12),
    e(1) * x + e(5) * y + e(9) * z + e(13),
    e(2) * x + e(6) * y + e(10) * z + e(14),
  ];
}
