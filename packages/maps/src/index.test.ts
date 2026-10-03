import { describe, expect, it } from 'vitest';
import { packCovers, packUrl } from './index';

describe('map packs', () => {
  it('builds a pmtiles url', () => {
    expect(packUrl({ id: 'gcc' })).toBe('pmtiles://aio://packs/gcc.pmtiles');
  });

  it('rejects path-like ids', () => {
    expect(() => packUrl({ id: '../x' })).toThrow('Invalid map pack id');
  });

  it('knows Al-Zour is inside the GCC pack', () => {
    expect(packCovers({ bbox: [34.5, 12.0, 60.0, 32.5] }, 48.4, 28.7)).toBe(true);
  });
});
