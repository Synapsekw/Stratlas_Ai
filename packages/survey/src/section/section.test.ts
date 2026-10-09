/**
 * Cross-section quality targets of the M11 plan: pins and grades on planes exact (1e-9), a cone's
 * section within 1 mm of its analytic profile at pins (and a pin equal to the bilinear sample),
 * cut and fill areas exact for the polylines, the exaggeration ratio, alignment stations.
 */
import type { Alignment } from '@aio/schema';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { stationOffset } from '../designs/alignment';
import type { Resolve, ResolvedSurface } from '../engine/compare';
import { ArraySurface, bilinear } from '../engine/tiles';
import type { TinFile } from '../engine/tin';
import {
  defaultStep,
  gradeOf,
  lineLength,
  MAX_STATIONS,
  pinAt,
  resolveSection,
  sampleSection,
  samplerOf,
  stations,
  type SectionSurface,
} from './profile';
import { chartScale, clampExaggeration, cutFill, niceStep } from './shade';
import { alignmentSections, corridorRing, cutawayPlane } from './stations';

const E0 = 302000;
const N0 = 2574000;

function grid(cell: number, n: number, fn: (x: number, y: number) => number): ResolvedSurface {
  const h = new Float64Array(n * n);
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) h[j * n + i] = fn((i + 0.5) * cell, (j + 0.5) * cell);
  return {
    kind: 'grid',
    name: 'g',
    fingerprint: 'fp',
    grid: new ArraySurface(E0, N0, cell, n, n, h),
  };
}

function surface(r: ResolvedSurface, key = 'survey:s', label = 'S'): SectionSurface {
  const s = samplerOf(r);
  return {
    key,
    label,
    ref: { kind: 'survey', surface: 's' },
    ...(s.cellM !== undefined ? { cellM: s.cellM } : {}),
    sample: s.sample,
  };
}

/** A TIN of two triangles over a square, heights from a plane. */
function planeTin(fn: (x: number, y: number) => number, size: number): TinFile {
  const corners: [number, number][] = [
    [0, 0],
    [size, 0],
    [size, size],
    [0, size],
  ];
  return {
    header: {},
    vertices: Float64Array.from(corners.flatMap(([x, y]) => [E0 + x, N0 + y, fn(x, y)])),
    triangles: Uint32Array.from([0, 1, 2, 0, 2, 3]),
  };
}

const plane = (x: number, y: number) => 100 + 0.3 * x - 0.2 * y;

describe('stations', () => {
  it('holds every vertex, at most a step apart, chainage the distance along the line', () => {
    const line: [number, number][] = [
      [E0, N0],
      [E0 + 3, N0 + 4],
      [E0 + 3, N0 + 4],
      [E0 + 3, N0 + 10.1],
    ];
    const st = stations(line, 0.7);
    expect(st.length).toBeCloseTo(11.1, 9);
    expect(st.chainage[0]).toBe(0);
    expect(st.chainage[st.chainage.length - 1]).toBeCloseTo(11.1, 9);
    expect(Array.from(st.chainage)).toContain(5);
    for (let k = 1; k < st.chainage.length; k++) {
      const d = (st.chainage[k] ?? 0) - (st.chainage[k - 1] ?? 0);
      expect(d).toBeGreaterThan(0);
      expect(d).toBeLessThanOrEqual(0.7 + 1e-12);
      const de = (st.e[k] ?? 0) - (st.e[k - 1] ?? 0);
      const dn = (st.n[k] ?? 0) - (st.n[k - 1] ?? 0);
      expect(Math.hypot(de, dn)).toBeCloseTo(d, 9);
    }
  });

  it('widens the step so a section never has more than MAX_STATIONS', () => {
    const st = stations(
      [
        [0, 0],
        [1e6, 0],
      ],
      0.01,
    );
    expect(st.chainage.length).toBeLessThanOrEqual(MAX_STATIONS);
  });

  it('defaults to half the finest grid cell, 0.5 m with TINs only', () => {
    expect(defaultStep([{ cellM: 0.5 }, { cellM: 0.2 }, {}])).toBe(0.1);
    expect(defaultStep([{}])).toBe(0.5);
  });
});

describe('pins and grades on planes (exact, 1e-9)', () => {
  const line: [number, number][] = [
    [E0 + 2.3, N0 + 3.1],
    [E0 + 17.9, N0 + 12.4],
    [E0 + 6.2, N0 + 18.7],
  ];

  it('a grid plane: profile, pin elevations and grades', async () => {
    const s = surface(grid(0.5, 44, plane));
    const sec = await sampleSection({ line }, [s]);
    expect(sec.step).toBe(0.25);
    const prof = sec.profiles[0];
    if (!prof) throw new Error('no profile');
    prof.z.forEach((z, k) => {
      expect(z).not.toBeNull();
      expect(Math.abs((z ?? 0) - plane((sec.e[k] ?? 0) - E0, (sec.n[k] ?? 0) - N0))).toBeLessThan(
        1e-9,
      );
    });
    const len = lineLength(line);
    const seg1 = Math.hypot(15.6, 9.3);
    for (const c of [1.3, 7.77, seg1 - 2, seg1 + 3.3, len - 1]) {
      const pin = await pinAt(line, c, [s]);
      const v = pin.values[0];
      expect(Math.abs((v?.z ?? 0) - plane(pin.e - E0, pin.n - N0))).toBeLessThan(1e-9);
      const [ue, un] =
        c < seg1 ? [15.6 / seg1, 9.3 / seg1] : [-11.7, 6.3].map((x) => x / Math.hypot(11.7, 6.3));
      const g = 0.3 * (ue ?? 0) - 0.2 * (un ?? 0);
      expect(Math.abs((v?.grade?.ratio ?? 0) - g)).toBeLessThan(1e-9);
      expect(v?.grade?.percent).toBeCloseTo(100 * g, 7);
      expect(v?.grade?.degrees).toBeCloseTo((Math.atan(g) * 180) / Math.PI, 7);
      expect(v?.grade?.oneIn).toBeCloseTo(1 / Math.abs(g), 6);
    }
  });

  it('a design TIN plane with its offset: pins, deltas to the survey, null outside', async () => {
    const tin: ResolvedSurface = {
      kind: 'tin',
      name: 'Pad, top',
      fingerprint: 'fp-t',
      tin: planeTin(plane, 22),
      offsetM: -0.3,
    };
    const resolve: Resolve = (ref) =>
      Promise.resolve(ref.kind === 'design' ? tin : grid(0.5, 44, plane));
    const { surfaces, missing } = await resolveSection(
      [
        { kind: 'survey', surface: 'a' },
        { kind: 'design', design: 'pad', layer: 'top' },
      ],
      resolve,
    );
    expect(missing).toEqual([]);
    expect(surfaces.map((s) => s.label)).toEqual(['g', 'Pad, top (offset -0.3 m)']);
    const pin = await pinAt(line, 5, surfaces);
    const [sv, dv] = pin.values;
    expect(Math.abs((dv?.z ?? 0) - (plane(pin.e - E0, pin.n - N0) - 0.3))).toBeLessThan(1e-9);
    expect(Math.abs((dv?.delta ?? 0) + 0.3)).toBeLessThan(1e-9);
    expect(sv?.delta).toBe(0);
    expect(Math.abs((dv?.grade?.ratio ?? 0) - (sv?.grade?.ratio ?? 1))).toBeLessThan(1e-9);
    // past the TIN (22 m square) the design has no data
    const far = await pinAt(
      [
        [E0 + 1, N0 + 1],
        [E0 + 30, N0 + 1],
      ],
      25,
      surfaces,
    );
    expect(far.values[1]?.z).toBeNull();
    expect(far.values[1]?.delta).toBeNull();
    expect(far.values[1]?.grade).toBeNull();
  });

  it('a surface that cannot be resolved is reported, not sampled', async () => {
    const resolve: Resolve = () => Promise.reject(new Error('The surface "x" is not prepared.'));
    const r = await resolveSection([{ kind: 'survey', surface: 'x' }], resolve);
    expect(r.surfaces).toEqual([]);
    expect(r.missing[0]?.reason).toContain('not prepared');
  });

  it('gradeOf: flat, uphill and downhill', () => {
    expect(gradeOf(0, 5).oneIn).toBe(Infinity);
    const g = gradeOf(-1, Math.sqrt(3));
    expect(g.degrees).toBeCloseTo(-30, 12);
    expect(g.percent).toBeCloseTo(-57.735026919, 8);
    expect(g.oneIn).toBeCloseTo(Math.sqrt(3), 12);
  });
});

describe('a cone section (within 1 mm of the analytic profile at pins)', () => {
  const R = 10;
  const H = 5;
  const cone = (x: number, y: number) =>
    100 + Math.max(0, H * (1 - Math.hypot(x - 15, y - 15) / R));
  const r = grid(0.1, 300, cone);
  const s = surface(r);
  const line: [number, number][] = [
    [E0 + 2, N0 + 15.02],
    [E0 + 28, N0 + 15.02],
  ];

  it('pins match the cone and equal the bilinear sample', async () => {
    if (r.kind !== 'grid') throw new Error('grid');
    for (const c of [0.5, 2, 4.5, 7.3, 11.9, 14.1, 18.25, 21, 24.4, 25.5]) {
      const pin = await pinAt(line, c, [s]);
      const z = pin.values[0]?.z ?? NaN;
      const truth = cone(pin.e - E0, pin.n - N0);
      expect(Math.abs(z - truth), `chainage ${String(c)}`).toBeLessThan(1e-3);
      const direct = await bilinear(
        r.grid,
        Float64Array.of(pin.e),
        Float64Array.of(pin.n),
        -r.grid.originE,
        -r.grid.originN,
      );
      expect(Math.abs(z - (direct[0] ?? NaN))).toBeLessThan(1e-12);
      // the grade on the cone's flanks is +-H/R, flat outside it
      const g = pin.values[0]?.grade?.ratio ?? NaN;
      const rr = Math.abs(c + 2 - 15);
      if (rr > 1 && rr < R - 1) expect(Math.abs(Math.abs(g) - H / R)).toBeLessThan(2e-3);
      if (rr > R + 1) expect(Math.abs(g)).toBeLessThan(1e-9);
    }
  });

  it('the profile matches the cone at every station away from the apex', async () => {
    const sec = await sampleSection({ line, stepM: 0.2 }, [s]);
    const prof = sec.profiles[0];
    if (!prof) throw new Error('no profile');
    prof.z.forEach((z, k) => {
      const x = (sec.e[k] ?? 0) - E0;
      // the apex and the toe are kinks the grid rounds off
      const rr = Math.hypot(x - 15, (sec.n[k] ?? 0) - N0 - 15);
      if (rr < 1 || Math.abs(rr - R) < 0.2) return;
      expect(Math.abs((z ?? 0) - cone(x, (sec.n[k] ?? 0) - N0))).toBeLessThan(1e-3);
    });
  });

  it('is null where the surface has no data', async () => {
    const sec = await sampleSection(
      {
        line: [
          [E0 - 5, N0 + 10],
          [E0 + 5, N0 + 10],
        ],
        stepM: 1,
      },
      [s],
    );
    const z = sec.profiles[0]?.z ?? [];
    expect(z[0]).toBeNull();
    expect(z[z.length - 1]).not.toBeNull();
  });
});

describe('cut and fill between two lines', () => {
  it('splits at the crossing; areas exact for the polylines', () => {
    const ch = [0, 3, 6, 9, 10];
    const from = ch.map(() => 0);
    const to = ch.map((c) => c - 5);
    const s = cutFill(ch, from, to);
    expect(s.cutM2).toBeCloseTo(12.5, 12);
    expect(s.fillM2).toBeCloseTo(12.5, 12);
    expect(s.pieces.map((p) => p.kind)).toEqual(['cut', 'fill']);
    expect(s.pieces[0]?.points[0]).toEqual([0, -5]);
    const total = s.pieces.reduce((a, p) => a + p.areaM2, 0);
    expect(total).toBeCloseTo(25, 12);
  });

  it('breaks the shading where a line has no data', () => {
    const s = cutFill([0, 1, 2, 3], [0, 0, 0, 0], [1, 1, null, 1]);
    expect(s.fillM2).toBe(1);
    expect(s.pieces).toHaveLength(1);
  });
});

describe('vertical exaggeration', () => {
  it('keeps 1:1 to 1:20 and the ratio of the scales', () => {
    expect(clampExaggeration(0.2)).toBe(1);
    expect(clampExaggeration(50)).toBe(20);
    for (const ex of [1, 4, 20]) {
      const sc = chartScale({
        width: 800,
        height: 200,
        chainage: [0, 100],
        z: [95, 105],
        exaggeration: ex,
      });
      expect(sc.sz / sc.sx).toBeCloseTo(ex, 12);
      expect(sc.y(105)).toBeGreaterThanOrEqual(-1e-9);
      expect(sc.y(95)).toBeLessThanOrEqual(200 + 1e-9);
      expect(sc.x(0)).toBeGreaterThanOrEqual(-1e-9);
      expect(sc.x(100)).toBeLessThanOrEqual(800 + 1e-9);
    }
    expect(niceStep(100)).toBe(20);
    expect(niceStep(7)).toBe(2);
  });
});

describe('sections at alignment stations', () => {
  const FIX = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'designs', '__fixtures__');
  const al = (
    JSON.parse(readFileSync(join(FIX, 'alignment-clothoid.json'), 'utf8')) as {
      alignment: Alignment;
    }
  ).alignment;

  it('cross the alignment at each station, left and right offsets as asked', () => {
    const secs = alignmentSections(al, { intervalM: 25, leftM: 12, rightM: 8 });
    expect(secs.length).toBeGreaterThan(5);
    for (const s of secs) {
      expect(Math.abs(s.station / 25 - Math.round(s.station / 25))).toBeLessThan(1e-9);
      const [l, r] = s.line;
      expect(Math.hypot(r[0] - l[0], r[1] - l[1])).toBeCloseTo(20, 9);
      const so = stationOffset(al, r[0], r[1]);
      const sl = stationOffset(al, l[0], l[1]);
      expect(so?.offset).toBeCloseTo(8, 6);
      expect(sl?.offset).toBeCloseTo(-12, 6);
      expect(so?.distance).toBeCloseTo(s.distance, 6);
    }
    const some = alignmentSections(al, {
      intervalM: 25,
      leftM: 5,
      rightM: 5,
      from: 1050,
      to: 1100,
    });
    expect(some.map((s) => s.station)).toEqual([1050, 1075, 1100]);
  });
});

describe('map band and cutaway', () => {
  it('a corridor band either side of a straight line', () => {
    const ring = corridorRing(
      [
        [0, 0],
        [10, 0],
      ],
      2,
    );
    expect(ring).toEqual([
      [0, 2],
      [10, 2],
      [10, -2],
      [0, -2],
    ]);
  });

  it('the cutaway plane holds the line and removes its right-hand side', () => {
    // a line due east 5 m north of the stage centre: the right-hand side is south
    const p = cutawayPlane(
      [
        [500, 1005],
        [520, 1005],
      ],
      [500, 1000],
      { x: 0, z: 0 },
    );
    expect(p?.bearingDeg).toBeCloseTo(180, 9);
    // the stage measures the offset along the bearing (south): the line is 5 m the other way
    expect(p?.offset).toBeCloseTo(-5, 9);
  });
});
