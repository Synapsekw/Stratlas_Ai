import { describe, expect, it } from 'vitest';
import { STREET_MAX_LEVEL, streetCover } from './streetCover';

const world = { bbox: [-180, -85, 180, 85], maxZoom: 6 };
// a regional pack around 47 E, 29 N
const region = { bbox: [46.5, 28.5, 48.5, 30.1], maxZoom: 15 };

/** The Web Mercator tile of a point (standard XYZ). */
function tileAt(lon: number, lat: number, z: number): [number, number, number] {
  const n = 2 ** z;
  const r = (lat * Math.PI) / 180;
  const x = Math.floor(((lon + 180) / 360) * n);
  const y = Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n);
  return [z, x, y];
}

describe('streetCover', () => {
  it('has nothing to draw without packs', () => {
    const cover = streetCover([]);
    expect(cover.maxZoom).toBe(-1);
    expect(cover.has(0, 0, 0)).toBe(false);
  });

  it('draws the world overview four levels past its zoom, everywhere', () => {
    const cover = streetCover([world]);
    expect(cover.maxZoom).toBe(10);
    expect(cover.has(...tileAt(-120, 45, 3))).toBe(true);
    expect(cover.has(...tileAt(-120, 45, 10))).toBe(true);
    expect(cover.has(...tileAt(-120, 45, 11))).toBe(false);
  });

  it('draws a regional pack three levels past its zoom, inside its box only', () => {
    const cover = streetCover([world, region]);
    expect(cover.maxZoom).toBe(18);
    expect(cover.has(...tileAt(47.9, 29.3, 15))).toBe(true);
    expect(cover.has(...tileAt(47.9, 29.3, 18))).toBe(true);
    expect(cover.has(...tileAt(47.9, 29.3, 19))).toBe(false);
    // outside the regional pack only the world overview reaches
    expect(cover.has(...tileAt(10, 50, 10))).toBe(true);
    expect(cover.has(...tileAt(10, 50, 12))).toBe(false);
  });

  it('a regional pack alone still shows from the whole Earth down', () => {
    const cover = streetCover([region]);
    expect(cover.has(0, 0, 0)).toBe(true);
    expect(cover.has(...tileAt(47.9, 29.3, 9))).toBe(true);
    expect(cover.has(...tileAt(10, 50, 9))).toBe(false);
  });

  it('never goes deeper than the limit', () => {
    expect(streetCover([{ bbox: region.bbox, maxZoom: 20 }]).maxZoom).toBe(STREET_MAX_LEVEL);
  });
});
