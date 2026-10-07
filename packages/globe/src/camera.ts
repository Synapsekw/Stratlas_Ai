import type { Vec3 } from '@aio/schema';
import { ecefToGeodetic, ecefToLocal, enuBasis, localToEcef, type SiteGeoref } from './geodesy';

/**
 * The camera hand-off between the Globe and the site view (**Open site here**, **Back to globe**):
 * the same position and looking direction, converted between ECEF and the project's local frame
 * through the project CRS. The site view keeps a camera as a position and an orbit target
 * (`SavedView` of `@aio/engine`), the Globe as a position and a direction.
 */

/** A Globe camera: ECEF position and unit direction. */
export interface GlobeCamera {
  position: Vec3;
  direction: Vec3;
}

/** A site view camera (`@aio/engine` `SavedView`): local-frame position and orbit target. */
export interface SiteCamera {
  position: Vec3;
  target: Vec3;
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: Vec3): Vec3 => scale(a, 1 / Math.hypot(a[0], a[1], a[2]));

/** Where the orbit target goes when the camera looks at the horizon or up: this far ahead. */
const LEVEL_TARGET_M = 100;
const MAX_TARGET_M = 20_000;

/**
 * The site view camera for a Globe camera: the same position; the target where the line of sight
 * meets the site's ground plane (local height 0), or 100 m ahead when it does not.
 */
export function globeToSite(cam: GlobeCamera, g: SiteGeoref): SiteCamera {
  const p = ecefToLocal(cam.position, g);
  const ahead = ecefToLocal(add(cam.position, cam.direction), g);
  const d = norm(sub(ahead, p));
  const t = d[1] < -0.02 ? Math.min(-p[1] / d[1], MAX_TARGET_M) : LEVEL_TARGET_M;
  return { position: p, target: add(p, scale(d, t)) };
}

/** The Globe camera for a site view camera: the same position, looking at the target. */
export function siteToGlobe(cam: SiteCamera, g: SiteGeoref): GlobeCamera {
  const position = localToEcef(cam.position, g);
  const target = localToEcef(cam.target, g);
  return { position, direction: norm(sub(target, position)) };
}

/** Heading (clockwise from true north) and pitch (up positive) of a direction, in degrees. */
export function headingPitch(cam: GlobeCamera): { heading: number; pitch: number } {
  const [lon, lat] = ecefToGeodetic(...cam.position);
  const { e, n, u } = enuBasis(lon, lat);
  const d = norm(cam.direction);
  const heading = (Math.atan2(dot(d, e), dot(d, n)) * 180) / Math.PI;
  const pitch = (Math.asin(Math.max(-1, Math.min(1, dot(d, u)))) * 180) / Math.PI;
  return { heading: (heading + 360) % 360, pitch };
}
