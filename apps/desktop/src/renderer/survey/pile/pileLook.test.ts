import type { SitePoint } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import {
  buildPrism,
  fitDistance,
  gridPoints,
  heightRamp,
  HEIGHT_RAMP,
  insideRing,
  legendStops,
  loopSegments,
  mostlyInView,
  pileFlyView,
  pileGrid,
  pileLift,
  prismHitShapes,
  ringBase,
  type PrismInput,
} from './pileLook';

/** A 40 m square at 100 m, a cone 6 m high in its middle on flat ground. */
const RING: SitePoint[] = [
  [1000, 2000, 100],
  [1040, 2000, 100],
  [1040, 2040, 100],
  [1000, 2040, 100],
];

function cone(): PrismInput {
  const grid = pileGrid(RING, 40);
  const { es, ns } = gridPoints(grid);
  const zs = new Float64Array(es.length);
  for (let k = 0; k < zs.length; k++) {
    const r = Math.hypot((es[k] ?? 0) - 1020, (ns[k] ?? 0) - 2020);
    zs[k] = 100 + Math.max(0, 6 - r * 0.5);
  }
  return { ring: RING, grid, zs, base: ringBase(RING), mode: 'solid' };
}

describe('the opened pile prism', () => {
  it('lays a grid over the boundary box, about the asked cells across', () => {
    const g = pileGrid(RING, 40);
    expect(g.span).toBe(40);
    expect(g.step).toBe(1);
    expect(g.nx).toBe(41);
    expect(g.ny).toBe(41);
    expect(gridPoints(g).es).toHaveLength(41 * 41);
  });

  it('lifts the top well clear of the pile: 1.6 times its height or a fifth of its size', () => {
    expect(pileLift(6, 40)).toBeCloseTo(9.6);
    expect(pileLift(1, 40)).toBeCloseTo(8.8);
    const p = buildPrism(cone());
    expect(p.hmax).toBeCloseTo(6, 1);
    expect(p.lift).toBeCloseTo(pileLift(p.hmax, 40));
  });

  it('draws one post per vertex, from the ground to the top', () => {
    const p = buildPrism(cone());
    expect(p.posts).toHaveLength(RING.length);
    for (const [a, b] of p.posts) {
      expect(b[0]).toBe(a[0]);
      expect(b[1]).toBe(a[1]);
      expect(b[2] - a[2]).toBeCloseTo(p.lift);
    }
  });

  it('frames the boundary at the ground and at the top, the same loop lifted', () => {
    const p = buildPrism(cone());
    expect(p.topLoop).toHaveLength(p.bottomLoop.length);
    expect(p.bottomLoop.length).toBeGreaterThan(RING.length);
    p.topLoop.forEach((q, k) => {
      const b = p.bottomLoop[k];
      expect(q[2] - (b?.[2] ?? 0)).toBeCloseTo(p.lift - 0.06);
    });
    // a closed loop: as many segments as points
    expect(loopSegments(p.topLoop)).toHaveLength(p.topLoop.length * 2);
  });

  it('clips the base to the boundary and lays it on the base surface', () => {
    const tri: SitePoint[] = [
      [0, 0, 10],
      [40, 0, 10],
      [0, 40, 10],
    ];
    const grid = pileGrid(tri, 20);
    const { es } = gridPoints(grid);
    const p = buildPrism({
      ring: tri,
      grid,
      zs: new Float64Array(es.length).fill(12),
      base: ringBase(tri),
      mode: 'solid',
    });
    const pos = p.base.positions;
    // every triangle of the base has its middle inside the triangle (the outer half is left out)
    let tris = 0;
    for (let t = 0; t < p.base.index.length; t += 3) {
      let e = 0;
      let n = 0;
      for (let c = 0; c < 3; c++) {
        const v = p.base.index[t + c] ?? 0;
        e += (pos[v * 3] ?? 0) / 3;
        n += (pos[v * 3 + 1] ?? 0) / 3;
        expect(pos[v * 3 + 2]).toBeCloseTo(10.03);
      }
      expect(e + n).toBeLessThanOrEqual(41);
      tris++;
    }
    expect(tris).toBeGreaterThan(0);
    // about half the box's cells
    expect(tris / 2).toBeLessThan(grid.nx * grid.ny * 0.6);
  });

  it('colours the top solid red, or by height above the base', () => {
    const solid = buildPrism(cone());
    const height = buildPrism({ ...cone(), mode: 'height' });
    const g = pileGrid(RING, 40);
    const at = (i: number, j: number) => (j * g.nx + i) * 3;
    const peak = at(20, 20);
    const foot = at(2, 2);
    // solid: red everywhere
    expect(solid.top.colours?.[peak] ?? 0).toBeGreaterThan(
      (solid.top.colours?.[peak + 2] ?? 0) * 5,
    );
    // height: the peak red, the foot blue
    const c = height.top.colours;
    expect(c?.[peak] ?? 0).toBeGreaterThan(c?.[peak + 2] ?? 1);
    expect(c?.[foot + 2] ?? 0).toBeGreaterThan(c?.[foot] ?? 1);
    // the top sits at the terrain, lifted
    expect(height.top.positions[peak + 2]).toBeCloseTo(106 + height.lift, 1);
  });

  it('takes the cut and fill colours in change mode', () => {
    const p = buildPrism({ ...cone(), change: () => [0, 0, 1] });
    const c = p.top.colours;
    expect(c?.[2] ?? 0).toBeGreaterThan(0.1);
    expect(c?.[0]).toBe(0);
  });

  it('maps the height ramp from blue at the base to red at the top', () => {
    const same = (a: readonly number[], b: readonly number[] | undefined) => {
      a.forEach((v, i) => {
        expect(v).toBeCloseTo(b?.[i] ?? Number.NaN);
      });
    };
    same(heightRamp(0), HEIGHT_RAMP[0]);
    same(heightRamp(1), HEIGHT_RAMP[4]);
    same(heightRamp(0.5), HEIGHT_RAMP[2]);
    same(heightRamp(-3), HEIGHT_RAMP[0]);
    same(heightRamp(Number.NaN), HEIGHT_RAMP[0]);
    const q = heightRamp(0.125);
    expect(q[0]).toBeCloseTo(((HEIGHT_RAMP[0]?.[0] ?? 0) + (HEIGHT_RAMP[1]?.[0] ?? 0)) / 2);
  });

  it("reads the legend's range from the highest point above the base", () => {
    expect(legendStops(7.7)).toEqual([0, 3.85, 7.7]);
    expect(legendStops(-1)).toEqual([0, 0, 0]);
    const p = buildPrism({ ...cone(), mode: 'height' });
    expect(legendStops(p.hmax)[2]).toBeCloseTo(6, 1);
  });

  it('knows inside from outside, and falls back to the ring for a base', () => {
    expect(insideRing(1020, 2020, RING)).toBe(true);
    expect(insideRing(1050, 2020, RING)).toBe(false);
    expect(ringBase(RING)(1020, 2020)).toBeCloseTo(100);
    expect(ringBase(RING)(1050, 2020)).toBeNull();
  });

  it('hit-tests the lifted top and one side per edge', () => {
    const p = buildPrism(cone());
    const shapes = prismHitShapes('m-1', p);
    expect(shapes).toHaveLength(1 + RING.length);
    expect(shapes.every((s) => s.id === 'm-1' && s.closed)).toBe(true);
    expect(shapes[0]?.points[0]?.[2]).toBeCloseTo((p.groundRing[0]?.[2] ?? 0) + p.lift);
    expect(shapes[1]?.points).toHaveLength(4);
  });
});

describe('the fly to an opened pile', () => {
  it('looks down at 38 degrees from the south-south-west, framing the box', () => {
    const v = pileFlyView({ centre: [10, 20, 100], lift: 10, span: 40 });
    expect(v.at).toEqual([10, 20, 104.5]);
    expect(v.distance).toBe(90);
    expect((Math.asin(v.dir[2]) * 180) / Math.PI).toBeCloseTo(38);
    expect(Math.hypot(...v.dir)).toBeCloseTo(1);
    // the camera sits south and a little west of the pile
    expect(v.dir[1]).toBeLessThan(0);
    expect(v.dir[0]).toBeLessThan(0);
  });

  it('stands further back in a narrow view, so the whole box fits', () => {
    const p = { centre: [0, 0, 0] as [number, number, number], lift: 10, span: 40 };
    const wide = pileFlyView(p, { vfovDeg: 40, aspect: 1.6 });
    const narrow = pileFlyView(p, { vfovDeg: 40, aspect: 0.6 });
    expect(narrow.distance).toBeGreaterThan(wide.distance * 1.5);
    // the sphere round the box fits the vertical angle in a wide view
    const r = 0.5 * Math.hypot(40, 40, 10);
    expect(fitDistance(r, 40, 1.6)).toBeCloseTo(r / Math.sin((20 * Math.PI) / 180));
  });

  it('flies only when the pile is not mostly in view', () => {
    const corners = (dx: number) =>
      [
        { x: 100 + dx, y: 100 },
        { x: 300 + dx, y: 100 },
        { x: 300 + dx, y: 300 },
        { x: 100 + dx, y: 300 },
      ] as const;
    expect(mostlyInView(corners(0), 800, 600)).toBe(true);
    // half of it off the right edge
    expect(mostlyInView(corners(600), 800, 600)).toBe(false);
    // behind the camera
    expect(mostlyInView([null, null, null, null], 800, 600)).toBe(false);
    // in view but a speck
    expect(
      mostlyInView(
        [
          { x: 10, y: 10 },
          { x: 20, y: 20 },
        ],
        800,
        600,
      ),
    ).toBe(false);
  });
});
