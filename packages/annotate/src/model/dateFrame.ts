import { fromWgs84, isKnownCrs, toWgs84 } from '@aio/geo';
import {
  isZeroShift,
  shiftEN,
  shiftLocal,
  unshiftLocal,
  type DateShift,
  type ProjectManifest,
  type Sighting,
  type Vec3,
} from '@aio/schema';
import { dateShiftOf } from '@aio/workspace';

/**
 * Sightings of a lined-up survey date (line up dates, Decisions 3 and 4). A sighting takes its
 * layer's date shift: readers add it (pins, drapes, cameras), writers subtract it, so a mesh,
 * cloud or map sighting picked on a shifted date is saved in the date's own frame and an Undo of
 * the line-up carries it along with the date. Image, video and pano sightings are in pixels or
 * directions and stay as they are.
 */

/** The date shift of a layer, or null when it does not move. */
export type ShiftOf = (layerId: string) => DateShift | null;

const NONE: ShiftOf = () => null;

/** The shifts of a manifest's layers (none without a project). */
export function shiftOfManifest(
  m: Pick<ProjectManifest, 'captures' | 'layers'> | null | undefined,
): ShiftOf {
  return m ? (id) => dateShiftOf(m, id) : NONE;
}

type Crs = ProjectManifest['crs'];

/**
 * A GeoJSON's positions ([lon, lat, ...]) moved in the project CRS; others kept. A `bbox` is
 * dropped (optional in GeoJSON, and no longer true once the positions move).
 */
function moveGeoJson(v: unknown, s: DateShift, sign: 1 | -1, epsg: number): unknown {
  if (!Array.isArray(v)) {
    if (!v || typeof v !== 'object') return v;
    const o = v as Record<string, unknown>;
    const out: Record<string, unknown> = { ...o };
    delete out.bbox;
    for (const k of ['coordinates', 'geometry', 'features', 'geometries'] as const)
      if (k in o) out[k] = moveGeoJson(o[k], s, sign, epsg);
    return out;
  }
  const arr: unknown[] = v;
  const [lon, lat] = arr;
  if (typeof lon !== 'number' || typeof lat !== 'number')
    return arr.map((x) => moveGeoJson(x, s, sign, epsg));
  const [e, n] = shiftEN(fromWgs84([lon, lat, 0], epsg), s, sign);
  const [lo, la] = toWgs84([e, n, 0], epsg);
  return [lo, la, ...arr.slice(2)];
}

/**
 * The sighting moved by `s` (`sign` 1 to draw it, -1 to store it). A map sighting moves in the
 * project CRS (the local frame is that CRS less the origin), so it needs a known `crs`.
 */
export function movedSighting(
  sighting: Sighting,
  s: DateShift | null,
  sign: 1 | -1,
  crs?: Crs,
): Sighting {
  if (!s || isZeroShift(s)) return sighting;
  const mv = (p: Vec3): Vec3 => (sign === 1 ? shiftLocal(p, s) : unshiftLocal(p, s));
  if (sighting.on === 'mesh') {
    const g = sighting.geom;
    switch (g.type) {
      case 'spoint':
        return { ...sighting, geom: { ...g, p: mv(g.p) } };
      case 'spolyline':
      case 'spolygon':
        return { ...sighting, geom: { ...g, points: g.points.map(mv) } };
      case 'spatch':
        return g.center ? { ...sighting, geom: { ...g, center: mv(g.center) } } : sighting;
    }
  }
  if (sighting.on === 'pointcloud') {
    const g = sighting.geom;
    switch (g.type) {
      case 'point3':
        return { ...sighting, geom: { ...g, p: mv(g.p) } };
      case 'box3':
        return { ...sighting, geom: { ...g, min: mv(g.min), max: mv(g.max) } };
      case 'polygon3':
        return { ...sighting, geom: { ...g, points: g.points.map(mv) } };
      case 'selection':
        // the points live in the `.sel` file, written by the placement store
        return sighting;
    }
  }
  if (sighting.on === 'map') {
    if (!crs || !('epsg' in crs) || !isKnownCrs(crs.epsg)) return sighting;
    const geojson = moveGeoJson(sighting.geojson, s, sign, crs.epsg) as Record<string, unknown>;
    return { ...sighting, geojson };
  }
  return sighting;
}

/** What a writer saves for a sighting picked on the open project's views: its date's own frame. */
export function sightingInDateFrame(
  sighting: Sighting,
  m: Pick<ProjectManifest, 'captures' | 'layers' | 'crs'> | null | undefined,
): Sighting {
  if (!m) return sighting;
  return movedSighting(sighting, dateShiftOf(m, sighting.layer), -1, m.crs);
}
