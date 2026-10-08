import type { Vec3 } from '@aio/schema';
import proj4 from 'proj4';

/**
 * The project frame: a float64 origin in the project CRS. Geometry is rendered relative to it
 * so float32 GPU coordinates stay precise at UTM magnitudes.
 *
 * Local frame (docs/architecture/data-conventions.md section 1): metres, Y up, X east, Z south.
 * `E = origin[0] + x`, `N = origin[1] - z`, `H = origin[2] + y`.
 */
export interface ProjectFrame {
  readonly epsg: number;
  readonly origin: Vec3;
  /** Project CRS coordinates (E, N, H) to local metres around the origin. */
  toLocal(xyz: Vec3): Vec3;
  /** Local metres back to project CRS coordinates (E, N, H). */
  toProject(local: Vec3): Vec3;
}

/** Local frame (x east, y up, z south) to project CRS (E, N, H). */
export function localToProject(local: Vec3, origin: Vec3): Vec3 {
  const [x, y, z] = local;
  return [origin[0] + x, origin[1] - z, origin[2] + y];
}

/** Project CRS (E, N, H) to the local frame (x east, y up, z south). */
export function projectToLocal(p: Vec3, origin: Vec3): Vec3 {
  const [e, n, h] = p;
  // `0 - x` keeps +0 instead of -0 so values compare cleanly.
  return [e - origin[0], h - origin[2], 0 - (n - origin[1])];
}

export function createFrame(origin: Vec3, epsg: number): ProjectFrame {
  return {
    epsg,
    origin,
    toLocal: (p) => projectToLocal(p, origin),
    toProject: (l) => localToProject(l, origin),
  };
}

/* ---------------------------------------------------------------------------------------------
 * CRS registry. Definitions are bundled so nothing is ever fetched (the app runs offline).
 * ------------------------------------------------------------------------------------------- */

const STATIC_DEFS: Record<number, string> = {
  4326: '+proj=longlat +datum=WGS84 +no_defs',
  3857: '+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +wktext +no_defs',
};

/** proj4 definition string for an EPSG code. WGS84 UTM zones (326xx, 327xx) are generated. */
export function crsDefinition(epsg: number): string {
  const fixed = STATIC_DEFS[epsg];
  if (fixed) return fixed;
  const zone = epsg % 100;
  if (zone >= 1 && zone <= 60) {
    if (epsg - zone === 32600) return `+proj=utm +zone=${zone} +datum=WGS84 +units=m +no_defs`;
    if (epsg - zone === 32700)
      return `+proj=utm +zone=${zone} +south +datum=WGS84 +units=m +no_defs`;
  }
  throw new Error(`EPSG:${epsg} is not in the bundled CRS registry`);
}

/** True when the EPSG code can be used offline. */
export function isKnownCrs(epsg: number): boolean {
  try {
    crsDefinition(epsg);
    return true;
  } catch {
    return false;
  }
}

const converters = new Map<number, proj4.Converter>();
function converter(epsg: number): proj4.Converter {
  let c = converters.get(epsg);
  if (!c) {
    c = proj4(crsDefinition(epsg), crsDefinition(4326));
    converters.set(epsg, c);
  }
  return c;
}

/** Project CRS (E, N, H) to WGS84 (lon, lat, H). Height passes through unchanged. */
export function toWgs84(p: Vec3, epsg: number): Vec3 {
  const [lon, lat] = converter(epsg).forward([p[0], p[1]]);
  return [lon, lat, p[2]];
}

/** WGS84 (lon, lat, H) to the project CRS (E, N, H). Height passes through unchanged. */
export function fromWgs84(ll: Vec3, epsg: number): Vec3 {
  const [e, n] = converter(epsg).inverse([ll[0], ll[1]]);
  return [e, n, ll[2]];
}

/** UTM north (WGS84) to [lon, lat] in degrees. Zone defaults to 39 (Kuwait, eastern Gulf). */
export function utmToWgs84(easting: number, northing: number, zone = 39): [number, number] {
  const [lon, lat] = toWgs84([easting, northing, 0], 32600 + zone);
  return [lon, lat];
}

/** [lon, lat] in degrees to UTM north (WGS84) [easting, northing]. */
export function wgs84ToUtm(lon: number, lat: number, zone = 39): [number, number] {
  const [e, n] = fromWgs84([lon, lat, 0], 32600 + zone);
  return [e, n];
}

export * from './crs';
export * from './similarity';
export * from './camera';
export * from './altitude';
export * from './flight';
export * from './direction';
export * from './photo';
export * from './units';
