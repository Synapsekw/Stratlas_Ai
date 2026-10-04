import { fromWgs84, isKnownCrs, projectToLocal } from '@aio/geo';
import type { Issue, ProjectManifest, SeverityModel, Vec3 } from '@aio/schema';
import { ShapeUtils, Vector2 } from 'three';
import { severityColor } from './mesh';

/** Local ground (x, z) of a lon/lat. */
export type MapToLocal = (lon: number, lat: number) => [number, number];

/** Lon/lat to the local frame (x east, z south) for a project CRS, or null if the CRS is unknown. */
export function mapToLocal(
  crs: ProjectManifest['crs'],
  origin: Vec3 | readonly [number, number, number],
): MapToLocal | null {
  if (!('epsg' in crs) || !isKnownCrs(crs.epsg)) return null;
  const epsg = crs.epsg;
  const o: Vec3 = [origin[0], origin[1], origin[2]];
  return (lon, lat) => {
    const local = projectToLocal(fromWgs84([lon, lat, o[2]], epsg), o);
    return [local[0], local[2]];
  };
}

export interface DrapedShapes {
  /** Outline segments (pairs of vertices) of every issue's map polygons, with RGB colours. */
  lines: { positions: Float32Array; colors: Float32Array };
  /** Triangulated fills with RGB colours; `faceIssue[i]` is the issue of triangle i. */
  fill: { positions: Float32Array; colors: Float32Array; indices: number[]; faceIssue: string[] };
  /** The selected issue's outline segments, drawn on top. */
  selected: { issueId: string; positions: Float32Array } | null;
}

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', '').slice(0, 6), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** Rings (outer first) of each Polygon or MultiPolygon in a map sighting. */
function polygonsOf(geojson: Record<string, unknown>): number[][][][] {
  const g = (geojson.type === 'Feature' ? geojson.geometry : geojson) as
    { type?: string; coordinates?: unknown } | undefined;
  if (g?.type === 'Polygon') return [g.coordinates as number[][][]];
  if (g?.type === 'MultiPolygon') return g.coordinates as number[][][][];
  return [];
}

/**
 * Geometry for issues' polygon map sightings draped on the ground at height `y`: coloured outlines
 * and fills (with the issue of each triangle, for picking), and the selected issue's outline.
 */
export function drapedShapes(
  issues: readonly Issue[],
  models: readonly SeverityModel[],
  selectedId: string | null,
  toLocal: MapToLocal,
  y: number,
): DrapedShapes {
  const modelById = new Map(models.map((m) => [m.id, m]));
  const lp: number[] = [];
  const lc: number[] = [];
  const fp: number[] = [];
  const fc: number[] = [];
  const idx: number[] = [];
  const faceIssue: string[] = [];
  let selected: DrapedShapes['selected'] = null;
  for (const issue of issues) {
    const color = rgb(severityColor(modelById.get(issue.severityModelId), issue.severity));
    const sel: number[] = [];
    for (const s of issue.sightings) {
      if (s.on !== 'map') continue;
      for (const poly of polygonsOf(s.geojson)) {
        const rings = poly.map((ring) => {
          const pts = ring.map(([lon = 0, lat = 0]) => toLocal(lon, lat));
          const first = pts[0];
          const last = pts[pts.length - 1];
          const closed = first !== undefined && first[0] === last?.[0] && first[1] === last[1];
          if (pts.length > 1 && closed) pts.pop();
          return pts;
        });
        for (const ring of rings) {
          for (let i = 0; i < ring.length; i++) {
            const a = ring[i];
            const b = ring[(i + 1) % ring.length];
            if (!a || !b) continue;
            const seg = [a[0], y, a[1], b[0], y, b[1]];
            lp.push(...seg);
            lc.push(...color, ...color);
            if (issue.id === selectedId) sel.push(...seg);
          }
        }
        const [outer, ...holes] = rings;
        if (!outer || outer.length < 3) continue;
        const contour = outer.map(([x, z]) => new Vector2(x, z));
        const holeVs = holes
          .filter((h) => h.length >= 3)
          .map((h) => h.map(([x, z]) => new Vector2(x, z)));
        const tris = ShapeUtils.triangulateShape(contour, holeVs);
        const base = fp.length / 3;
        for (const v of [...contour, ...holeVs.flat()]) {
          fp.push(v.x, y, v.y);
          fc.push(...color);
        }
        for (const [a = 0, b = 0, c = 0] of tris) {
          idx.push(base + a, base + b, base + c);
          faceIssue.push(issue.id);
        }
      }
    }
    if (sel.length) selected = { issueId: issue.id, positions: new Float32Array(sel) };
  }
  return {
    lines: { positions: new Float32Array(lp), colors: new Float32Array(lc) },
    fill: {
      positions: new Float32Array(fp),
      colors: new Float32Array(fc),
      indices: idx,
      faceIssue,
    },
    selected,
  };
}
