import type { Issue, LensModel, PoseSample, Vec3 } from '@aio/schema';
import { Quaternion, Vector3 } from 'three';
import type { FrameProjection } from './geo';

export type LonLat = [number, number];

/** Local raster corners (data-conventions section 5) to a MapLibre image quad: tl, tr, br, bl. */
export function rasterQuad(
  corners: { tl: Vec3; tr: Vec3; bl: Vec3 },
  proj: FrameProjection,
): [LonLat, LonLat, LonLat, LonLat] {
  const { tl, tr, bl } = corners;
  const br: Vec3 = [tr[0] + bl[0] - tl[0], tr[1] + bl[1] - tl[1], tr[2] + bl[2] - tl[2]];
  return [proj.toLonLat(tl), proj.toLonLat(tr), proj.toLonLat(br), proj.toLonLat(bl)];
}

/** Pose at flight time `t` (ms since flight start): linear position, slerped orientation. */
export function poseAt(samples: readonly PoseSample[], t: number): PoseSample | null {
  const first = samples[0];
  const last = samples[samples.length - 1];
  if (!first || !last) return null;
  if (t <= first.t) return first;
  if (t >= last.t) return last;
  let lo = 0;
  let hi = samples.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((samples[mid]?.t ?? 0) <= t) lo = mid;
    else hi = mid;
  }
  const a = samples[lo] ?? first;
  const b = samples[hi] ?? last;
  const k = b.t > a.t ? (t - a.t) / (b.t - a.t) : 0;
  const q = new Quaternion(...a.q).slerp(new Quaternion(...b.q), k);
  return {
    t,
    pos: [
      a.pos[0] + (b.pos[0] - a.pos[0]) * k,
      a.pos[1] + (b.pos[1] - a.pos[1]) * k,
      a.pos[2] + (b.pos[2] - a.pos[2]) * k,
    ],
    q: [q.x, q.y, q.z, q.w],
  };
}

/** Camera-space directions of the four image corners (tl, tr, br, bl); camera looks along -Z. */
function cornerRays(lens: LensModel): Vector3[] {
  const half = ((lens.hfovDeg / 2) * Math.PI) / 180;
  const signs: [number, number][] = [
    [-1, 1],
    [1, 1],
    [1, -1],
    [-1, -1],
  ];
  if (lens.model === 'pinhole') {
    const tx = Math.tan(half);
    const ty = tx / lens.aspect;
    return signs.map(([sx, sy]) => new Vector3(sx * tx, sy * ty, -1).normalize());
  }
  // f-theta (equidistant): angle from the axis grows linearly with image radius.
  const phi = Math.atan2(1 / lens.aspect, 1);
  const theta = Math.min(half * Math.hypot(1, 1 / lens.aspect), (89 * Math.PI) / 180);
  return signs.map(([sx, sy]) =>
    new Vector3(
      sx * Math.sin(theta) * Math.cos(phi),
      sy * Math.sin(theta) * Math.sin(phi),
      -Math.cos(theta),
    ).normalize(),
  );
}

/**
 * Ground footprint (local frame, on the plane y = groundY) of a camera pose: the four image
 * corners cast onto the ground, each capped at `maxRange` metres from the camera.
 */
export function footprint(
  pose: PoseSample,
  lens: LensModel,
  { groundY = 0, maxRange = 2000 }: { groundY?: number; maxRange?: number } = {},
): Vec3[] {
  const q = new Quaternion(...pose.q);
  const origin = new Vector3(...pose.pos);
  return cornerRays(lens).map((ray) => {
    const dir = ray.applyQuaternion(q);
    let t = maxRange;
    if (dir.y < -1e-9) t = Math.min(t, (groundY - origin.y) / dir.y);
    if (t < 0) t = 0;
    const p = origin.clone().addScaledVector(dir, t);
    // Rays capped above the ground are dropped onto it so the polygon stays planar.
    return [p.x, groundY, p.z];
  });
}

function centroid(points: readonly (readonly number[])[]): number[] | null {
  if (!points.length) return null;
  const n = points[0]?.length ?? 0;
  const sum = new Array<number>(n).fill(0);
  for (const p of points) for (let i = 0; i < n; i++) sum[i] = (sum[i] ?? 0) + (p[i] ?? 0);
  return sum.map((s) => s / points.length);
}

/** Every [lon, lat] position in a GeoJSON geometry, feature or feature collection. */
function geojsonPositions(g: unknown, out: LonLat[] = []): LonLat[] {
  if (Array.isArray(g)) {
    if (g.length >= 2 && typeof g[0] === 'number' && typeof g[1] === 'number')
      out.push([g[0], g[1]]);
    else for (const x of g) geojsonPositions(x, out);
  } else if (g && typeof g === 'object') {
    const o = g as Record<string, unknown>;
    if ('coordinates' in o) geojsonPositions(o.coordinates, out);
    if ('geometry' in o) geojsonPositions(o.geometry, out);
    if (Array.isArray(o.features)) for (const f of o.features) geojsonPositions(f, out);
    if (Array.isArray(o.geometries)) for (const f of o.geometries) geojsonPositions(f, out);
  }
  return out;
}

/** Where an issue sits on the map: a map sighting, else the first 3D sighting. Null if none. */
export function issueAnchor(issue: Issue, proj: FrameProjection | null): LonLat | null {
  for (const s of issue.sightings) {
    if (s.on !== 'map') continue;
    const c = centroid(geojsonPositions(s.geojson));
    if (c) return [c[0] ?? 0, c[1] ?? 0];
  }
  if (!proj) return null;
  for (const s of issue.sightings) {
    let local: number[] | null = null;
    if (s.on === 'mesh') {
      const g = s.geom;
      if (g.type === 'spoint') local = g.p;
      else if (g.type === 'spolyline' || g.type === 'spolygon') local = centroid(g.points);
      else if (g.center) local = g.center;
    } else if (s.on === 'pointcloud') {
      const g = s.geom;
      if (g.type === 'point3') local = g.p;
      else if (g.type === 'box3') local = centroid([g.min, g.max]);
      else if (g.type === 'polygon3') local = centroid(g.points);
    }
    if (local) return proj.toLonLat([local[0] ?? 0, local[1] ?? 0, local[2] ?? 0]);
  }
  return null;
}
