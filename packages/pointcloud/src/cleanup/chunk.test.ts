import { emptyCleanup, type PointcloudCleanup } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { compileCleanup } from './evaluate';
import { chunkMask, chunkMaskFor } from './chunk';

/** Ten points along local x at 0..9 m (world E = x with this origin), y = z = 0. */
const input = {
  count: 10,
  positions: Uint16Array.from({ length: 30 }, (_, k) => (k % 3 === 0 ? k / 3 : 0)),
  quant: { offset: [0, 0, 0] as const, scale: [1, 1, 1] as const },
  classes: new Uint8Array(10).fill(2),
};
const origin = [0, 64, 0] as const;
/** World to clip: ndc x = 0.1 E - 0.45 (E < 4.5 is left of 0), ndc y = 0, w = 1. */
const VP = [0.1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, -0.45, 0, 0, 1];
const left: [number, number][] = [
  [-1, -1],
  [0, -1],
  [0, 1],
  [-1, 1],
];
const withRegion = (action: PointcloudCleanup['regions'][number]['action']): PointcloudCleanup => ({
  ...emptyCleanup('a'),
  regions: [{ id: 'r', shape: 'box', viewProj: VP, polygon: left, action }],
});

describe('chunk masks', () => {
  it('masks nothing without regions', () => {
    const r = chunkMask(compileCleanup(emptyCleanup('a'), { origin }), input);
    expect([...r.mask]).toEqual(new Array(10).fill(0));
    expect(r.cls).toBeNull();
  });

  it('masks a deleted or hidden selection', () => {
    for (const kind of ['delete', 'hide'] as const) {
      const r = chunkMaskFor(withRegion({ kind }), origin, input);
      expect([...r.mask]).toEqual([1, 1, 1, 1, 1, 0, 0, 0, 0, 0]);
    }
  });

  it('overrides the class of a selection and counts the new classes', () => {
    const r = chunkMaskFor(withRegion({ kind: 'class', value: 7 }), origin, input);
    expect([...r.mask]).toEqual(new Array(10).fill(0));
    expect([...(r.cls ?? [])]).toEqual([7, 7, 7, 7, 7, 2, 2, 2, 2, 2]);
    expect(r.classes).toEqual({ 2: 5, 7: 5 });
  });
});
