import { fromWgs84, isKnownCrs } from './index';

/** A coordinate reference system the CRS picker offers. */
export interface CrsOption {
  epsg: number;
  /** Short name, e.g. "WGS 84 / UTM zone 39N". */
  name: string;
  /** Where it is used, for search and as a hint. */
  label: string;
}

const utm = (zone: number, where: string): CrsOption => ({
  epsg: 32600 + zone,
  name: `WGS 84 / UTM zone ${String(zone)}N`,
  label: where,
});

/** WGS84 UTM north zones covering the GCC states, west to east. */
export const GCC_CRS: readonly CrsOption[] = [
  utm(36, 'Saudi Arabia west coast (Tabuk, NEOM)'),
  utm(37, 'Saudi Arabia west (Jeddah, Madinah, Makkah)'),
  utm(38, 'Saudi Arabia central (Riyadh), Kuwait west, Iraq south'),
  utm(39, 'Kuwait, Saudi Arabia east (Dammam, Jubail), Bahrain, Qatar, UAE west (Abu Dhabi)'),
  utm(40, 'UAE east (Dubai, Sharjah, Fujairah), Oman'),
];

const EXTRA: Record<number, Omit<CrsOption, 'epsg'>> = {
  4326: { name: 'WGS 84', label: 'Longitude and latitude in degrees (not for project frames)' },
  3857: { name: 'WGS 84 / Pseudo-Mercator', label: 'Web map tiles' },
};

/** Describe any bundled EPSG code, or null when the app cannot use it offline. */
export function crsOption(epsg: number): CrsOption | null {
  const gcc = GCC_CRS.find((c) => c.epsg === epsg);
  if (gcc) return gcc;
  if (!isKnownCrs(epsg)) return null;
  const extra = EXTRA[epsg];
  if (extra) return { epsg, ...extra };
  const zone = epsg % 100;
  const south = epsg - zone === 32700;
  return {
    epsg,
    name: `WGS 84 / UTM zone ${String(zone)}${south ? 'S' : 'N'}`,
    label: `UTM zone ${String(zone)} ${south ? 'south' : 'north'}`,
  };
}

/** WGS84 UTM EPSG code of the zone that holds a longitude and latitude. */
export function utmEpsgFor(lon: number, lat: number): number {
  const zone = Math.min(60, Math.max(1, Math.floor((lon + 180) / 6) + 1));
  return (lat >= 0 ? 32600 : 32700) + zone;
}

/**
 * Search the CRS picker: GCC zones by place, zone ("39N") or code; any bundled EPSG code typed in
 * full ("EPSG:32633", "4326") is offered too. An empty query lists the GCC zones.
 */
export function searchCrs(query: string): CrsOption[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...GCC_CRS];
  const code = /^(?:epsg:?\s*)?(\d{4,5})$/.exec(q);
  if (code) {
    const o = crsOption(Number(code[1]));
    return o ? [o] : [];
  }
  const zone = /^(?:utm\s*)?(?:zone\s*)?(\d{1,2})\s*n$/.exec(q);
  if (zone) return GCC_CRS.filter((c) => c.epsg === 32600 + Number(zone[1]));
  return GCC_CRS.filter((c) => `${c.name} ${c.label}`.toLowerCase().includes(q));
}

/**
 * Grid convergence in degrees: the angle from true north to grid north, positive when grid north
 * lies east of true north (east of the central meridian in the northern hemisphere). A true
 * bearing `h` is the grid bearing `h - convergence`.
 */
export function gridConvergenceDeg(lon: number, lat: number, epsg: number): number {
  const d = 1e-4;
  const a = fromWgs84([lon, lat - d, 0], epsg);
  const b = fromWgs84([lon, lat + d, 0], epsg);
  // grid azimuth of true north is -convergence
  return -(Math.atan2(b[0] - a[0], b[1] - a[1]) * 180) / Math.PI;
}
