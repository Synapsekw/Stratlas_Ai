import type { Vec3 } from '@aio/schema';
import type { Insets, ViewSize } from './chips';
import {
  ecefToGeodetic,
  ecefToLocal,
  enuBasis,
  geodeticToEcef,
  localToEcef,
  type SiteGeoref,
} from './geodesy';

/**
 * The camera hand-off between the Globe and the site view (**Open site here**, **Back to globe**):
 * the same position and looking direction, converted between ECEF and the project's local frame
 * through the project CRS. The site view keeps a camera as a position and an orbit target
 * (`SavedView` of `@aio/engine`), the Globe as a position and a direction.
 *
 * And the box the Globe's camera flies to so that the chips of a set of sites are whole in the
 * view (`padBounds`).
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

// ---------------------------------------------------------------- framing sites

/** A box on the Earth: west, south, east and north, degrees. */
export type Bounds = [number, number, number, number];

/** The least a framed box spans, degrees of latitude: about a kilometre on the ground. */
const MIN_FRAME_SPAN_DEG = 0.01;

const RAD = Math.PI / 180;

/** The places CesiumJS keeps in view when it flies to a box. */
function marksOf([w, s, e, n]: Readonly<Bounds>): [number, number][] {
  const mid = (w + e) / 2;
  const marks: [number, number][] = [
    [w, n],
    [e, n],
    [w, s],
    [e, s],
    [mid, n],
    [mid, s],
  ];
  // across the equator a box is widest there
  if (s < 0 && n > 0) marks.push([w, 0], [e, 0]);
  return marks;
}

/**
 * Where places are drawn after a flight to `box`, in pixels of a view whose half angles have the
 * tangents `tanX` and `tanY`. As CesiumJS does it (`Camera.flyTo` with a rectangle): the camera
 * stands above the middle of the box, looks straight down with north up, and is just far enough
 * away for every mark of the box to be in view.
 */
function flightTo(box: Readonly<Bounds>, view: ViewSize, tanX: number, tanY: number) {
  const lon = (box[0] + box[2]) / 2;
  const lat = (box[1] + box[3]) / 2;
  const centre = geodeticToEcef(lon, lat, 0);
  const { e: right, n: up, u } = enuBasis(lon, lat);
  const from = (place: readonly [number, number]) =>
    sub(geodeticToEcef(place[0], place[1], 0), centre);
  let distance = -Infinity;
  for (const mark of marksOf(box)) {
    const v = from(mark);
    // a place away from the middle lies under the plane the camera looks down on
    const below = -dot(v, u);
    distance = Math.max(
      distance,
      Math.abs(dot(v, right)) / tanX - below,
      Math.abs(dot(v, up)) / tanY - below,
    );
  }
  const at = (place: readonly [number, number]): [number, number] => {
    const v = from(place);
    const depth = distance - dot(v, u);
    return [
      (view.width / 2) * (1 + dot(v, right) / (depth * tanX)),
      (view.height / 2) * (1 - dot(v, up) / (depth * tanY)),
    ];
  };
  return { distance, at };
}

/**
 * The box to fly to so that `bounds` lands inside the view less `pad` pixels at each edge: the
 * room the screen's controls take, and what a chip needs around its site (a chip runs far to the
 * right of it). A flight to a box fits the box to the whole view, so the box grows by what the
 * pads are worth on the ground, on a round Earth seen in perspective (a tenth of the view is not
 * a tenth of the degrees once the box is wide).
 *
 * A box with little or no span is first given `minSpanDeg` (the flight to one site must not end
 * on the ground). A box half the Earth wide, or pads that leave no view, come back as they are;
 * a box too wide for its pads grows until the whole Earth is in view, which is as far as a
 * flight to a box goes. East may pass 180 degrees: the caller wraps it. `fovDeg` is the view's
 * angle along its longer side (CesiumJS's default).
 */
export function padBounds(
  bounds: Readonly<Bounds>,
  view: ViewSize,
  pad: Insets,
  { fovDeg = 60, minSpanDeg = MIN_FRAME_SPAN_DEG } = {},
): Bounds {
  const [west, south, east, north] = bounds;
  const fits = view.width - pad.left - pad.right >= 1 && view.height - pad.top - pad.bottom >= 1;
  // the whole Earth shows anyway, or nothing of the view is left to frame in
  if (east - west >= 180 || !fits) return [west, south, east, north];

  // the least span, the same on the ground both ways
  const narrow = Math.max(Math.cos(((south + north) / 2) * RAD), 0.01);
  const addLat = Math.max(0, minSpanDeg - (north - south)) / 2;
  const addLon = Math.max(0, minSpanDeg / narrow - (east - west)) / 2;
  const wanted: Bounds = [
    west - addLon,
    Math.max(-90, south - addLat),
    east + addLon,
    Math.min(90, north + addLat),
  ];

  const tan = Math.tan((fovDeg / 2) * RAD);
  const aspect = view.width / view.height;
  const tanX = aspect >= 1 ? tan : tan * aspect;
  const tanY = aspect >= 1 ? tan / aspect : tan;
  // What must land inside: the whole edge of the box. A meridian bulges between its ends, which
  // are all CesiumJS looks at, so a wide box is not quite in view even after its own flight.
  const edge: [number, number][] = [];
  for (let i = 0; i <= 8; i++) {
    const lon = wanted[0] + ((wanted[2] - wanted[0]) * i) / 8;
    const lat = wanted[1] + ((wanted[3] - wanted[1]) * i) / 8;
    edge.push([lon, wanted[1]], [lon, wanted[3]], [wanted[0], lat], [wanted[2], lat]);
  }
  let box = wanted;
  let shown = { box, distance: -Infinity };
  // Growing the box moves the camera away, which takes back part of the room just made: each
  // round adds what is still missing, less every time (by the share of the view the pads take).
  for (let round = 0; round < 64; round++) {
    const flight = flightTo(box, view, tanX, tanY);
    // Once the whole Earth is in view a wider box brings the camera nearer again (its corners
    // go round the far side): the box before it showed the most there is to show.
    if (flight.distance < shown.distance || box[2] - box[0] >= 180) return shown.box;
    shown = { box, distance: flight.distance };
    const drawn = edge.map(flight.at);
    const xs = drawn.map((p) => p[0]);
    const ys = drawn.map((p) => p[1]);
    const left = Math.min(...xs);
    const right = Math.max(...xs);
    const top = Math.min(...ys);
    const bottom = Math.max(...ys);
    const missing = {
      left: Math.max(0, pad.left - left),
      right: Math.max(0, right - (view.width - pad.right)),
      top: Math.max(0, pad.top - top),
      bottom: Math.max(0, bottom - (view.height - pad.bottom)),
    };
    if (Math.max(missing.left, missing.right, missing.top, missing.bottom) < 0.05) break;
    const lonPerPixel = (wanted[2] - wanted[0]) / (right - left);
    const latPerPixel = (wanted[3] - wanted[1]) / (bottom - top);
    box = [
      box[0] - missing.left * lonPerPixel,
      Math.max(-90, box[1] - missing.bottom * latPerPixel),
      box[2] + missing.right * lonPerPixel,
      Math.min(90, box[3] + missing.top * latPerPixel),
    ];
  }
  return box;
}
