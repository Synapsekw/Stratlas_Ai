import { localToProject, toWgs84 } from '@aio/geo';
import type { Issue, Sighting, Vec3 } from '@aio/schema';
import {
  classInfo,
  epsgOf,
  issueLocation,
  issueZone,
  severityInfo,
  sortByCode,
  type ExportContext,
} from './facts';

export type Position = number[];
export type GeoGeometry =
  | { type: 'Point'; coordinates: Position }
  | { type: 'MultiPoint'; coordinates: Position[] }
  | { type: 'LineString'; coordinates: Position[] }
  | { type: 'MultiLineString'; coordinates: Position[][] }
  | { type: 'Polygon'; coordinates: Position[][] }
  | { type: 'MultiPolygon'; coordinates: Position[][][] };

export interface IssueFeatureProps {
  issueId: string;
  code: string;
  title: string;
  classId: string;
  class: string;
  severity: number | 'uncertain';
  severityLabel: string;
  /** Severity colour from the model, for styling in GIS tools. */
  color: string;
  status: string;
  zone: string;
  /** The dataset the geometry comes from: map (drawn on the map) or mesh / pointcloud (3D). */
  sighting: Sighting['on'];
  layer: string;
  easting: number | null;
  northing: number | null;
  height: number | null;
}

export interface IssueFeatureCollection {
  type: 'FeatureCollection';
  /** Foreign member: which project and CRS the properties' easting and northing use. */
  project: { id: string; name: string; crs: string };
  features: { type: 'Feature'; id: string; geometry: GeoGeometry; properties: IssueFeatureProps }[];
}

const GEOMETRY_TYPES = new Set([
  'Point',
  'MultiPoint',
  'LineString',
  'MultiLineString',
  'Polygon',
  'MultiPolygon',
]);

const round = (v: number, d: number) => Number(v.toFixed(d));

function geometryOf(s: Sighting, toLonLat: ((p: Vec3) => Position) | null): GeoGeometry | null {
  if (s.on === 'map') {
    const g = s.geojson as { type?: unknown; coordinates?: unknown };
    return typeof g.type === 'string' && GEOMETRY_TYPES.has(g.type) && Array.isArray(g.coordinates)
      ? (s.geojson as unknown as GeoGeometry)
      : null;
  }
  if (!toLonLat) return null;
  const ring = (pts: readonly Vec3[]): Position[] => {
    const r = pts.map(toLonLat);
    const first = r[0];
    return first ? [...r, first] : r;
  };
  if (s.on === 'mesh') {
    const g = s.geom;
    switch (g.type) {
      case 'spoint':
        return { type: 'Point', coordinates: toLonLat(g.p) };
      case 'spolyline':
        return { type: 'LineString', coordinates: g.points.map(toLonLat) };
      case 'spolygon':
        return { type: 'Polygon', coordinates: [ring(g.points)] };
      case 'spatch':
        return g.center ? { type: 'Point', coordinates: toLonLat(g.center) } : null;
    }
  }
  if (s.on === 'pointcloud') {
    const g = s.geom;
    switch (g.type) {
      case 'point3':
        return { type: 'Point', coordinates: toLonLat(g.p) };
      case 'polygon3':
        return { type: 'Polygon', coordinates: [ring(g.points)] };
      case 'box3': {
        const y = g.min[1];
        return {
          type: 'Polygon',
          coordinates: [
            ring([
              [g.min[0], y, g.min[2]],
              [g.max[0], y, g.min[2]],
              [g.max[0], y, g.max[2]],
              [g.min[0], y, g.max[2]],
            ]),
          ],
        };
      }
      case 'selection':
        return null;
    }
  }
  return null;
}

/**
 * RFC 7946 GeoJSON: one feature per sighting with a place on the ground or the model (map
 * drawings, mesh and point-cloud geometry), in WGS84 with ellipsoid-free heights in metres.
 */
export function issuesGeoJson(ctx: ExportContext): IssueFeatureCollection {
  const m = ctx.manifest;
  const epsg = epsgOf(m);
  const toLonLat =
    epsg === null
      ? null
      : (p: Vec3): Position => {
          const [e, n, h] = localToProject(p, m.origin);
          const [lon, lat] = toWgs84([e, n, h], epsg);
          return [round(lon, 9), round(lat, 9), round(h, 3)];
        };
  const features: IssueFeatureCollection['features'] = [];
  for (const issue of sortByCode(ctx.issues)) {
    const props = baseProps(ctx, issue);
    issue.sightings.forEach((s, i) => {
      const geometry = geometryOf(s, toLonLat);
      if (!geometry) return;
      features.push({
        type: 'Feature',
        id: `${issue.id}#${String(i)}`,
        geometry,
        properties: { ...props, sighting: s.on, layer: s.layer },
      });
    });
  }
  return {
    type: 'FeatureCollection',
    project: {
      id: m.id,
      name: m.name,
      crs: 'epsg' in m.crs ? `EPSG:${String(m.crs.epsg)}` : 'WKT',
    },
    features,
  };
}

function baseProps(
  ctx: ExportContext,
  issue: Issue,
): Omit<IssueFeatureProps, 'sighting' | 'layer'> {
  const m = ctx.manifest;
  const sev = severityInfo(m, issue);
  const loc = issueLocation(m, issue);
  return {
    issueId: issue.id,
    code: issue.code,
    title: issue.title,
    classId: issue.classId,
    class: classInfo(m, issue.classId).label,
    severity: issue.severity,
    severityLabel: sev.label,
    color: sev.color,
    status: issue.status,
    zone: issueZone(issue),
    easting: loc ? round(loc.project[0], 3) : null,
    northing: loc ? round(loc.project[1], 3) : null,
    height: loc?.project[2] == null ? null : round(loc.project[2], 3),
  };
}
