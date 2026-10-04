import { describe, expect, it } from 'vitest';
import { syntheticPile } from '../testing';
import { changeBodyFine, coarseBody, editBody, fineBody } from './bodies';
import { editGeometry } from './edit';
import { decodePile, type CoarseGrids, type DsmGrid } from './kitdata';

const count = (a: Uint8Array) => a.reduce((s, v) => s + v, 0);

describe('fineBody', () => {
  it('samples the pile surface and its base over the mask', async () => {
    const p = await decodePile(syntheticPile().text);
    const b = fineBody(p, 'e2', 'tin', 1);
    if (!b) throw new Error('no body');
    expect([b.nx, b.ny, b.cell]).toEqual([20, 10, 0.1]);
    expect(b.e0).toBeCloseTo(1000.05, 9);
    expect(b.n0).toBeCloseTo(1999.95, 9);
    expect(count(b.ins)).toBe(72);
    expect(b.tmax).toBeCloseTo(53, 5);
    expect(b.bmin).toBeCloseTo(51, 5);
    const i = 5 * 20 + 10;
    expect(b.top[i]).toBeCloseTo(53, 5);
    expect(b.bot[i]).toBeCloseTo(51, 5);
  });

  it('thins the grid by the step', async () => {
    const p = await decodePile(syntheticPile().text);
    const b = fineBody(p, 'e2', 'avg', 3);
    expect([b?.nx, b?.ny, b?.cell]).toEqual([7, 4, 0.30000000000000004]);
    expect(b?.bot[b.ins.indexOf(1)]).toBe(51.5);
  });

  it('is null when the pile is absent on the date', async () => {
    const p = await decodePile(syntheticPile().text);
    expect(fineBody(p, 'e1', 'tin', 1)).toBeNull();
  });
});

describe('changeBodyFine', () => {
  it('spans both surveys where they differ beyond the deadband, signed', async () => {
    const p = await decodePile(syntheticPile().text);
    const b = changeBodyFine(p, 'e1', 'e2', 0.1, 1);
    if (!b) throw new Error('no body');
    expect(count(b.ins)).toBe(40);
    const i = 5 * 20 + 10;
    expect(b.top[i]).toBeCloseTo(53, 5);
    expect(b.bot[i]).toBeCloseTo(51, 5);
    expect(b.d?.[i]).toBeCloseTo(2, 5);
  });
});

describe('coarseBody', () => {
  it('reads the 0.4 m mask window over the site DSM', () => {
    const dsm: DsmGrid = {
      epoch: 'e2',
      w: 4,
      h: 4,
      res: 0.4,
      x0: 0,
      y1: 1.6,
      zoff: 50,
      z: Int16Array.from({ length: 16 }, () => 300),
      valid: Uint8Array.from({ length: 16 }, () => 1),
    };
    const coarse: CoarseGrids = {
      res: 0.4,
      x0: 0,
      y1: 1.6,
      piles: {
        P01: {
          bx0: 1,
          by0: 1,
          w: 2,
          h: 2,
          zone: Uint8Array.from([1, 1, 1, 1]),
          ep: {
            e2: {
              m: Uint8Array.from([1, 1, 0, 1]),
              tin: Int16Array.from([100, 100, 100, 100]),
              low: 51,
              avg: 51,
              plane: { c: [51, 0, 0], x0: 0, y1: 1.6 },
            },
          },
        },
      },
    };
    const b = coarseBody(coarse, dsm, 'P01', 'e2', 'tin');
    if (!b) throw new Error('no body');
    expect([b.nx, b.ny]).toEqual([2, 2]);
    expect(b.e0).toBeCloseTo(0.6, 9);
    expect(b.n0).toBeCloseTo(1.0, 9);
    expect([...b.ins]).toEqual([1, 1, 0, 1]);
    expect(b.top[0]).toBe(53);
    expect(b.bot[0]).toBe(51);
  });
});

describe('editBody', () => {
  it('fills the edited ring on a regular grid', () => {
    const surf = () => 52;
    const g = editGeometry(
      [
        [0, 0],
        [4, 0],
        [4, 4],
        [0, 4],
      ],
      surf,
    );
    if (!g) throw new Error('no geometry');
    const b = editBody(g, 'low', 0.5);
    expect(count(b.ins)).toBe(64);
    expect(b.top[b.ins.indexOf(1)]).toBe(52);
  });
});
