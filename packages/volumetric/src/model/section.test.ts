import { describe, expect, it } from 'vitest';
import { syntheticPile } from '../testing';
import { decodePile } from './kitdata';
import { pileLongSection } from './section';

describe('pileLongSection', () => {
  it('runs along the main axis of the pile with both surveys and the base line', async () => {
    const p = await decodePile(syntheticPile().text);
    const s = pileLongSection(p, 'e2', 'tin', 'e1', 'e2');
    // the 12 x 6 cell mask is longest east-west: the line runs along a row
    expect(s.s.length).toBe(s.z1.length);
    expect(s.s.length).toBe(s.base.length);
    expect(s.s[0]).toBe(0);
    expect(Math.max(...s.z2.filter((v): v is number => v !== null))).toBeCloseTo(53, 6);
    expect(Math.max(...s.z1.filter((v): v is number => v !== null))).toBeCloseTo(51, 6);
    const bases = s.base.filter((v): v is number => v !== null);
    expect(bases.length).toBeGreaterThan(0);
    for (const b of bases) expect(b).toBeCloseTo(51, 6);
    expect(s.base[0]).toBeNull();
  });
});
