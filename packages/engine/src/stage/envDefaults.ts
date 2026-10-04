import { gridConvergenceDeg, isKnownCrs, toWgs84 } from '@aio/geo';
import type { ProjectManifest } from '@aio/schema';
import type { EnvironmentMode } from './environment';
import { utcOffsetHours } from './solar';

/** Where a project is on the Earth: WGS84 degrees and the grid convergence of its CRS there. */
export interface SiteLocation {
  lat: number;
  lon: number;
  convergenceDeg: number;
  /** Civil time offset used for display, whole hours (no time zone database offline). */
  utcOffsetHours: number;
}

/** The project's origin in WGS84, or null for a local or unknown CRS. */
export function siteLocation(m: Pick<ProjectManifest, 'crs' | 'origin'>): SiteLocation | null {
  if (!('epsg' in m.crs) || !isKnownCrs(m.crs.epsg) || m.crs.epsg === 3857) return null;
  try {
    const [lon, lat] = toWgs84(m.origin, m.crs.epsg);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 89.9) return null;
    // a zero origin in a projected CRS is a placeholder, not a site
    if (m.origin[0] === 0 && m.origin[1] === 0 && m.crs.epsg !== 4326) return null;
    const convergenceDeg = m.crs.epsg === 4326 ? 0 : gridConvergenceDeg(lon, lat, m.crs.epsg);
    return { lat, lon, convergenceDeg, utcOffsetHours: utcOffsetHours(lon) };
  } catch {
    return null;
  }
}

/** The settings the stage starts a project with; the app keeps the user's changes per project. */
export interface EnvironmentSettings {
  mode: EnvironmentMode;
  /** The instant the sun is shown at, ms since the Unix epoch (UTC). */
  timeMs: number;
  /** Show animated water where the project has a sea level (or `waterLevel` is set). */
  water: boolean;
  /** Water level, local y in metres; null takes the level found in the project data. */
  waterLevel: number | null;
}

/**
 * Sky for projects placed on the Earth that have ground imagery or a basemap (the site reads as
 * a place outdoors); Studio for the rest, such as a single tank or a building model, where a
 * neutral backdrop keeps the asset in focus.
 */
export function defaultMode(
  m: Pick<ProjectManifest, 'crs' | 'origin' | 'layers'>,
): EnvironmentMode {
  if (!siteLocation(m)) return 'studio';
  const ground = m.layers.some(
    (l) => (l.kind === 'raster' && l.role !== 'plan') || l.kind === 'basemap',
  );
  return ground ? 'sky' : 'studio';
}

const DAY = 86_400_000;

/**
 * The capture instant: the first video flight or timed photo on the latest capture date (the
 * light the data was recorded in), else 10:00 site time on that date, else 10:00 today.
 */
export function defaultTime(
  m: Pick<ProjectManifest, 'captures' | 'layers' | 'crs' | 'origin'>,
  nowMs: number,
): number {
  const offsetMs = (siteLocation(m)?.utcOffsetHours ?? 0) * 3_600_000;
  const dates = m.captures.map((c) => c.date).sort();
  const date = dates.at(-1);
  // site-local midnight of the capture date, or of today
  const dayStart = date
    ? Date.parse(`${date}T00:00:00Z`) - offsetMs
    : Math.floor((nowMs + offsetMs) / DAY) * DAY - offsetMs;
  const times: number[] = [];
  for (const l of m.layers) {
    if (l.kind === 'video') times.push(l.flight.startUtcMs + l.offsetMs);
    if (l.kind === 'photos')
      for (const p of l.items) if (p.takenAt) times.push(Date.parse(p.takenAt));
  }
  const onDay = times.filter((t) => t >= dayStart && t < dayStart + DAY).sort((a, b) => a - b);
  return onDay[0] ?? dayStart + 10 * 3_600_000;
}

export function defaultEnvironment(m: ProjectManifest, nowMs: number): EnvironmentSettings {
  return { mode: defaultMode(m), timeMs: defaultTime(m, nowMs), water: true, waterLevel: null };
}
