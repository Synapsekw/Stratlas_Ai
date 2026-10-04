import { describe, expect, it } from 'vitest';
import { syntheticPile } from '../testing';
import { localToEN, enToLocal, pileSurface } from './frame';
import { decodePile, type DsmGrid } from './kitdata';

describe('local frame and project CRS', () => {
  const origin: [number, number, number] = [212624, 3201610.5, 51];

  it('maps [x, z] to easting and northing (x east, z south)', () => {
    expect(localToEN(origin, [86.75, -139.5])).toEqual([212710.75, 3201750]);
    expect(enToLocal(origin, [212710.75, 3201750])).toEqual([86.75, -139.5]);
  });
});

describe('pileSurface', () => {
  it('reads the 10 cm pile grid inside it and the site DSM elsewhere', async () => {
    const p = await decodePile(syntheticPile().text);
    const dsm: DsmGrid = {
      epoch: 'e2',
      w: 2,
      h: 2,
      res: 100,
      x0: 900,
      y1: 2100,
      zoff: 50,
      z: Int16Array.from([700, 700, 700, 700]),
      valid: Uint8Array.from([1, 1, 1, 1]),
    };
    const surf = pileSurface(p, 'e2', dsm);
    // block cell (x 5..14, y 3..6) of the pile grid at x0 1000, y1 2000
    expect(surf(1000.75, 1999.55)).toBeCloseTo(53, 9);
    expect(surf(1000.05, 1999.95)).toBeCloseTo(51, 9);
    expect(surf(950, 2050)).toBeCloseTo(57, 9);
    expect(pileSurface(null, 'e2', dsm)(1000.75, 1999.55)).toBeCloseTo(57, 9);
  });
});
