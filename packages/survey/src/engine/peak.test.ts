/**
 * Peak height (`ComparisonResult.peakM`): the greatest height of the surface above its base inside
 * the polygon, on the base the volume uses. Only a surface against a base has one.
 */
import type { BaseSpec, ComparisonItem, SurfaceRef } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { compareItem, type Resolve, type ResolvedSurface } from './compare';
import { ArraySurface } from './tiles';

const E0 = 1000;
const N0 = 2000;
const CELL = 0.5;
const NX = 41;
// the apex sits on a cell centre (20.5 cells from the origin)
const CX = 10.25;
const CY = 10.25;
const H = 4;
const R = 7;

function coneGrid(): ResolvedSurface {
  const h = new Float64Array(NX * NX);
  for (let j = 0; j < NX; j++)
    for (let i = 0; i < NX; i++) {
      const d = Math.hypot((i + 0.5) * CELL - CX, (j + 0.5) * CELL - CY);
      h[j * NX + i] = 100 + Math.max(H * (1 - d / R), 0);
    }
  return {
    kind: 'grid',
    name: 'Cone',
    fingerprint: 'fp-cone',
    grid: new ArraySurface(E0, N0, CELL, NX, NX, h),
  };
}

function pyramidTin(): ResolvedSurface {
  // a square pyramid 3 m high on a floor at 100, apex at the centre
  const v = [
    [0, 0, 100],
    [20, 0, 100],
    [20, 20, 100],
    [0, 20, 100],
    [10, 10, 103],
  ].flatMap(([x, y, z]) => [E0 + (x ?? 0), N0 + (y ?? 0), z ?? 0]);
  return {
    kind: 'tin',
    name: 'Pyramid',
    fingerprint: 'fp-pyramid',
    tin: {
      header: {},
      vertices: Float64Array.from(v),
      triangles: Uint32Array.from([0, 1, 4, 1, 2, 4, 2, 3, 4, 3, 0, 4]),
    },
    offsetM: 0,
  };
}

const resolver =
  (s: ResolvedSurface): Resolve =>
  (ref: SurfaceRef) =>
    ref.kind === 'survey' ? Promise.resolve(s) : Promise.reject(new Error('no surface'));

function circle(cx: number, cy: number, r: number, n = 48): [number, number][] {
  return Array.from({ length: n }, (_, k) => {
    const a = (2 * Math.PI * k) / n;
    return [E0 + cx + r * Math.cos(a), N0 + cy + r * Math.sin(a)];
  });
}

const survey: SurfaceRef = { kind: 'survey', surface: 's' };
const level100: BaseSpec = { kind: 'reference', mode: 'level', levelM: 100 };
const item = (from: ComparisonItem['from'], to: ComparisonItem['to']): ComparisonItem => ({
  id: 'a',
  from,
  to,
  useDeadband: false,
});

describe('peak height', () => {
  it('is the cone height above a level base (grid path)', async () => {
    const r = await compareItem(circle(CX, CY, 8), item(level100, survey), resolver(coneGrid()));
    expect(r.status).toBe('ok');
    expect(r.peakM).toBeCloseTo(H, 9);
  });

  it('is measured above the base the volume uses', async () => {
    const r = await compareItem(
      circle(CX, CY, 8),
      item({ kind: 'reference', mode: 'level', levelM: 101 }, survey),
      resolver(coneGrid()),
    );
    expect(r.peakM).toBeCloseTo(H - 1, 9);
  });

  it('is the surface above the base when the base is the To side', async () => {
    const r = await compareItem(circle(CX, CY, 8), item(survey, level100), resolver(coneGrid()));
    expect(r.peakM).toBeCloseTo(H, 9);
  });

  it('is 0 when the surface sits below its base', async () => {
    const r = await compareItem(
      circle(CX, CY, 8),
      item({ kind: 'reference', mode: 'level', levelM: 110 }, survey),
      resolver(coneGrid()),
    );
    expect(r.peakM).toBe(0);
  });

  it('is the pyramid height on the exact path', async () => {
    const r = await compareItem(circle(10, 10, 9), item(level100, survey), resolver(pyramidTin()));
    expect(r.cellM).toBe(0);
    expect(r.peakM).toBeCloseTo(3, 9);
  });

  it('is absent between two surfaces and on a refused result', async () => {
    const both = await compareItem(circle(CX, CY, 8), item(survey, survey), resolver(coneGrid()));
    expect(both.peakM).toBeUndefined();
    const outside = await compareItem(
      circle(CX + 60, CY, 8),
      item(level100, survey),
      resolver(coneGrid()),
    );
    expect(outside.status).toBe('refused');
    expect(outside.peakM).toBeUndefined();
  });
});
