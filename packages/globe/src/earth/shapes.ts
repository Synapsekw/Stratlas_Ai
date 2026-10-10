/**
 * The Earth's land and country borders as plain rings and lines, decoded once from the bundled
 * Natural Earth vector data (public domain; the `world-atlas` package, 1:50m, TopoJSON). They are
 * what the Globe draws under the street map and wherever no street pack is installed, in the
 * street style's own colours, so a fresh install shows a clean Earth and a pack meets it without
 * a seam. No CesiumJS and no canvas here: `draw.ts` paints them, the view turns that into tiles.
 */
import { feature, mesh } from 'topojson-client';
import type { Feature, FeatureCollection } from 'geojson';
import type { GeometryObject, Topology } from 'topojson-specification';

type TopologyObject = GeometryObject<Record<string, unknown>>;
/** A topology as `world-atlas` ships it: named objects that share one list of arcs. */
export type EarthTopology = Topology<Record<string, TopologyObject>>;

/** West, south, east, north in degrees. */
export type Box = readonly [number, number, number, number];

/** Longitude and latitude pairs, flat: `[lon0, lat0, lon1, lat1, ...]`. */
export interface EarthPath {
  readonly pts: Float32Array;
  readonly box: Box;
}

/** A land polygon: the outer ring first, then its holes (lakes are not cut out at this scale). */
export interface EarthPolygon {
  readonly rings: readonly EarthPath[];
  readonly box: Box;
}

export interface EarthShapes {
  readonly land: readonly EarthPolygon[];
  /** Borders between two countries, each drawn once (never a coast). */
  readonly borders: readonly EarthPath[];
}

type Position = readonly number[];

function pathOf(points: readonly Position[]): EarthPath {
  const pts = new Float32Array(points.length * 2);
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  points.forEach((p, i) => {
    const lon = p[0] ?? 0;
    const lat = p[1] ?? 0;
    pts[i * 2] = lon;
    pts[i * 2 + 1] = lat;
    if (lon < w) w = lon;
    if (lon > e) e = lon;
    if (lat < s) s = lat;
    if (lat > n) n = lat;
  });
  return { pts, box: [w, s, e, n] };
}

const polygonOf = (rings: readonly (readonly Position[])[]): EarthPolygon | null => {
  const paths = rings.filter((r) => r.length >= 4).map(pathOf);
  const outer = paths[0];
  return outer ? { rings: paths, box: outer.box } : null;
};

/** The object of a topology by name, or a message that says which names it has. */
function objectOf(topology: EarthTopology, name: string): TopologyObject {
  const o = topology.objects[name];
  if (!o) {
    const have = Object.keys(topology.objects).join(', ');
    throw new Error(`The Earth shapes have no "${name}" object (found: ${have}).`);
  }
  return o;
}

/**
 * Land polygons and country borders of a `world-atlas` countries topology (its `land` and
 * `countries` objects share their arcs, so one file holds both).
 */
export function decodeEarth(topology: EarthTopology): EarthShapes {
  const landGeometry = feature(topology, objectOf(topology, 'land')) as Feature | FeatureCollection;
  const geometries =
    landGeometry.type === 'FeatureCollection'
      ? landGeometry.features.map((f) => f.geometry)
      : [landGeometry.geometry];
  const land: EarthPolygon[] = [];
  for (const g of geometries) {
    const polygons =
      g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
    for (const rings of polygons) {
      const p = polygonOf(rings);
      if (p) land.push(p);
    }
  }
  // an arc two different countries share is a border; one a country has alone is a coast
  const lines = mesh(topology, objectOf(topology, 'countries'), (a, b) => a !== b);
  const borders = lines.coordinates.filter((l) => l.length >= 2).map(pathOf);
  return { land, borders };
}

/** Parse the bundled file's text and decode it. */
export function parseEarth(json: string): EarthShapes {
  return decodeEarth(JSON.parse(json) as EarthTopology);
}

export const boxesMeet = (a: Box, b: Box): boolean =>
  a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

/** How many points the shapes hold (for the inspection hook and tests). */
export function earthPointCount(shapes: EarthShapes): number {
  let n = 0;
  for (const p of shapes.land) for (const r of p.rings) n += r.pts.length / 2;
  for (const b of shapes.borders) n += b.pts.length / 2;
  return n;
}
