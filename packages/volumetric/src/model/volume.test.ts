import { describe, expect, it } from 'vitest';
import { syntheticPile } from '../testing';
import { decodePile } from './kitdata';
import { pileChange, pileVolume, pileVolumes } from './volume';

describe('pileVolume', () => {
  it('sums fill and cut against each base over the pile mask', async () => {
    const p = await decodePile(syntheticPile().text);
    // 40 cells of 0.01 m² stand 2 m above the floor (51 m) inside a 72-cell mask.
    const tin = pileVolume(p, 'e2', 'tin');
    expect(tin?.fill).toBeCloseTo(0.8, 9);
    expect(tin?.cut).toBe(0);
    expect(tin?.net).toBeCloseTo(0.8, 9);
    expect(pileVolume(p, 'e2', 'low')?.net).toBeCloseTo(0.8, 9);
    expect(pileVolume(p, 'e2', 'plane')?.net).toBeCloseTo(0.8, 9);
    // average base 51.5 m: 40 cells 1.5 m above, 32 cells 0.5 m below
    const avg = pileVolume(p, 'e2', 'avg');
    expect(avg?.fill).toBeCloseTo(0.6, 9);
    expect(avg?.cut).toBeCloseTo(0.16, 9);
    expect(avg?.net).toBeCloseTo(0.44, 9);
  });

  it('reports footprint, top and height above the lowest base point', async () => {
    const p = await decodePile(syntheticPile().text);
    const v = pileVolume(p, 'e2', 'tin');
    expect(v?.areaM2).toBeCloseTo(0.72, 9);
    expect(v?.topM).toBeCloseTo(53, 9);
    expect(v?.heightM).toBeCloseTo(2, 9);
  });

  it('is null on a date the pile is absent', async () => {
    const p = await decodePile(syntheticPile().text);
    expect(pileVolume(p, 'e1', 'tin')).toBeNull();
  });

  it('gives all four bases at once', async () => {
    const p = await decodePile(syntheticPile().text);
    const all = pileVolumes(p, 'e2');
    expect(all?.tin.net).toBeCloseTo(0.8, 9);
    expect(all?.avg.net).toBeCloseTo(0.44, 9);
  });
});

describe('pileChange', () => {
  it('counts height changes beyond the deadband inside the zone', async () => {
    const p = await decodePile(syntheticPile().text);
    const c = pileChange(p, 'e1', 'e2', 0.1);
    expect(c.fill).toBeCloseTo(0.8, 9);
    expect(c.cut).toBe(0);
    expect(pileChange(p, 'e2', 'e1', 0.1).net).toBeCloseTo(-0.8, 9);
    expect(pileChange(p, 'e1', 'e2', 2.5).fill).toBe(0);
  });
});
