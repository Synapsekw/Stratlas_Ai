import type { ProjectManifest, Vec3 } from '@aio/schema';

/*
 * WGS84 UTM <-> geographic conversion (Krueger series to the 6th order, Karney 2011), accurate to
 * well under a millimetre inside a zone. Local to @aio/maps until @aio/geo ships its proj4 CRS
 * registry; then frameProjection should delegate to it.
 */

const A = 6378137;
const F = 1 / 298.257223563;
const K0 = 0.9996;
const N = F / (2 - F);
const N2 = N * N;
const N3 = N2 * N;
const N4 = N3 * N;
const N5 = N4 * N;
const N6 = N5 * N;
const AA = (A / (1 + N)) * (1 + N2 / 4 + N4 / 64 + N6 / 256);
const E = Math.sqrt(F * (2 - F));

const ALPHA = [
  (1 / 2) * N -
    (2 / 3) * N2 +
    (5 / 16) * N3 +
    (41 / 180) * N4 -
    (127 / 288) * N5 +
    (7891 / 37800) * N6,
  (13 / 48) * N2 - (3 / 5) * N3 + (557 / 1440) * N4 + (281 / 630) * N5 - (1983433 / 1935360) * N6,
  (61 / 240) * N3 - (103 / 140) * N4 + (15061 / 26880) * N5 + (167603 / 181440) * N6,
  (49561 / 161280) * N4 - (179 / 168) * N5 + (6601661 / 7257600) * N6,
  (34729 / 80640) * N5 - (3418889 / 1995840) * N6,
  (212378941 / 319334400) * N6,
];
const BETA = [
  (1 / 2) * N -
    (2 / 3) * N2 +
    (37 / 96) * N3 -
    (1 / 360) * N4 -
    (81 / 512) * N5 +
    (96199 / 604800) * N6,
  (1 / 48) * N2 + (1 / 15) * N3 - (437 / 1440) * N4 + (46 / 105) * N5 - (1118711 / 3870720) * N6,
  (17 / 480) * N3 - (37 / 840) * N4 - (209 / 4480) * N5 + (5569 / 90720) * N6,
  (4397 / 161280) * N4 - (11 / 504) * N5 - (830251 / 7257600) * N6,
  (4583 / 161280) * N5 - (108847 / 3991680) * N6,
  (20648693 / 638668800) * N6,
];

const RAD = Math.PI / 180;

function centralMeridian(zone: number): number {
  return (zone * 6 - 183) * RAD;
}

/** UTM easting/northing (metres) to [lon, lat] in degrees. */
export function utmToLonLat(
  easting: number,
  northing: number,
  zone: number,
  south: boolean,
): [number, number] {
  const xi = (south ? northing - 10_000_000 : northing) / (K0 * AA);
  const eta = (easting - 500_000) / (K0 * AA);
  let xi1 = xi;
  let eta1 = eta;
  for (let j = 1; j <= 6; j++) {
    const b = BETA[j - 1] ?? 0;
    xi1 -= b * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
    eta1 -= b * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
  }
  const sinhEta1 = Math.sinh(eta1);
  const sinXi1 = Math.sin(xi1);
  const cosXi1 = Math.cos(xi1);
  const tau1 = sinXi1 / Math.sqrt(sinhEta1 * sinhEta1 + cosXi1 * cosXi1);
  // Newton iteration for tau = tan(phi) from tau' (conformal latitude).
  let tau = tau1;
  for (let i = 0; i < 6; i++) {
    const sigma = Math.sinh(E * Math.atanh((E * tau) / Math.sqrt(1 + tau * tau)));
    const tauP = tau * Math.sqrt(1 + sigma * sigma) - sigma * Math.sqrt(1 + tau * tau);
    const dTau =
      ((tau1 - tauP) / Math.sqrt(1 + tauP * tauP)) *
      ((1 + (1 - E * E) * tau * tau) / ((1 - E * E) * Math.sqrt(1 + tau * tau)));
    tau += dTau;
    if (Math.abs(dTau) < 1e-14) break;
  }
  const lat = Math.atan(tau);
  const lon = centralMeridian(zone) + Math.atan2(sinhEta1, cosXi1);
  return [lon / RAD, lat / RAD];
}

/** [lon, lat] in degrees to UTM [easting, northing] in metres for the given zone. */
export function lonLatToUtm(
  lon: number,
  lat: number,
  zone: number,
  south: boolean,
): [number, number] {
  const phi = lat * RAD;
  const lambda = lon * RAD - centralMeridian(zone);
  const tau = Math.tan(phi);
  const sigma = Math.sinh(E * Math.atanh((E * tau) / Math.sqrt(1 + tau * tau)));
  const tauP = tau * Math.sqrt(1 + sigma * sigma) - sigma * Math.sqrt(1 + tau * tau);
  const xiP = Math.atan2(tauP, Math.cos(lambda));
  const etaP = Math.asinh(Math.sin(lambda) / Math.sqrt(tauP * tauP + Math.cos(lambda) ** 2));
  let xi = xiP;
  let eta = etaP;
  for (let j = 1; j <= 6; j++) {
    const a = ALPHA[j - 1] ?? 0;
    xi += a * Math.sin(2 * j * xiP) * Math.cosh(2 * j * etaP);
    eta += a * Math.cos(2 * j * xiP) * Math.sinh(2 * j * etaP);
  }
  const easting = 500_000 + K0 * AA * eta;
  const northing = K0 * AA * xi + (south ? 10_000_000 : 0);
  return [easting, northing];
}

/** Converts between the project local frame (data-conventions section 1) and lon/lat. */
export interface FrameProjection {
  /** Local [x, y, z] (X east, Y up, Z south) to [lon, lat]. */
  toLonLat(local: Vec3 | readonly [number, number, number]): [number, number];
  /** [lon, lat] to local [x, 0, z]. */
  toLocal(lon: number, lat: number): Vec3;
}

/**
 * Projection for a manifest CRS and origin. Supports WGS84 UTM (EPSG 326xx north, 327xx south) and
 * EPSG 4326; returns null for anything else (no map overlays, map falls back to the packs' extent).
 */
export function frameProjection(
  crs: ProjectManifest['crs'],
  origin: Vec3 | readonly [number, number, number],
): FrameProjection | null {
  if (!('epsg' in crs)) return null;
  const [ox, oy] = origin;
  const epsg = crs.epsg;
  if (epsg === 4326) {
    // Degrees as a projected frame is meaningless for metres; treat the origin as the anchor and
    // use a local equirectangular approximation (good to centimetres over a site).
    const mPerDegLat = 111_320;
    const mPerDegLon = 111_320 * Math.cos(oy * RAD);
    return {
      toLonLat: ([x, , z]) => [ox + x / mPerDegLon, oy - z / mPerDegLat],
      toLocal: (lon, lat) => [(lon - ox) * mPerDegLon, 0, -(lat - oy) * mPerDegLat],
    };
  }
  const north = epsg >= 32601 && epsg <= 32660;
  const south = epsg >= 32701 && epsg <= 32760;
  if (!north && !south) return null;
  const zone = epsg % 100;
  return {
    toLonLat: ([x, , z]) => utmToLonLat(ox + x, oy - z, zone, south),
    toLocal: (lon, lat) => {
      const [e, n] = lonLatToUtm(lon, lat, zone, south);
      return [e - ox, 0, oy - n];
    },
  };
}
