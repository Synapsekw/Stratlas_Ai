import type { Vec3 } from '@aio/schema';
import { enuBasis, geodeticToEcef } from './geodesy';

/**
 * The Globe's only measuring tool (decision 3): a geodesic distance and an area read-out, labelled
 * "on the ellipsoid". Distances are geodesics on WGS84 (Vincenty's inverse formula); the area is
 * that of the polygon on a plane tangent to the ellipsoid at its centre, which differs from the
 * ellipsoidal area by far less than a part in a thousand for a site of tens of kilometres.
 */

const A = 6378137;
const F = 1 / 298.257223563;
const B = A * (1 - F);
const RAD = Math.PI / 180;

/** Geodesic distance in metres between two WGS84 points (degrees). */
export function geodesicDistance(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const L = (lon2 - lon1) * RAD;
  const U1 = Math.atan((1 - F) * Math.tan(lat1 * RAD));
  const U2 = Math.atan((1 - F) * Math.tan(lat2 * RAD));
  const sU1 = Math.sin(U1);
  const cU1 = Math.cos(U1);
  const sU2 = Math.sin(U2);
  const cU2 = Math.cos(U2);
  let lambda = L;
  let sinSigma = 0;
  let cosSigma = 1;
  let sigma = 0;
  let cos2Alpha = 1;
  let cos2SigmaM = 0;
  for (let i = 0; i < 200; i++) {
    const sL = Math.sin(lambda);
    const cL = Math.cos(lambda);
    sinSigma = Math.hypot(cU2 * sL, cU1 * sU2 - sU1 * cU2 * cL);
    if (sinSigma === 0) return 0;
    cosSigma = sU1 * sU2 + cU1 * cU2 * cL;
    sigma = Math.atan2(sinSigma, cosSigma);
    const sinAlpha = (cU1 * cU2 * sL) / sinSigma;
    cos2Alpha = 1 - sinAlpha * sinAlpha;
    cos2SigmaM = cos2Alpha !== 0 ? cosSigma - (2 * sU1 * sU2) / cos2Alpha : 0;
    const C = (F / 16) * cos2Alpha * (4 + F * (4 - 3 * cos2Alpha));
    const prev = lambda;
    lambda =
      L +
      (1 - C) *
        F *
        sinAlpha *
        (sigma + C * sinSigma * (cos2SigmaM + C * cosSigma * (-1 + 2 * cos2SigmaM ** 2)));
    if (Math.abs(lambda - prev) < 1e-12) break;
  }
  const u2 = (cos2Alpha * (A * A - B * B)) / (B * B);
  const Ak = 1 + (u2 / 16384) * (4096 + u2 * (-768 + u2 * (320 - 175 * u2)));
  const Bk = (u2 / 1024) * (256 + u2 * (-128 + u2 * (74 - 47 * u2)));
  const dSigma =
    Bk *
    sinSigma *
    (cos2SigmaM +
      (Bk / 4) *
        (cosSigma * (-1 + 2 * cos2SigmaM ** 2) -
          (Bk / 6) * cos2SigmaM * (-3 + 4 * sinSigma ** 2) * (-3 + 4 * cos2SigmaM ** 2)));
  return B * Ak * (sigma - dSigma);
}

/** Length of a path of WGS84 points (degrees), segment by segment along geodesics. */
export function pathLength(points: readonly (readonly [number, number])[]): number {
  let d = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (a && b) d += geodesicDistance(a[0], a[1], b[0], b[1]);
  }
  return d;
}

/** Area in square metres of a polygon of WGS84 points (degrees); 0 under three points. */
export function polygonArea(points: readonly (readonly [number, number])[]): number {
  if (points.length < 3) return 0;
  const lon = points.reduce((s, p) => s + p[0], 0) / points.length;
  const lat = points.reduce((s, p) => s + p[1], 0) / points.length;
  const o = geodeticToEcef(lon, lat, 0);
  const { e, n } = enuBasis(lon, lat);
  const local = points.map((p) => {
    const q: Vec3 = geodeticToEcef(p[0], p[1], 0);
    const d: Vec3 = [q[0] - o[0], q[1] - o[1], q[2] - o[2]];
    return [d[0] * e[0] + d[1] * e[1] + d[2] * e[2], d[0] * n[0] + d[1] * n[1] + d[2] * n[2]];
  });
  let twice = 0;
  for (let i = 0; i < local.length; i++) {
    const [x1 = 0, y1 = 0] = local[i] ?? [];
    const [x2 = 0, y2 = 0] = local[(i + 1) % local.length] ?? [];
    twice += x1 * y2 - x2 * y1;
  }
  return Math.abs(twice) / 2;
}

/** "1.24 km", "850 m", "3.2 ha", "1.75 km²": the read-out's words for a length or an area. */
export function formatLength(m: number): string {
  return m >= 1000
    ? `${(m / 1000).toFixed(m >= 100_000 ? 0 : 2)} km`
    : `${m.toFixed(m < 10 ? 2 : 0)} m`;
}
export function formatArea(m2: number): string {
  if (m2 >= 1_000_000) return `${(m2 / 1_000_000).toFixed(2)} km²`;
  if (m2 >= 10_000) return `${(m2 / 10_000).toFixed(2)} ha`;
  return `${m2.toFixed(0)} m²`;
}
