import { describe, expect, it } from 'vitest';
import { planArea, sampleProfile, spatialArea, type HeightSampler, type Pt } from './geometry';
import {
  bermCheck,
  components,
  elevation,
  elevationDifference,
  gradeStyles,
  lineMetrics,
  polygonAreas,
  vertexTable,
} from './measure';
import { measurementReadout } from './readout';

// Analytic surfaces at the fictional site (UTM 39N-sized coordinates: large eastings and
// northings, so the maths is checked where float64 cancellation would show).
const E0 = 512_340;
const N0 = 2_710_250;

/** A plane z = z0 + gx (E - E0) + gy (N - N0). */
const plane = (z0: number, gx: number, gy: number): HeightSampler => ({
  heightAt: (e, n) => z0 + gx * (e - E0) + gy * (n - N0),
});

/** A tent along E: 0 at E0 and E0 + 2a, peak h at E0 + a. */
const tent = (a: number, h: number): HeightSampler => ({
  heightAt: (e) => {
    const x = e - E0;
    return x < 0 || x > 2 * a ? 0 : h * (1 - Math.abs(x - a) / a);
  },
});

/**
 * A trapezoidal berm across E: ground at g, toes at E0 + 10 and E0 + 10 + base, crest h above
 * ground and `crest` wide, centred.
 */
const berm = (g: number, h: number, base: number, crest: number): HeightSampler => {
  const t0 = 10;
  const run = (base - crest) / 2;
  return {
    heightAt: (e) => {
      const x = e - E0 - t0;
      if (x <= 0 || x >= base) return g;
      if (x < run) return g + (h * x) / run;
      if (x > base - run) return g + (h * (base - x)) / run;
      return g + h;
    },
  };
};

const at = (dx: number, dy: number, z = 0): Pt => [E0 + dx, N0 + dy, z];

describe('point tools', () => {
  it('reads N, E and Z of a point', () => {
    expect(elevation(at(1.5, 2.5, 7.25))).toEqual({ e: E0 + 1.5, n: N0 + 2.5, z: 7.25 });
  });

  it('gives the height above a surface, and null over a hole', () => {
    const s = plane(100, 0.1, 0);
    const d = elevationDifference(at(10, 0, 102.5), s);
    expect(d.surfaceZ).toBeCloseTo(101, 12);
    expect(d.dz).toBeCloseTo(1.5, 12);
    expect(elevationDifference(at(0, 0, 1), { heightAt: () => null })).toEqual({
      surfaceZ: null,
      dz: null,
    });
  });
});

describe('line tools', () => {
  it('gives horizontal, slope and terrain lengths of a known profile', () => {
    // a 3-4-5 rise: 30 m east, 40 m up the other way would be steep; use a tent 2 x 30 m wide, 40 m high
    const a = 30;
    const h = 40;
    const line = [at(0, 0, 0), at(2 * a, 0, 0)];
    const m = lineMetrics(line, tent(a, h), 0.5);
    expect(m.horizontalM).toBeCloseTo(60, 12);
    expect(m.slopeM).toBeCloseTo(60, 12);
    // exactly two 50 m flanks (3-4-5)
    expect(m.terrainM).toBeCloseTo(100, 9);
    expect(m.terrainCoverage).toBeCloseTo(1, 12);
  });

  it('follows a smooth profile to the analytic arc length', () => {
    // z = A sin(k x) over one period: arc length by fine quadrature
    const A = 2;
    const L = 40;
    const k = (2 * Math.PI) / L;
    const s: HeightSampler = { heightAt: (e) => A * Math.sin(k * (e - E0)) };
    let truth = 0;
    const N = 200_000;
    for (let i = 0; i < N; i++) {
      const x = ((i + 0.5) * L) / N;
      truth += Math.hypot(1, A * k * Math.cos(k * x)) * (L / N);
    }
    const m = lineMetrics([at(0, 0), at(L, 0)], s, 0.05);
    expect(Math.abs((m.terrainM ?? 0) - truth)).toBeLessThan(0.001);
  });

  it('reports partial coverage over a hole and no terrain length without data', () => {
    const holed: HeightSampler = { heightAt: (e) => (e - E0 > 5 ? null : 0) };
    const m = lineMetrics([at(0, 0), at(10, 0)], holed, 1);
    expect(m.terrainCoverage).toBeCloseTo(0.5, 12);
    expect(m.terrainM).toBeCloseTo(5, 12);
    expect(lineMetrics([at(0, 0), at(10, 0)], { heightAt: () => null }).terrainM).toBeNull();
  });

  it('gives the exact grade of a line on a plane', () => {
    const s = plane(50, 0.03, 0.04); // 5 % grade toward bearing atan2(3, 4)
    const dir: [number, number] = [0.6, 0.8];
    const pts = [0, 25, 70].map((t) => {
      const e = E0 + dir[0] * t;
      const n = N0 + dir[1] * t;
      return [e, n, s.heightAt(e, n) ?? 0] as Pt;
    });
    const m = lineMetrics(pts);
    expect(m.grade).toBeCloseTo(0.05, 12);
    expect(m.maxGrade).toBeCloseTo(0.05, 12);
    const g = gradeStyles(m.grade);
    expect(g.percent).toBeCloseTo(5, 10);
    expect(g.degrees).toBeCloseTo((Math.atan(0.05) * 180) / Math.PI, 12);
    expect(g.n).toBeCloseTo(20, 9);
    const c = components(pts);
    expect(c.horizontalM).toBeCloseTo(70, 9);
    expect(c.verticalM).toBeCloseTo(3.5, 9);
    expect(c.slopeM).toBeCloseTo(Math.hypot(70, 3.5), 9);
    expect(c.bearingDeg).toBeCloseTo((Math.atan2(0.6, 0.8) * 180) / Math.PI, 9);
  });

  it('lists vertex differences per segment with chainage and bearings', () => {
    const rows = vertexTable([at(0, 0, 10), at(0, 30, 13), at(40, 30, 11)]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ from: 0, to: 1, dE: 0, dN: 30, dZ: 3, bearingDeg: 0 });
    expect(rows[0]?.grade).toBeCloseTo(0.1, 12);
    expect(rows[1]?.bearingDeg).toBeCloseTo(90, 12);
    expect(rows[1]?.dZ).toBeCloseTo(-2, 12);
    expect(rows[1]?.chainageM).toBeCloseTo(70, 12);
    expect(rows[1]?.slopeM).toBeCloseTo(Math.hypot(40, 2), 12);
  });
});

describe('berm check', () => {
  it('finds crest and toe heights and widths within 1 cm on a synthetic berm', () => {
    const g = 312.4;
    const s = berm(g, 1.8, 7.2, 1.6);
    const line = [at(0, 5), at(27.2, 5)];
    for (const step of [0.05, 0.1, 0.25]) {
      const b = bermCheck(sampleProfile(line, s, step));
      expect(b).not.toBeNull();
      if (!b) continue;
      expect(Math.abs(b.crestZ - (g + 1.8))).toBeLessThan(0.01);
      expect(Math.abs(b.crestWidthM - 1.6)).toBeLessThan(0.01);
      expect(Math.abs(b.baseWidthM - 7.2)).toBeLessThan(0.01);
      expect(Math.abs(b.left.heightM - 1.8)).toBeLessThan(0.01);
      expect(Math.abs(b.right.heightM - 1.8)).toBeLessThan(0.01);
      expect(Math.abs(b.left.toeChainageM - 10)).toBeLessThan(0.01);
      expect(Math.abs(b.right.toeChainageM - 17.2)).toBeLessThan(0.01);
      expect(b.left.slope).toBeCloseTo(1.8 / 2.8, 6);
    }
  });

  it('answers null for flat ground', () => {
    const flat = sampleProfile([at(0, 0), at(20, 0)], plane(5, 0, 0), 0.5);
    expect(bermCheck(flat)).toBeNull();
  });
});

describe('polygon tools', () => {
  const square = [at(0, 0), at(30, 0), at(30, 20), at(0, 20)];

  it('gives the plan area and perimeter of a rectangle exactly at UTM coordinates', () => {
    const a = polygonAreas(square);
    expect(a.horizontalM2).toBe(600);
    expect(a.perimeterM).toBe(100);
    expect(a.terrainM2).toBeNull();
  });

  it('gives the terrain area of a plane as horizontal times the secant of its slope', () => {
    const gx = 0.3;
    const gy = -0.4;
    const s = plane(80, gx, gy);
    const factor = Math.hypot(1, gx, gy);
    const tri = [at(3, 1), at(41.5, 7.25), at(17, 33)];
    for (const ring of [square, tri]) {
      const a = polygonAreas(ring, s, 0.7);
      expect((a.terrainM2 ?? 0) / a.horizontalM2).toBeCloseTo(factor, 9);
      expect(a.uncoveredM2).toBe(0);
    }
  });

  it('gives the slope area of a tilted polygon through its vertices', () => {
    const tilted = square.map((p) => [p[0], p[1], 0.5 * (p[0] - E0)] as Pt);
    expect(polygonAreas(tilted).slopeM2).toBeCloseTo(600 * Math.hypot(1, 0.5), 9);
    expect(spatialArea(tilted)).toBeCloseTo(600 * Math.hypot(1, 0.5), 9);
    expect(planArea(tilted)).toBe(600);
  });

  it('reports the plan area a surface does not cover', () => {
    const half: HeightSampler = { heightAt: (e) => (e - E0 <= 15 ? 0 : null) };
    const a = polygonAreas(square, half, 1);
    expect(a.uncoveredM2).toBeCloseTo(300, 9);
    expect(a.terrainM2).toBeCloseTo(300, 9);
  });
});

describe('readouts', () => {
  it('shows the template rows in the template order', () => {
    const rows = measurementReadout(
      { tool: 'distance', points: [at(0, 0, 0), at(30, 40, 0)] },
      {},
      ['slope-length', 'horizontal', 'nope'],
    );
    expect(rows.map((r) => r.key)).toEqual(['slope-length', 'horizontal']);
    expect(rows[1]?.value).toBe(50);
  });

  it('says a volume is not computed yet rather than computing one', () => {
    const rows = measurementReadout({
      tool: 'volume',
      points: [at(0, 0), at(10, 0), at(10, 10)],
      results: [],
    });
    expect(rows.find((r) => r.key === 'cut')).toMatchObject({
      value: null,
      note: 'Not computed yet',
    });
    expect(rows.find((r) => r.key === 'area')?.value).toBe(50);
  });
});
