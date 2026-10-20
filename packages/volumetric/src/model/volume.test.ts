import { describe, expect, it } from 'vitest';
import { syntheticPile } from '../testing';
import { decodePile } from './kitdata';
import { gridBase } from './volume';

// gridBase only shapes the 3D body under a kit pile; no figure is computed from it
describe('gridBase', () => {
  it('gives the floor under the synthetic pile on each base', async () => {
    const p = await decodePile(syntheticPile().text);
    const o = p.ep.e2;
    if (!o) throw new Error('no e2');
    expect(gridBase(o, 'low', p)(0, 0, 0)).toBe(51);
    expect(gridBase(o, 'avg', p)(0, 0, 0)).toBe(51.5);
    expect(gridBase(o, 'plane', p)(3, 4, 43)).toBe(51);
    expect(gridBase(o, 'tin', p)(0, 0, 0)).toBeCloseTo(51, 9);
  });

  it('says which base a grid lacks', async () => {
    const p = await decodePile(syntheticPile().text);
    const o = p.ep.e1;
    if (!o) throw new Error('no e1');
    expect(() => gridBase(o, 'low', p)).toThrow(/low/);
  });
});
