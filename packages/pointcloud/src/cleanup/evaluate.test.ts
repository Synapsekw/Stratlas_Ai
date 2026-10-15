import { emptyCleanup, NOISE_CLASS, PointcloudCleanup } from '@aio/schema';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  STATE,
  STATE_NAMES,
  cleanupUniformsOf,
  compileCleanup,
  evaluateAll,
  evaluatePoint,
} from './evaluate';
import { localToWorld, mul4, worldToLocal } from './frame';
import { pointInPolygon, ringOf } from './polygon';

const file = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'schema',
  'test-data',
  'pccleanup-vectors.json',
);
const V = JSON.parse(readFileSync(file, 'utf8')) as {
  points: { id: string; xyz: [number, number, number]; cls: number }[];
  cases: { name: string; recipe: unknown; expect: { state: string[]; cls: number[] } }[];
};
const xyz = V.points.flatMap((p) => p.xyz);
const cls = V.points.map((p) => p.cls);

describe('the shared vectors', () => {
  for (const c of V.cases) {
    it(c.name, () => {
      const r = PointcloudCleanup.parse(c.recipe);
      const out = evaluateAll(compileCleanup(r), xyz, cls);
      expect([...out.state].map((s) => STATE_NAMES[s])).toEqual(c.expect.state);
      expect([...out.cls]).toEqual(c.expect.cls);
    });
  }

  it('gives the same outcome in the local frame of a far origin as in world coordinates', () => {
    const origin = [500000, 3200000, 5] as const;
    // local: x = E - oE, y = H - oH, z = oN - N (data-conventions section 1)
    const local = V.points.flatMap((p) => [
      p.xyz[0] - origin[0],
      p.xyz[2] - origin[2],
      origin[1] - p.xyz[1],
    ]);
    for (const c of V.cases) {
      const r = PointcloudCleanup.parse(c.recipe);
      const out = evaluateAll(compileCleanup(r, { origin }), local, cls);
      expect(
        [...out.state].map((s) => STATE_NAMES[s]),
        c.name,
      ).toEqual(c.expect.state);
      expect([...out.cls], c.name).toEqual(c.expect.cls);
    }
  });
});

describe('frames', () => {
  it('maps world to local and back', () => {
    const o = [500000, 3200000, 5] as const;
    const id = mul4(worldToLocal(o), localToWorld(o));
    expect([...id].map((v) => Math.round(v * 1e9) / 1e9)).toEqual([
      1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
    ]);
    const w2l = worldToLocal(o);
    const [e, n, h] = [500012, 3200034, 9];
    const m = (i: number) => w2l[i] ?? 0;
    const x = m(0) * e + m(4) * n + m(8) * h + m(12);
    const y = m(1) * e + m(5) * n + m(9) * h + m(13);
    const z = m(2) * e + m(6) * n + m(10) * h + m(14);
    expect([x, y, z]).toEqual([12, 4, -34]);
  });
});

describe('polygons', () => {
  it('uses the even-odd rule', () => {
    const ring = ringOf([
      [0, 0],
      [4, 0],
      [4, 4],
      [0, 4],
    ]);
    expect(pointInPolygon(ring, 2, 2)).toBe(true);
    expect(pointInPolygon(ring, 5, 2)).toBe(false);
    // a bow tie: inside its left lobe, outside the gap under the crossing
    const bow = ringOf([
      [0, 0],
      [4, 4],
      [4, 0],
      [0, 4],
    ]);
    expect(pointInPolygon(bow, 1, 2)).toBe(true);
    expect(pointInPolygon(bow, 2, 1)).toBe(false);
  });
});

describe('points and uniforms', () => {
  it('drops a point under the lowest height in the local frame', () => {
    const r = { ...emptyCleanup('a'), height: { min: 5 } };
    const c = compileCleanup(r, { origin: [0, 0, 2] });
    // local y 2 is world height 4: under 5
    expect(evaluatePoint(c, 0, 2, 0, 1).state).toBe(4);
    expect(evaluatePoint(c, 0, 4, 0, 1).state).toBe(0);
  });

  it('starts from the noise copy class, so hiding class 7 hides the marked noise', () => {
    const r = PointcloudCleanup.parse({
      ...emptyCleanup('a'),
      hiddenClasses: [NOISE_CLASS],
      noise: {
        path: 'edits/pointcloud/a.noise-run1.copc.laz',
        params: { outlier: { meanK: 8, multiplier: 2 } },
        marked: 1,
        total: 2,
        runId: 'run1',
      },
    });
    const c = compileCleanup(r);
    // the caller reads classes from the noise copy: the marked point is 7 there, the other kept
    const original = [2, 2];
    const fromCopy = [NOISE_CLASS, 2];
    const out = evaluateAll(c, [0, 0, 0, 1, 1, 1], fromCopy);
    expect([...out.state]).toEqual([STATE.classHidden, STATE.kept]);
    expect([...out.cls]).toEqual([NOISE_CLASS, 2]);
    // the same recipe on the original classes hides nothing: the copy's class is what counts
    expect([...evaluateAll(c, [0, 0, 0, 1, 1, 1], original).state]).toEqual([
      STATE.kept,
      STATE.kept,
    ]);
  });

  it('gives shader uniforms without a box and with one', () => {
    expect(cleanupUniformsOf(null)).toEqual({
      boxInv: null,
      keepInside: true,
      zMin: -1e30,
      zMax: 1e30,
    });
    const r = {
      ...emptyCleanup('a'),
      clipBox: {
        center: [10, 20, 3] as [number, number, number],
        size: [2, 4, 6] as [number, number, number],
        yaw: 0,
        keep: 'outside' as const,
      },
      height: { max: 8 },
    };
    const u = cleanupUniformsOf(compileCleanup(r, { origin: [10, 20, 0] }));
    expect(u.keepInside).toBe(false);
    expect(u.zMax).toBe(8);
    expect(u.boxInv).toHaveLength(16);
    const b = u.boxInv ?? [];
    // rounded to 1e-9 so the rows compare exactly
    const unit = (x: number, y: number, z: number) =>
      [0, 1, 2].map(
        (r) =>
          Math.round(
            ((b[r] ?? 0) * x + (b[4 + r] ?? 0) * y + (b[8 + r] ?? 0) * z + (b[12 + r] ?? 0)) * 1e9,
          ) / 1e9 || 0,
      );
    // the box centre (local 0, 3, 0) maps to the unit box centre on all three rows
    expect(unit(0, 3, 0)).toEqual([0, 0, 0]);
    // world (11, 20, 3) is local (1, 3, 0): half the east size, u = 0.5
    expect(unit(1, 3, 0)).toEqual([0.5, 0, 0]);
    // world (10, 22, 3) is local (0, 3, -2): half the north size, v = 0.5
    expect(unit(0, 3, -2)).toEqual([0, 0.5, 0]);
    // world (10, 20, 6) is local (0, 6, 0): half the height, w = 0.5
    expect(unit(0, 6, 0)).toEqual([0, 0, 0.5]);
  });
});
