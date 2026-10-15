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
    // points off the anchor land on the same ground (projection scale applied across)
    expect(r.scaleNote).toBeDefined();
    for (const p of [
      [20, 0, 0],
      [0, 30, -20],
      [-15, 5, 10],
    ] as Vec3[])
      expectClose(
        viaProj4(worldOfModelPoint(r.transform, C, p), 32634, 32633),
        [400010 + p[0], 5600020 - p[2], 15 + p[1]],
        0.001,
      );
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
    // the projection scale is applied across, so points off the anchor land on the same ground
    for (const p of [
      [20, 0, 0],
      [0, 30, -20],
      [-15, 5, 10],
    ] as Vec3[])
      expectClose(
        viaProj4(worldOfModelPoint(r.transform, D, p), 3857, 32633),
        [400010 + p[0], 5600020 - p[2], 15 + p[1]],
        0.001,
      );
    // heights never scale with a projection
    expect(Math.abs(worldOfModelPoint(r.transform, D, [0, 30, 0])[2] - 45)).toBeLessThan(1e-9);
  });

  it('a zone pair with the same point scale records a projection scale of 1', () => {
    // a southern and a northern zone share the central meridian: identical point scale
    const S: ProjectGeo = {
      crs: { epsg: 32733 },
      origin: transformPoint([400000, 5600000, 0], 32633, 32733),
    };
    const r = placed(georefToLayerTransform(g(), S));
    expect(r.scaleNote).toBeUndefined();
    expect(Math.abs(r.projectionScale - 1)).toBeLessThan(1e-9);
    const w0 = worldOfModelPoint(r.transform, S, [0, 0, 0]);
    expect(Math.abs(dist(w0, worldOfModelPoint(r.transform, S, [100, 0, 0])) - 100)).toBeLessThan(
      1e-6,
    );
  });

  /** Model points 100 m out (and up), turned 30 degrees, compared with proj4 directly. */
  const far: Vec3[] = [
    [100, 0, 0],
    [0, 0, 100],
    [-70, 0, 70],
    [0, 100, 0],
    [100, 30, -100],
  ];
  function worstAt100(anchor: Vec3, to: number) {
    const m = enhMatrix(anchor, 30, 1);
    const geo = g({ anchor, modelToCrs: m, heading: { deg: 30, status: 'user' } });
    const a2 = viaProj4(anchor, 32633, to);
    const P: ProjectGeo = { crs: { epsg: to }, origin: [a2[0] + 1234.5, a2[1] - 777.25, 250] };
    // the farthest probe lies 141.4 m out horizontally
    const r = placed(georefToLayerTransform(geo, P, { extentM: 142 }));
    let worst = 0;
    for (const p of far) {
      const at = m;
      const src: Vec3 = [
        (at[0] ?? 0) * p[0] + (at[4] ?? 0) * p[1] + (at[8] ?? 0) * p[2] + (at[12] ?? 0),
        (at[1] ?? 0) * p[0] + (at[5] ?? 0) * p[1] + (at[9] ?? 0) * p[2] + (at[13] ?? 0),
        (at[2] ?? 0) * p[0] + (at[6] ?? 0) * p[1] + (at[10] ?? 0) * p[2] + (at[14] ?? 0),
      ];
      const truth = viaProj4(src, 32633, to);
      worst = Math.max(worst, dist(worldOfModelPoint(r.transform, P, p), truth));
    }
    return { r, worst };
  }
  const utm33 = (lon: number, lat: number): Vec3 => {
    const [e, n] = proj4(crsDefinition(4326), crsDefinition(32633)).forward([lon, lat]);
    return [e, n, 300];
  };

  it('UTM 33N to 34N is within 1 mm at 100 m, also near the zone edge', () => {
    for (const lon of [13.6, 16, 17, 17.5, 17.99]) {
      const { r, worst } = worstAt100(utm33(lon, 50.5), 32634);
      expect(worst, `lon ${String(lon)}`).toBeLessThan(0.001);
      expect(r.linearErrorM).toBeLessThan(0.001);
      expect(r.approxNote).toBeUndefined();
      // the projection scale is recorded and is that of the change
      expect(r.projectionScale).toBeGreaterThan(0.99);
    }
  });

  it('Web Mercator is approximate, and says so with the worst case for the extent', () => {
    const { r, worst } = worstAt100(utm33(13.6, 50.5), 3857);
    expect(r.approxNote).toMatch(/^Web Mercator placement is approximate away from the anchor/);
    expect(r.linearErrorM).toBeGreaterThan(0.001);
    // the stated worst case covers what proj4 measures (heights do not add error)
    expect(worst).toBeLessThanOrEqual(r.linearErrorM + 1e-6);
    expect(worst).toBeLessThan(0.01);
    expect(Math.abs(r.projectionScale - 1.573)).toBeLessThan(0.01);
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
  it('keeps the model scale apart from the projection scale after a cross-CRS placement', () => {
    const geo = g({
      modelToCrs: enhMatrix([400010, 5600020, 15], 20, 1.25),
      scale: { factor: 1.25, status: 'measured' },
    });
    const C: ProjectGeo = {
      crs: { epsg: 32634 },
      origin: transformPoint([400000, 5600000, 0], 32633, 32634),
    };
    const r = placed(georefToLayerTransform(geo, C));
    expect(Math.abs(r.projectionScale - 1)).toBeGreaterThan(1e-3);
    const back = layerTransformToGeoref(r.transform, C, geo, 'engineer');
    expect(back.crs).toEqual({ epsg: 32634 });
    expect(Math.abs(back.scale.factor - 1.25)).toBeLessThan(1e-6);
    // and the record in the new CRS still places the model where it was
    const again = placed(georefToLayerTransform(back, C));
    for (const p of probe)
      expectClose(
        worldOfModelPoint(again.transform, C, p),
        worldOfModelPoint(r.transform, C, p),
        0.001,
      );
  });

  it('pivots on the model origin, not on an anchor elsewhere on the model', () => {
    // the anchor names the top of the model; geometry pivots on the origin all the same
    const geo = g({ anchor: [400010, 5600020, 115] });
    const C: ProjectGeo = {
      crs: { epsg: 32634 },
      origin: transformPoint([400000, 5600000, 0], 32633, 32634),
    };
    const r = placed(georefToLayerTransform(geo, C));
    expectClose(
      viaProj4(worldOfModelPoint(r.transform, C, [0, 0, 0]), 32634, 32633),
      [400010, 5600020, 15],
      0.001,
    );
  });

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
