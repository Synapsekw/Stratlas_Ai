import { describe, expect, it } from 'vitest';
import { frameProjection } from './geo';
import { groundCorners, siteBbox } from './ground';

const proj = frameProjection({ epsg: 32639 }, [245747.13, 3179641.87, 0]);
if (!proj) throw new Error('projection');

describe('3D ground quad', () => {
  it('covers the site square in lon/lat', () => {
    const [w, s, e, n] = siteBbox(proj, 2000);
    expect(w).toBeLessThan(48.39709);
    expect(e).toBeGreaterThan(48.39709);
    expect(s).toBeLessThan(28.7191);
    expect(n).toBeGreaterThan(28.7191);
    // About 4 km across (plus a little for grid convergence).
    expect((e - w) * 111_320 * Math.cos((28.72 * Math.PI) / 180)).toBeGreaterThan(4000);
    expect((e - w) * 111_320 * Math.cos((28.72 * Math.PI) / 180)).toBeLessThan(4200);
  });

  it('maps the image corners back into the local frame around the origin', () => {
    const [tl, tr, br, bl] = groundCorners(siteBbox(proj, 2000), proj, -0.5);
    // North is -Z, east is +X.
    expect(tl[0]).toBeLessThan(-1990);
    expect(tl[2]).toBeLessThan(-1990);
    expect(tr[0]).toBeGreaterThan(1990);
    expect(br[2]).toBeGreaterThan(1990);
    expect(bl[0]).toBeLessThan(-1990);
    for (const c of [tl, tr, br, bl]) expect(c[1]).toBe(-0.5);
  });
});
