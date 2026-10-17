import { describe, expect, it } from 'vitest';
import { BANDS, bandById, nRb } from './bands';

describe('nRb', () => {
  it('LTE 20 MHz is 100 RB', () => {
    expect(nRb('lte', 20)).toBe(100);
  });
  it('LTE 5/10/15 MHz', () => {
    expect([5, 10, 15].map((b) => nRb('lte', b))).toEqual([25, 50, 75]);
  });
  it('NR 100 MHz at 30 kHz is 273 PRB', () => {
    expect(nRb('nr', 100, 30)).toBe(273);
  });
  it('NR 15 kHz tops out at 50 MHz (270)', () => {
    expect(nRb('nr', 50, 15)).toBe(270);
    expect(nRb('nr', 20, 15)).toBe(106);
    expect(() => nRb('nr', 100, 15)).toThrow();
  });
  it('NR 30 kHz table points', () => {
    expect(nRb('nr', 20, 30)).toBe(51);
    expect(nRb('nr', 50, 30)).toBe(133);
  });
  it('rejects unsupported bandwidths', () => {
    expect(() => nRb('lte', 25)).toThrow();
    expect(() => nRb('nr', 20)).toThrow();
  });
});

describe('BANDS', () => {
  it('holds the ten spec rows with unique ids', () => {
    expect(BANDS).toHaveLength(10);
    expect(new Set(BANDS.map((b) => b.id)).size).toBe(10);
  });
  it('every band has a centre frequency inside its range', () => {
    for (const b of BANDS) {
      expect(b.dlRangeMHz[0]).toBeLessThan(b.dlRangeMHz[1]);
      expect(b.centreMHz).toBeGreaterThanOrEqual(b.dlRangeMHz[0]);
      expect(b.centreMHz).toBeLessThanOrEqual(b.dlRangeMHz[1]);
    }
  });
  it('duplex follows the spec table', () => {
    const tdd = ['b40-n40', 'b41-n41', 'n78', 'n77'];
    for (const b of BANDS) expect(b.duplex).toBe(tdd.includes(b.id) ? 'TDD' : 'FDD');
  });
  it('looks up by id', () => {
    expect(bandById('n78')?.centreMHz).toBe(3500);
    expect(bandById('nope')).toBeUndefined();
  });
});
