import { Georef, type Mat4, type Vec3 } from '@aio/schema';
import proj4 from 'proj4';
import { describe, expect, it } from 'vitest';
import { crsDefinition, gridConvergenceDeg, toWgs84 } from './index';
import {
  georefToLayerTransform,
  layerTransformToGeoref,
  transformPoint,
  worldOfModelPoint,
  type ProjectGeo,
} from './placement';

const rad = Math.PI / 180;

/**
 * Model (x east, y up, z south) to E, N, H: scaled, turned clockwise (seen from above) by
 * `headingDeg` so the model's north (-z) points to grid bearing `headingDeg`, then moved to the
 * anchor. Column-major. Written out here so the tests do not lean on the code under test.
 */
function enhMatrix(anchor: Vec3, headingDeg: number, s: number): Mat4 {
  const c = Math.cos(headingDeg * rad);
  const n = Math.sin(headingDeg * rad);
  // E = aE + s(x c - z n), N = aN + s(-x n - z c), H = aH + s y
  return [
    s * c,
    -s * n,
    0,
    0,
    0,
    0,
    s,
    0,
    -s * n,
    -s * c,
    0,
    0,
    anchor[0],
    anchor[1],
    anchor[2],
    1,
  ];
}

const g = (o: Partial<Georef> = {}): Georef => ({
  schema: 'aio.georef/1',
  crs: { epsg: 32633 },
  anchor: [400010, 5600020, 15],
  axes: 'x-east,y-up,z-south',
  units: 'm',
  modelToCrs: enhMatrix([400010, 5600020, 15], 0, 1),
  heading: { deg: 0, status: 'measured' },
  scale: { factor: 1, status: 'measured' },
  horizontal: { status: 'from-source' },
  vertical: { datum: 'unknown', status: 'unknown' },
  provenance: { by: 'engineer' },
  ...o,
});
const A: ProjectGeo = { crs: { epsg: 32633 }, origin: [400000, 5600000, 10] };
const B: ProjectGeo = { crs: { epsg: 32633 }, origin: [399500, 5600700, 0] };
const probe: Vec3[] = [
  [0, 0, 0],
  [3, 50, -2],
  [-4, 120, 6],
];

function expectClose(a: Vec3, b: Vec3, tol: number): void {
  for (let i = 0; i < 3; i++) expect(Math.abs((a[i] ?? NaN) - (b[i] ?? NaN))).toBeLessThan(tol);
}
function placed(r: ReturnType<typeof georefToLayerTransform>) {
  if (r.kind !== 'placed') throw new Error(`not placed: ${r.reason}`);
  return r;
}
function must<T>(v: T | undefined): T {
  if (v === undefined) throw new Error('missing');
  return v;
}
/** Grid bearing in degrees, clockwise from grid north, of the step from p to q (E, N). */
const bearing = (p: Vec3, q: Vec3) => (Math.atan2(q[0] - p[0], q[1] - p[1]) / rad + 360) % 360;
const dist = (p: Vec3, q: Vec3) => Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]);
const angleDiff = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);
const lonLatOf = (r: Georef): [number, number] => {
  if (!('epsg' in r.crs)) throw new Error('wkt');
  const ll = toWgs84(r.anchor, r.crs.epsg);
  return [ll[0], ll[1]];
};
/** An independent proj4 pipeline, not the helper under test. */
const viaProj4 = (p: Vec3, from: number, to: number): Vec3 => {
  const [e, n] = proj4(crsDefinition(from), crsDefinition(to)).forward([p[0], p[1]]);
  return [e, n, p[2]];
};

describe('transformPoint', () => {
  it('matches a direct proj4 conversion and passes height through', () => {
    const p: Vec3 = [400010, 5600020, 15];
    const q = transformPoint(p, 32633, 32634);
    expectClose(q, viaProj4(p, 32633, 32634), 0.001);
    expect(q[2]).toBe(15);
    expectClose(transformPoint(q, 32634, 32633), p, 0.001);
  });
  it('is the identity within one CRS', () => {
    expect(transformPoint([1.5, 2.5, 3.5], 32633, 32633)).toEqual([1.5, 2.5, 3.5]);
  });
});

describe('georefToLayerTransform', () => {
  it('same world position from two projects with different origins (1 mm)', () => {
    const ra = placed(georefToLayerTransform(g(), A));
    const rb = placed(georefToLayerTransform(g(), B));
    for (const p of probe)
      expectClose(
        worldOfModelPoint(ra.transform, A, p),
        worldOfModelPoint(rb.transform, B, p),
        0.001,
      );
    // and that position is the georef's own: model origin at the anchor
    expectClose(worldOfModelPoint(ra.transform, A, [0, 0, 0]), [400010, 5600020, 15], 0.001);
    // local translation is anchor minus origin in x east, y up, z south
    expectClose(
      [ra.transform[12] ?? 0, ra.transform[13] ?? 0, ra.transform[14] ?? 0],
      [10, 5, -20],
      1e-9,
    );
  });

  it('rotated asset keeps its heading within 0.01 degree', () => {
    const r = g({
      modelToCrs: enhMatrix([400010, 5600020, 15], 37.5, 1),
      heading: { deg: 37.5, status: 'measured' },
    });
    const ra = placed(georefToLayerTransform(r, A));
    const rb = placed(georefToLayerTransform(r, B));
    const bearingIn = (t: Mat4, p: ProjectGeo) =>
      bearing(worldOfModelPoint(t, p, [0, 0, 0]), worldOfModelPoint(t, p, [100, 0, 0]));
    // model +X sits 90 degrees clockwise of model north
    expect(angleDiff(bearingIn(ra.transform, A), 127.5)).toBeLessThan(0.01);
    expect(angleDiff(bearingIn(rb.transform, B), 127.5)).toBeLessThan(0.01);
    for (const p of probe)
      expectClose(
        worldOfModelPoint(ra.transform, A, p),
        worldOfModelPoint(rb.transform, B, p),
        0.001,
      );
    expect(ra.headingDeltaDeg).toBe(0);
  });

  it('cross-CRS UTM 33N to UTM 34N lands at the same lon/lat (1 mm after round trip) and rotates by the convergence difference', () => {
    const C: ProjectGeo = {
      crs: { epsg: 32634 },
      origin: transformPoint([400000, 5600000, 0], 32633, 32634),
    };
    const r = placed(georefToLayerTransform(g(), C));
    const w = worldOfModelPoint(r.transform, C, [0, 0, 0]);
    expectClose(viaProj4(w, 32634, 32633), [400010, 5600020, 15], 0.001);
    const [lon, lat] = lonLatOf(g());
    const delta = gridConvergenceDeg(lon, lat, 32634) - gridConvergenceDeg(lon, lat, 32633);
    expect(Math.abs(delta)).toBeGreaterThan(1); // the zones really differ here
    expect(Math.abs(r.headingDeltaDeg - delta)).toBeLessThan(0.01);
    // the true direction is kept: model +X, taken back to zone 33N, points where it did there
    const tip = viaProj4(worldOfModelPoint(r.transform, C, [100, 0, 0]), 32634, 32633);
    expect(angleDiff(bearing([400010, 5600020, 15], tip), 90)).toBeLessThan(0.01);
    // height passes through
    expect(Math.abs(w[2] - 15)).toBeLessThan(1e-9);
  });

  it('cross-CRS UTM 33N to Web Mercator places the anchor and notes the scale difference', () => {
    const D: ProjectGeo = {
      crs: { epsg: 3857 },
      origin: transformPoint([400000, 5600000, 0], 32633, 3857),
    };
    const r = placed(georefToLayerTransform(g(), D));
    const w = worldOfModelPoint(r.transform, D, [0, 0, 0]);
    expectClose(viaProj4(w, 3857, 32633), [400010, 5600020, 15], 0.001);
    expect(r.scaleNote).toBeDefined();
    // scale is kept (recorded, not applied): 100 model metres stay 100 project units
    expect(Math.abs(dist(w, worldOfModelPoint(r.transform, D, [100, 0, 0])) - 100)).toBeLessThan(
      1e-6,
    );
  });

  it('unsupported CRS gives placement needed', () => {
    expect(georefToLayerTransform(g({ crs: { wkt: 'LOCAL_CS["x"]' } }), A).kind).toBe('needed');
    expect(georefToLayerTransform(g({ crs: { epsg: 2056 } }), A).kind).toBe('needed');
    expect(georefToLayerTransform(g(), { ...A, crs: { wkt: 'LOCAL_CS["x"]' } }).kind).toBe(
      'needed',
    );
    expect(georefToLayerTransform(g(), { ...A, crs: { epsg: 4326 } }).kind).toBe('needed');
  });

  it('different known vertical datums: horizontal only, height needed', () => {
    const r = georefToLayerTransform(g({ vertical: { datum: 'EGM2008', status: 'from-source' } }), {
      ...A,
      verticalDatum: 'NAVD88',
    });
    expect(r.kind).toBe('needed');
    if (r.kind !== 'needed') return;
    const t = must(r.horizontalOnly);
    // horizontal right, height the anchor H as is
    expectClose(worldOfModelPoint(t, A, [0, 0, 0]), [400010, 5600020, 15], 0.001);
  });

  it('the same known vertical datum places fully', () => {
    const r = georefToLayerTransform(g({ vertical: { datum: 'EGM2008', status: 'from-source' } }), {
      ...A,
      verticalDatum: 'egm2008',
    });
    expect(placed(r).heightNote).toBeUndefined();
  });

  it('unknown datum passes height through unchanged (no MSL assumption)', () => {
    const r = placed(georefToLayerTransform(g(), { ...A, verticalDatum: 'EGM2008' }));
    for (const p of probe)
      expect(Math.abs(worldOfModelPoint(r.transform, A, p)[2] - (15 + p[1]))).toBeLessThan(1e-9);
    expect(r.heightNote).toBeDefined();
  });

  it('scale factor is applied once', () => {
    const r = placed(
      georefToLayerTransform(
        g({
          modelToCrs: enhMatrix([400010, 5600020, 15], 20, 2),
          scale: { factor: 2, status: 'measured' },
        }),
        A,
      ),
    );
    const [p0, p1] = [must(probe[0]), must(probe[1])];
    const model = dist(p0, p1);
    const world = dist(
      worldOfModelPoint(r.transform, A, p0),
      worldOfModelPoint(r.transform, A, p1),
    );
    expect(Math.abs(world / model - 2)).toBeLessThan(1e-6);
  });

  it('recentre keeps world position', () => {
    const r = placed(
      georefToLayerTransform(g({ modelToCrs: enhMatrix([400010, 5600020, 15], 30, 1) }), A),
    );
    // recentre (packages/project builder/recentre.ts): new origin, then T' = translate(d) * T with
    // d = the old origin in the new local frame
    const A2: ProjectGeo = { ...A, origin: [400300, 5599800, 10] };
    const d: Vec3 = [
      A.origin[0] - A2.origin[0],
      A.origin[2] - A2.origin[2],
      -(A.origin[1] - A2.origin[1]),
    ];
    const t2 = [...r.transform];
    t2[12] = (t2[12] ?? 0) + d[0];
    t2[13] = (t2[13] ?? 0) + d[1];
    t2[14] = (t2[14] ?? 0) + d[2];
    for (const p of probe)
      expectClose(worldOfModelPoint(t2, A2, p), worldOfModelPoint(r.transform, A, p), 0.001);
    // and re-placing from the untouched georef in the recentred project gives the same transform
    const again = placed(
      georefToLayerTransform(g({ modelToCrs: enhMatrix([400010, 5600020, 15], 30, 1) }), A2),
    );
    for (let i = 0; i < 16; i++)
      expect(Math.abs((again.transform[i] ?? NaN) - (t2[i] ?? NaN))).toBeLessThan(1e-6);
  });

  it('placing twice does not apply the transform twice', () => {
    const geo = g({ modelToCrs: enhMatrix([400010, 5600020, 15], 30, 1.5) });
    const once = placed(georefToLayerTransform(geo, A));
    const twice = placed(
      georefToLayerTransform(layerTransformToGeoref(once.transform, A, geo, 'engineer'), A),
    );
    for (const p of probe)
      expectClose(
        worldOfModelPoint(twice.transform, A, p),
        worldOfModelPoint(once.transform, A, p),
        0.001,
      );
  });
});

describe('layerTransformToGeoref', () => {
  it('inverts georefToLayerTransform', () => {
    const geo = g({
      modelToCrs: enhMatrix([400010, 5600020, 15], -42, 1.25),
      heading: { deg: -42, status: 'measured' },
      scale: { factor: 1.25, status: 'measured' },
    });
    const r = placed(georefToLayerTransform(geo, B));
    const back = layerTransformToGeoref(r.transform, B, geo, 'engineer');
    expect(Georef.safeParse(back).success).toBe(true);
    for (let i = 0; i < 16; i++)
      expect(Math.abs((back.modelToCrs[i] ?? NaN) - (geo.modelToCrs[i] ?? NaN))).toBeLessThan(1e-6);
    expectClose(back.anchor, [400010, 5600020, 15], 0.001);
    expect(Math.abs(back.heading.deg - -42)).toBeLessThan(0.01);
    expect(Math.abs(back.scale.factor - 1.25)).toBeLessThan(1e-6);
    expect(back.heading.status).toBe('measured');
    expect(back.crs).toEqual({ epsg: 32633 });
  });

  it('Place model records user statuses and the project datum', () => {
    const c = Math.cos(30 * rad);
    const s = Math.sin(30 * rad);
    // local frame rotation about +Y by -30 degrees is a clockwise turn of 30 degrees seen from above
    const t: Mat4 = [c, 0, s, 0, 0, 1, 0, 0, -s, 0, c, 0, 5, 2, -7, 1];
    const back = layerTransformToGeoref(t, { ...A, verticalDatum: 'EGM2008' }, null, 'place-model');
    expect(Georef.safeParse(back).success).toBe(true);
    expectClose(back.anchor, [400005, 5600007, 12], 1e-6);
    expect(Math.abs(back.heading.deg - 30)).toBeLessThan(0.01);
    expect(back.heading.status).toBe('user');
    expect(back.scale).toEqual({ factor: 1, status: 'user' });
    expect(back.horizontal.status).toBe('user');
    expect(back.vertical).toEqual({ datum: 'EGM2008', status: 'user' });
    expect(back.provenance.by).toBe('place-model');
    // and it places back where it was
    const r = placed(georefToLayerTransform(back, A));
    for (const p of probe)
      expectClose(worldOfModelPoint(r.transform, A, p), worldOfModelPoint(t, A, p), 0.001);
  });
});
