import type { BaseSpec, SitePoint, SurveyMeasurement } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import {
  baseSpecOf,
  buildPileBase,
  heightExtent,
  pileBaseHeights,
  type PileBaseInput,
  type PointsAt,
} from './pileBase';
import { gridPoints, pileGrid } from './pileLook';

/** A 40 m by 30 m boundary whose own heights differ from the ground under it. */
const RING: SitePoint[] = [
  [1000, 2000, 50],
  [1040, 2000, 52],
  [1040, 2030, 54],
  [1000, 2030, 52],
];

/** The ground: a tilted plane, lowest at the boundary's south-west corner. */
const ground = (e: number, n: number) => 100 + 0.1 * (e - 1000) + 0.05 * (n - 2000);
const onGround: PointsAt = (es, ns) =>
  Promise.resolve(Float64Array.from(es, (e, k) => ground(e, ns[k] ?? 0)));
const noSurvey: PointsAt = (es) => Promise.resolve(new Float64Array(es.length).fill(Number.NaN));

/** Points inside the boundary, and one outside it. */
const ES = Float64Array.from([1005, 1020, 1035, 1012.5, 1100]);
const NS = Float64Array.from([2005, 2015, 2025, 2022.5, 2015]);
const INSIDE = 4;

const input = (spec: BaseSpec, at: PointsAt = onGround): PileBaseInput => ({
  spec,
  ring: RING,
  step: 0.5,
  at,
  interior: () => [101, 109],
});

describe('buildPileBase', () => {
  it('a Toe surface is the ground under the boundary, triangulated', async () => {
    const base = await buildPileBase(input({ kind: 'smart' }));
    const z = base?.(ES, NS);
    for (let k = 0; k < INSIDE; k++) expect(z?.[k]).toBeCloseTo(ground(ES[k] ?? 0, NS[k] ?? 0), 6);
    // no base outside the triangulated edge
    expect(Number.isNaN(z?.[INSIDE])).toBe(true);
  });

  it('a Lowest point is one level: the lowest ground under the edge', async () => {
    const base = await buildPileBase(input({ kind: 'reference', mode: 'perimeter-min' }));
    const z = base?.(ES, NS);
    for (let k = 0; k <= INSIDE; k++) expect(z?.[k]).toBeCloseTo(ground(1000, 2000), 9);
  });

  it('the levels inside read the surface extent the caller gives', async () => {
    const lo = await buildPileBase(input({ kind: 'reference', mode: 'interior-min' }));
    expect(lo?.(ES, NS)[0]).toBe(101);
    const hi = await buildPileBase(input({ kind: 'reference', mode: 'interior-max' }));
    expect(hi?.(ES, NS)[0]).toBe(109);
  });

  it('a Custom base is the triangulation of its vertices, in site coordinates', async () => {
    // a plane 2 m under the ground: three typed heights and one read from the ground
    const spec: BaseSpec = {
      kind: 'custom',
      vertices: [
        { e: 1000, n: 2000, z: ground(1000, 2000) - 2 },
        { e: 1040, n: 2000, z: ground(1040, 2000) - 2 },
        { e: 1040, n: 2030, z: ground(1040, 2030) - 2 },
        { e: 1000, n: 2030, offsetM: -2 },
      ],
    };
    const base = await buildPileBase(input(spec));
    const z = base?.(ES, NS);
    for (let k = 0; k < INSIDE; k++)
      expect(z?.[k]).toBeCloseTo(ground(ES[k] ?? 0, NS[k] ?? 0) - 2, 6);
  });

  it('is null when no base can be built (no survey under the edge)', async () => {
    expect(await buildPileBase(input({ kind: 'smart' }, noSurvey))).toBeNull();
    expect(
      await buildPileBase(input({ kind: 'reference', mode: 'perimeter-min' }, noSurvey)),
    ).toBeNull();
  });
});

describe('pileBaseHeights', () => {
  it('gives the base where it has one', async () => {
    const z = await pileBaseHeights(input({ kind: 'smart' }), ES, NS);
    for (let k = 0; k < INSIDE; k++) expect(z[k]).toBeCloseTo(ground(ES[k] ?? 0, NS[k] ?? 0), 6);
    expect(Number.isNaN(z[INSIDE])).toBe(true);
  });

  it('gives the boundary’s own heights when no base can be built', async () => {
    const z = await pileBaseHeights(input({ kind: 'smart' }, noSurvey), ES, NS);
    // the boundary's heights lie on the plane 50 + 0.05 e + 2/30 n
    for (let k = 0; k < INSIDE; k++)
      expect(z[k]).toBeCloseTo(
        50 + 0.05 * ((ES[k] ?? 0) - 1000) + (2 / 30) * ((NS[k] ?? 0) - 2000),
        6,
      );
    expect(Number.isNaN(z[INSIDE])).toBe(true);
  });

  it('samples the pile look’s own grid the same way', async () => {
    const grid = pileGrid(RING, 20);
    const { es, ns } = gridPoints(grid);
    const z = await pileBaseHeights({ ...input({ kind: 'smart' }), step: grid.step }, es, ns);
    expect(z.length).toBe(grid.nx * grid.ny);
    const mid = Math.floor(grid.ny / 2) * grid.nx + Math.floor(grid.nx / 2);
    expect(z[mid]).toBeCloseTo(ground(es[mid] ?? 0, ns[mid] ?? 0), 6);
  });
});

describe('heightExtent', () => {
  it('is the lowest and highest height, leaving out points with no survey', () => {
    expect(heightExtent(Float64Array.from([Number.NaN, 4, 2, 9, Number.NaN]))).toEqual([2, 9]);
    expect(heightExtent(Float64Array.from([Number.NaN]))).toBeNull();
  });
});

describe('baseSpecOf', () => {
  const pile = (items: SurveyMeasurement['items']): Pick<SurveyMeasurement, 'items'> => ({ items });

  it('is the base of the pile’s first comparison', () => {
    const spec: BaseSpec = { kind: 'reference', mode: 'perimeter-min' };
    expect(
      baseSpecOf(pile([{ id: 'a', from: spec, to: { kind: 'current' }, useDeadband: false }])),
    ).toEqual(spec);
  });

  it('is the Toe surface for a pile with no comparison, or one between two surfaces', () => {
    expect(baseSpecOf(pile([]))).toEqual({ kind: 'smart' });
    expect(
      baseSpecOf(
        pile([
          { id: 'a', from: { kind: 'previous' }, to: { kind: 'current' }, useDeadband: false },
        ]),
      ),
    ).toEqual({ kind: 'smart' });
  });
});
