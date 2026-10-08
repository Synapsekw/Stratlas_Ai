/**
 * Quality targets of the M11 plan ("Quality targets"), asserted against analytic truth in the
 * TypeScript executor (the Python core has the same tests in `python/tests/test_survey_compare.py`).
 */
import type { ComparisonItem, SurfaceRef } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { compareItem, type Resolve, type ResolvedSurface } from './compare';
import { ArraySurface } from './tiles';

const E0 = 302000;
const N0 = 2574000;
const CX = 15;
const CY = 15;
const EXTENT = 30;

type Shape = (x: number, y: number) => number;

function gridOf(cell: number, fn: Shape, name = 'g'): ResolvedSurface {
  const n = Math.round(EXTENT / cell);
  const h = new Float64Array(n * n);
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) h[j * n + i] = fn((i + 0.5) * cell, (j + 0.5) * cell);
  return {
    kind: 'grid',
    name,
    fingerprint: `fp-${name}-${cell}`,
    grid: new ArraySurface(E0, N0, cell, n, n, h),
  };
}

const flat: Shape = () => 100;
const r = (x: number, y: number) => Math.sqrt((x - CX) ** 2 + (y - CY) ** 2);

/** Analytic shapes 20 m across on a floor at 100 m, with their volumes. */
const SHAPES: Record<string, { fn: Shape; volume: number }> = {
  cone: {
    fn: (x, y) => 100 + Math.max(0, 5 * (1 - r(x, y) / 10)),
    volume: (Math.PI * 100 * 5) / 3,
  },
  frustum: {
    fn: (x, y) => 100 + Math.min(4, Math.max(0, 4 * ((10 - r(x, y)) / 6))),
    volume: ((Math.PI * 4) / 3) * (100 + 40 + 16),
  },
  paraboloid: {
    fn: (x, y) => 100 + Math.max(0, 6 * (1 - r(x, y) ** 2 / 100)),
    volume: (Math.PI * 100 * 6) / 2,
  },
  // walls on cell edges at both cells (a grid samples cell centres)
  prism: {
    fn: (x, y) => (x > 4.8 && x < 24.8 && y > 8 && y < 20 ? 103 : 100),
    volume: 20 * 12 * 3,
  },
  wedge: {
    fn: (x, y) => (x > 4.8 && x < 24.8 && y > 8 && y < 22 ? 100 + 4 * ((x - 4.8) / 20) : 100),
    volume: (20 * 14 * 4) / 2,
  },
};

function circle(cx: number, cy: number, rad: number, n = 128): [number, number][] {
  return Array.from({ length: n }, (_, k) => [
    E0 + cx + rad * Math.cos((2 * Math.PI * k) / n),
    N0 + cy + rad * Math.sin((2 * Math.PI * k) / n),
  ]);
}

const square: [number, number][] = [
  [E0 + 2, N0 + 2],
  [E0 + 28, N0 + 2],
  [E0 + 28, N0 + 28],
  [E0 + 2, N0 + 28],
];

function resolver(map: Record<string, ResolvedSurface>): Resolve {
  return (ref: SurfaceRef) => {
    const key = ref.kind === 'survey' ? ref.surface : ref.kind;
    const s = map[key];
    return s ? Promise.resolve(s) : Promise.reject(new Error(`no ${key}`));
  };
}

const sv = (surface: string): SurfaceRef => ({ kind: 'survey', surface });
const item = (from: SurfaceRef, to: SurfaceRef, more: Partial<ComparisonItem> = {}) =>
  ({ id: 'q', from, to, useDeadband: false, ...more }) as ComparisonItem;

describe('grid volumes of analytic shapes', () => {
  for (const [name, s] of Object.entries(SHAPES)) {
    for (const [cell, tol] of [
      [20 / 50, 0.005],
      [20 / 200, 0.001],
    ] as const) {
      it(`${name} at ${cell} m cells is within ${tol * 100}%`, async () => {
        const res = resolver({ base: gridOf(cell, flat, 'flat'), shape: gridOf(cell, s.fn, name) });
        const v = await compareItem(square, item(sv('base'), sv('shape')), res);
        expect(v.status).toBe('ok');
        expect(Math.abs(v.fillM3 - s.volume) / s.volume).toBeLessThan(tol);
        expect(v.cutM3).toBe(0);
        // the same against a typed level base
        const lv = await compareItem(
          square,
          item({ kind: 'reference', mode: 'level', levelM: 100 }, sv('shape')),
          res,
        );
        expect(lv.fillM3).toBeCloseTo(v.fillM3, 9);
        // and the bases that sample a flat perimeter
        for (const base of [
          { kind: 'smart' },
          { kind: 'fit-plane' },
          { kind: 'perimeter-mean' },
          { kind: 'reference', mode: 'perimeter-min' },
        ] as SurfaceRef[]) {
          const b = await compareItem(square, item(base, sv('shape')), res);
          expect(Math.abs(b.fillM3 - s.volume) / s.volume).toBeLessThan(tol);
        }
      });
    }
  }
});

describe('TIN to TIN, exact', () => {
  // a square frustum pad: top 6 m, toe 12 m, 2 m high, as a TIN
  const pad = (offset: number, top = 102): ResolvedSurface => {
    const v: number[] = [];
    for (const [s, z] of [
      [3, top],
      [6, 100],
    ] as const)
      v.push(
        E0 + 10 - s,
        N0 + 10 - s,
        z,
        E0 + 10 + s,
        N0 + 10 - s,
        z,
        E0 + 10 + s,
        N0 + 10 + s,
        z,
        E0 + 10 - s,
        N0 + 10 + s,
        z,
      );
    const t = [0, 1, 2, 0, 2, 3];
    for (let k = 0; k < 4; k++) {
      const a = k;
      const b = (k + 1) % 4;
      t.push(4 + a, 4 + b, b, 4 + a, b, a);
    }
    return {
      kind: 'tin',
      name: 'Pad',
      fingerprint: `fp-pad-${offset}`,
      tin: { header: {}, vertices: Float64Array.from(v), triangles: Uint32Array.from(t) },
      offsetM: offset,
    };
  };
  const box: [number, number][] = [
    [E0 + 4, N0 + 4],
    [E0 + 16, N0 + 4],
    [E0 + 16, N0 + 16],
    [E0 + 4, N0 + 16],
  ];
  const res: Resolve = (ref) =>
    Promise.resolve(ref.kind === 'design' && ref.layer === 'sub' ? pad(-0.3) : pad(0));

  it('a pad over a level matches the frustum volume to 1e-9', async () => {
    const v = await compareItem(
      box,
      item(
        { kind: 'reference', mode: 'level', levelM: 100 },
        { kind: 'design', design: 'd', layer: 'top' },
      ),
      res,
    );
    const truth = (2 / 3) * (36 + 6 * 12 + 144);
    expect(v.cellM).toBe(0);
    expect(Math.abs(v.fillM3 - truth) / truth).toBeLessThan(1e-9);
    expect(v.areaFillM2).toBeCloseTo(144, 9);
  });

  it('two offset designs differ by area times offset', async () => {
    const v = await compareItem(
      box,
      item(
        { kind: 'design', design: 'd', layer: 'sub' },
        { kind: 'design', design: 'd', layer: 'top' },
      ),
      res,
    );
    expect(Math.abs(v.fillM3 - 144 * 0.3) / (144 * 0.3)).toBeLessThan(1e-9);
    expect(v.cutM3).toBe(0);
    expect(v.toLabel).toBe('Pad');
    expect(v.fromLabel).toBe('Pad (offset -0.300 m)');
  });
});

describe('areas, deadband and uncovered area', () => {
  it('reports the polygon area to 1e-9 and splits it into fill, cut, unchanged and uncovered', async () => {
    const res = resolver({ base: gridOf(0.1, flat), shape: gridOf(0.1, SHAPES.cone?.fn ?? flat) });
    const ring = circle(15, 15, 12, 7);
    let a = 0;
    for (let k = 0; k < 7; k++) {
      const p = ring[k] ?? [0, 0];
      const q = ring[(k + 1) % 7] ?? [0, 0];
      a += (p[0] - E0) * (q[1] - N0) - (q[0] - E0) * (p[1] - N0);
    }
    const v = await compareItem(ring, item(sv('base'), sv('shape')), res);
    expect(Math.abs(v.areaM2 - a / 2) / (a / 2)).toBeLessThan(1e-9);
    const sum = v.areaFillM2 + v.areaCutM2 + v.areaUnchangedM2 + v.uncoveredM2;
    expect(Math.abs(sum - v.areaM2) / v.areaM2).toBeLessThan(1e-9);
    // the cone's footprint is the fill area (to the cells along its rim)
    expect(Math.abs(v.areaFillM2 - Math.PI * 100) / (Math.PI * 100)).toBeLessThan(0.01);
  });

  it('noise below the deadband gives exactly zero cut and fill', async () => {
    let seed = 7;
    const rand = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    const noisy = gridOf(0.2, () => 100 + (rand() - 0.5) * 0.04, 'noise');
    const res = resolver({ base: gridOf(0.2, flat), shape: noisy });
    const on = await compareItem(
      square,
      item(sv('base'), sv('shape'), { deadbandM: 0.05, useDeadband: true }),
      res,
    );
    expect(on.fillM3).toBe(0);
    expect(on.cutM3).toBe(0);
    expect(on.usedDeadband).toBe(true);
    expect(on.areaUnchangedM2).toBeCloseTo(on.areaM2, 6);
    const off = await compareItem(
      square,
      item(sv('base'), sv('shape'), { deadbandM: 0.05, useDeadband: false }),
      res,
    );
    expect(off.fillM3).toBeGreaterThan(0);
    expect(off.cutM3).toBeGreaterThan(0);
    expect(off.usedDeadband).toBe(false);
  });

  it('a polygon half outside the survey reports the uncovered area and refuses', async () => {
    const res = resolver({ base: gridOf(0.2, flat), shape: gridOf(0.2, SHAPES.cone?.fn ?? flat) });
    const half: [number, number][] = [
      [E0 + 20, N0 + 5],
      [E0 + 40, N0 + 5],
      [E0 + 40, N0 + 25],
      [E0 + 20, N0 + 25],
    ];
    const v = await compareItem(half, item(sv('base'), sv('shape')), res);
    expect(v.status).toBe('refused');
    expect(v.reason).toBe('50% outside the survey');
    expect(v.uncoveredM2).toBeCloseTo(200, 6);
    expect(v.fillM3).toBe(0);
    // 10% outside: partial, with the volume of the covered part
    const tenth: [number, number][] = [
      [E0 + 12, N0 + 5],
      [E0 + 32, N0 + 5],
      [E0 + 32, N0 + 25],
      [E0 + 12, N0 + 25],
    ];
    const p = await compareItem(tenth, item(sv('base'), sv('shape')), res);
    expect(p.status).toBe('partial');
    expect(p.reason).toBe('10% outside the survey');
    expect(p.uncoveredM2).toBeCloseTo(40, 6);
    expect(p.fillM3).toBeGreaterThan(0);
    // just over 20%: refused
    const over: [number, number][] = [
      [E0 + 14, N0 + 5],
      [E0 + 34.2, N0 + 5],
      [E0 + 34.2, N0 + 25],
      [E0 + 14, N0 + 25],
    ];
    expect((await compareItem(over, item(sv('base'), sv('shape')), res)).status).toBe('refused');
  });
});
