/**
 * Sun position from latitude, longitude and an instant (NOAA solar calculator equations, the
 * algorithm behind the NOAA spreadsheet and SunCalc-style libraries; better than 0.05 degrees
 * between 1900 and 2100), and the sun direction in the local scene frame.
 */

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

export interface SolarPosition {
  /** Degrees clockwise from true north. */
  azimuthDeg: number;
  /** Degrees above the horizon, with atmospheric refraction. Negative below the horizon. */
  elevationDeg: number;
}

const mod = (a: number, n: number) => ((a % n) + n) % n;

/** Approximate atmospheric refraction, degrees, for a geometric elevation (NOAA). */
function refractionDeg(el: number): number {
  if (el > 85) return 0;
  const te = Math.tan(el * RAD);
  let arcsec: number;
  if (el > 5) arcsec = 58.1 / te - 0.07 / te ** 3 + 0.000086 / te ** 5;
  else if (el > -0.575) arcsec = 1735 + el * (-518.2 + el * (103.4 + el * (-12.79 + el * 0.711)));
  else arcsec = -20.772 / te;
  return arcsec / 3600;
}

/** Where the sun is in the sky at `utcMs` (ms since the Unix epoch) seen from lat/lon degrees. */
export function solarPosition(utcMs: number, latDeg: number, lonDeg: number): SolarPosition {
  const jd = utcMs / 86_400_000 + 2_440_587.5;
  const jc = (jd - 2_451_545) / 36_525;
  const l0 = mod(280.46646 + jc * (36000.76983 + jc * 0.0003032), 360);
  const m = 357.52911 + jc * (35999.05029 - 0.0001537 * jc);
  const e = 0.016708634 - jc * (0.000042037 + 0.0000001267 * jc);
  const c =
    Math.sin(m * RAD) * (1.914602 - jc * (0.004817 + 0.000014 * jc)) +
    Math.sin(2 * m * RAD) * (0.019993 - 0.000101 * jc) +
    Math.sin(3 * m * RAD) * 0.000289;
  const omega = 125.04 - 1934.136 * jc;
  const appLong = l0 + c - 0.00569 - 0.00478 * Math.sin(omega * RAD);
  const meanObliq = 23 + (26 + (21.448 - jc * (46.815 + jc * (0.00059 - jc * 0.001813))) / 60) / 60;
  const obliq = meanObliq + 0.00256 * Math.cos(omega * RAD);
  const decl = Math.asin(Math.sin(obliq * RAD) * Math.sin(appLong * RAD));
  const y = Math.tan((obliq / 2) * RAD) ** 2;
  const eqTimeMin =
    4 *
    DEG *
    (y * Math.sin(2 * l0 * RAD) -
      2 * e * Math.sin(m * RAD) +
      4 * e * y * Math.sin(m * RAD) * Math.cos(2 * l0 * RAD) -
      0.5 * y * y * Math.sin(4 * l0 * RAD) -
      1.25 * e * e * Math.sin(2 * m * RAD));
  const dayMin = mod(utcMs / 60_000, 1440);
  const trueSolarMin = mod(dayMin + eqTimeMin + 4 * lonDeg, 1440);
  const hourAngle = trueSolarMin / 4 < 0 ? trueSolarMin / 4 + 180 : trueSolarMin / 4 - 180;
  const lat = latDeg * RAD;
  const cosZen = Math.min(
    1,
    Math.max(
      -1,
      Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(hourAngle * RAD),
    ),
  );
  const zen = Math.acos(cosZen);
  const denom = Math.cos(lat) * Math.sin(zen);
  let azimuth: number;
  if (Math.abs(denom) < 1e-9) azimuth = latDeg > 0 ? 180 : 0;
  else {
    const a =
      DEG * Math.acos(Math.min(1, Math.max(-1, (Math.sin(lat) * cosZen - Math.sin(decl)) / denom)));
    azimuth = hourAngle > 0 ? mod(a + 180, 360) : mod(540 - a, 360);
  }
  const el = 90 - zen * DEG;
  return { azimuthDeg: azimuth, elevationDeg: el + refractionDeg(el) };
}

/**
 * Unit vector toward a sky position in the local frame (x east, y up, z south). `convergenceDeg`
 * is the grid convergence of the project CRS at the site (true north to grid north, see
 * `gridConvergenceDeg` in @aio/geo): the grid bearing is the true bearing minus it.
 */
export function skyDirection(
  azimuthDeg: number,
  elevationDeg: number,
  convergenceDeg = 0,
): [number, number, number] {
  const g = (azimuthDeg - convergenceDeg) * RAD;
  const el = elevationDeg * RAD;
  return [Math.cos(el) * Math.sin(g), Math.sin(el), -Math.cos(el) * Math.cos(g)];
}

/** Whole hours ahead of UTC for civil time near a longitude (no time zone database offline). */
export function utcOffsetHours(lonDeg: number): number {
  return Math.round(lonDeg / 15);
}
