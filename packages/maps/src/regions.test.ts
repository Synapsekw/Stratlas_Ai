import { describe, expect, it } from 'vitest';
import { estimatePackBytes, normaliseBbox, tileCount } from './estimate';
import { COUNTRIES, GCC_IDS, packIdFor, regionById } from './regions';

describe('tileCount', () => {
  it('counts every tile of the world at a zoom', () => {
    expect(tileCount([-180, -85.05, 180, 85.05], 0)).toBe(1);
    expect(tileCount([-180, -85.05, 180, 85.05], 3)).toBe(64);
  });

  it('counts the tiles a small box touches', () => {
    expect(tileCount([46.5, 28.5, 48.5, 30.1], 0)).toBe(1);
    const z10 = tileCount([46.5, 28.5, 48.5, 30.1], 10);
    expect(z10).toBeGreaterThan(20);
    expect(z10).toBeLessThan(40);
  });
});

describe('estimatePackBytes', () => {
  // Real packs cut from planet build 20261003 (packages/maps/README.md).
  const cases: [string, [number, number, number, number], number, number][] = [
    ['kuwait', [46.5, 28.5, 48.5, 30.1], 15, 23.7e6],
    ['world', [-180, -85, 180, 85], 6, 45e6],
    ['gcc', [34.5, 12, 60, 32.5], 15, 1.31e9],
  ];
  for (const [name, bbox, z, real] of cases) {
    it(`brackets the real size of the ${name} pack`, () => {
      const e = estimatePackBytes(bbox, z);
      expect(e.low).toBeLessThanOrEqual(real);
      expect(e.high).toBeGreaterThanOrEqual(real);
      expect(e.low).toBeLessThan(e.bytes);
      expect(e.bytes).toBeLessThan(e.high);
    });
  }

  it('grows with the zoom', () => {
    const box: [number, number, number, number] = [50.7, 24.4, 51.7, 26.2];
    expect(estimatePackBytes(box, 14).bytes).toBeGreaterThan(estimatePackBytes(box, 12).bytes);
  });
});

describe('normaliseBbox', () => {
  it('orders corners and clamps to the map', () => {
    expect(normaliseBbox([10, 5, -10, -5])).toEqual([-10, -5, 10, 5]);
    expect(normaliseBbox([-200, -89, 200, 89])).toEqual([-180, -85.05, 180, 85.05]);
  });

  it('rounds to 4 decimals', () => {
    expect(normaliseBbox([1.234567, 2, 3, 4])).toEqual([1.2346, 2, 3, 4]);
  });
});

describe('regions', () => {
  it('lists the six GCC states first', () => {
    expect(GCC_IDS).toEqual(['bahrain', 'kuwait', 'oman', 'qatar', 'saudi-arabia', 'uae']);
    for (const id of GCC_IDS) expect(regionById(id)?.group).toBe('gcc');
  });

  it('has valid, unique boxes for every country', () => {
    const ids = new Set<string>();
    for (const c of COUNTRIES) {
      expect(ids.has(c.id)).toBe(false);
      ids.add(c.id);
      const [w, s, e, n] = c.bbox;
      expect(w).toBeLessThan(e);
      expect(s).toBeLessThan(n);
      expect(c.id).toMatch(/^[a-z0-9-]+$/);
    }
    expect(COUNTRIES.length).toBeGreaterThan(40);
  });

  it('puts Kuwait City inside Kuwait', () => {
    const k = regionById('kuwait');
    expect(k).toBeDefined();
    const [w, s, e, n] = k?.bbox ?? [0, 0, 0, 0];
    expect(47.98 > w && 47.98 < e && 29.37 > s && 29.37 < n).toBe(true);
  });

  it('makes a pack id from a label and zoom', () => {
    expect(packIdFor('Saudi Arabia', 14)).toBe('saudi-arabia-z14');
    expect(packIdFor('  Doha (west) ', 15)).toBe('doha-west-z15');
    expect(packIdFor('الكويت', 12)).toBe('region-z12');
  });
});
