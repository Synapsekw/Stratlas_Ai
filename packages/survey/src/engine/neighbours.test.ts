/**
 * Piles that touch (data-conventions section 26, "Edges shared with another pile"): where a pile's
 * edge runs along another pile's, the edge lies on the saddle between the two heaps, not on the
 * ground, so the perimeter bases leave those edge samples out and stand on the rest of the toe.
 */
import type { BaseSpec, ComparisonItem, SurfaceRef } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { compareItem, NEIGHBOUR_M, type Resolve, type ResolvedSurface } from './compare';
import { ArraySurface } from './tiles';

const E0 = 5000;
const N0 = 7000;
const CELL = 0.5;
const NX = 80;
const NY = 60;
const FLOOR = 100;
// two cones 12 m apart, radius 8 m and 5 m high: they merge in a saddle 1.25 m high at x = 18
const A = [12, 15] as const;
const B = [24, 15] as const;
const H = 5;
const R = 8;
const MID = 18;

function cones(): ResolvedSurface {
  const h = new Float64Array(NX * NY);
  for (let j = 0; j < NY; j++)
    for (let i = 0; i < NX; i++) {
      const x = (i + 0.5) * CELL;
      const y = (j + 0.5) * CELL;
      const a = H * (1 - Math.hypot(x - A[0], y - A[1]) / R);
      const b = H * (1 - Math.hypot(x - B[0], y - B[1]) / R);
      h[j * NX + i] = FLOOR + Math.max(a, b, 0);
    }
  return {
    kind: 'grid',
    name: 'Two heaps',
    fingerprint: 'fp-two-heaps',
    grid: new ArraySurface(E0, N0, CELL, NX, NY, h),
  };
}

/** The toe circle of radius 9.5 m around `c`, cut by the line x = MID, on `c`'s side. */
function half(c: readonly [number, number], side: -1 | 1, n = 64): [number, number][] {
  const r = 9.5;
  const t = Math.acos((MID - c[0]) / r);
  const out: [number, number][] = [];
  // the arc away from the cut, then the chord along x = MID
  const a0 = side < 0 ? t : -t;
  const a1 = side < 0 ? 2 * Math.PI - t : t;
  for (let k = 0; k <= n; k++) {
    const a = a0 + ((a1 - a0) * k) / n;
    out.push([E0 + c[0] + r * Math.cos(a), N0 + c[1] + r * Math.sin(a)]);
  }
  return out;
}

const ringA = half(A, -1);
const ringB = half(B, 1);

const resolve: Resolve = (ref: SurfaceRef) =>
  ref.kind === 'survey' ? Promise.resolve(cones()) : Promise.reject(new Error('no surface'));
const survey: SurfaceRef = { kind: 'survey', surface: 's' };
const item = (from: BaseSpec): ComparisonItem => ({
  id: 'a',
  from,
  to: survey,
  useDeadband: false,
});
const smart: BaseSpec = { kind: 'smart' };
const floor: BaseSpec = { kind: 'reference', mode: 'level', levelM: FLOOR };

describe('perimeter bases and the piles next to them', () => {
  it('a shared edge is left out: the smart base stands on the ground part of the toe', async () => {
    const onFloor = await compareItem(ringA, item(floor), resolve);
    const alone = await compareItem(ringA, item(smart), resolve);
    const touching = await compareItem(ringA, item(smart), resolve, { neighbours: [ringB] });
    expect(onFloor.status).toBe('ok');
    expect(touching.status).toBe('ok');
    // the ground toe is the floor all round, so the base is the floor
    expect(touching.netM3).toBeCloseTo(onFloor.netM3, 6);
    expect(touching.peakM).toBeCloseTo(onFloor.peakM ?? NaN, 6);
    // pinned to the saddle, the base rises to 1.25 m at the shared edge and loses volume
    expect(alone.netM3).toBeLessThan(onFloor.netM3 * 0.9);
  });

  it('every perimeter base leaves the shared edge out', async () => {
    for (const b of [
      { kind: 'fit-plane' },
      { kind: 'perimeter-mean' },
      { kind: 'reference', mode: 'perimeter-min' },
      { kind: 'reference', mode: 'perimeter-max' },
    ] satisfies BaseSpec[]) {
      const r = await compareItem(ringA, item(b), resolve, { neighbours: [ringB] });
      expect(
        Math.abs(r.netM3 - (await compareItem(ringA, item(floor), resolve)).netM3),
      ).toBeLessThan(1e-6);
    }
  });

  it('a pile further away than NEIGHBOUR_M changes nothing, the fingerprint included', async () => {
    const away = ringB.map(([e, n]): [number, number] => [e + NEIGHBOUR_M + 0.01, n]);
    const alone = await compareItem(ringA, item(smart), resolve, { now: () => 't' });
    const far = await compareItem(ringA, item(smart), resolve, {
      neighbours: [away],
      now: () => 't',
    });
    expect(far).toEqual(alone);
  });

  it('a touching pile joins the fingerprint, in any order', async () => {
    const alone = await compareItem(ringA, item(smart), resolve);
    const far = ringB.map(([e, n]): [number, number] => [e + 40, n]);
    const one = await compareItem(ringA, item(smart), resolve, { neighbours: [ringB, far] });
    const other = await compareItem(ringA, item(smart), resolve, { neighbours: [far, ringB] });
    expect(one.fingerprint).not.toBe(alone.fingerprint);
    expect(other.fingerprint).toBe(one.fingerprint);
  });

  it('an edge shared all round keeps every sample (a base needs ground to stand on)', async () => {
    const alone = await compareItem(ringA, item(smart), resolve);
    const around = await compareItem(ringA, item(smart), resolve, { neighbours: [ringA] });
    expect(around.netM3).toBeCloseTo(alone.netM3, 9);
  });

  it('a base that is not sampled on the perimeter is not changed', async () => {
    const lvl = await compareItem(ringA, item(floor), resolve);
    const near = await compareItem(ringA, item(floor), resolve, { neighbours: [ringB] });
    expect(near.netM3).toBe(lvl.netM3);
  });
});
