import { describe, expect, it } from 'vitest';
import { frameProjection } from './geo';
import type { FrameProjection } from './geo';
import { groundCorners, ringGeometry, siteBbox, type RingGeometry } from './ground';

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

/** Twice the signed area of each triangle seen from above: positive when it faces up. */
function facing(g: RingGeometry): number[] {
  const at = (k: number): [number, number] => [
    g.positions[k * 3] ?? NaN,
    g.positions[k * 3 + 2] ?? NaN,
  ];
  const out: number[] = [];
  for (let i = 0; i < g.indices.length; i += 3) {
    const [px, pz] = at(g.indices[i] ?? -1);
    const [qx, qz] = at(g.indices[i + 1] ?? -1);
    const [rx, rz] = at(g.indices[i + 2] ?? -1);
    out.push((qz - pz) * (rx - px) - (qx - px) * (rz - pz));
  }
  return out;
}
const area = (g: RingGeometry) => facing(g).reduce((a, b) => a + b, 0) / 2;

describe('street ground rings', () => {
  const outer = siteBbox(proj, 2000);
  const inner = siteBbox(proj, 500);

  it('draws the near ring as one quad under the whole picture', () => {
    const g = ringGeometry(outer, null, proj, -0.2);
    expect(g.indices).toEqual([0, 3, 1, 1, 3, 2]);
    expect([...g.positions]).toEqual(
      groundCorners(outer, proj, -0.2)
        .flat()
        .map((v) => Math.fround(v)),
    );
    // top left, top right, bottom right, bottom left of the picture
    [0, 1, 1, 1, 1, 0, 0, 0].forEach((v, i) => {
      expect(g.uvs[i]).toBeCloseTo(v, 6);
    });
    expect(facing(g).every((f) => f > 0)).toBe(true);
    expect(area(g)).toBeGreaterThan(4000 * 4000 * 0.98);
    // the box of a square turned by the grid convergence (1.25 degrees here) is 4.4 % larger
    expect(area(g)).toBeLessThan(4000 * 4000 * 1.05);
  });

  it('draws a further ring as a frame around the ring inside it', () => {
    const g = ringGeometry(outer, inner, proj, -0.2);
    expect(g.positions.length).toBe(8 * 3);
    expect(g.indices.length).toBe(8 * 3);
    // the hole's corners are the inner ring's corners, to the last bit
    expect([...g.positions.slice(12)]).toEqual([
      ...ringGeometry(inner, null, proj, -0.2).positions,
    ]);
    expect(facing(g).every((f) => f > 0)).toBe(true);
    // nothing is drawn twice: the frame is the picture less the hole
    const want = area(ringGeometry(outer, null, proj)) - area(ringGeometry(inner, null, proj));
    expect(Math.abs(area(g) - want) / want).toBeLessThan(1e-6);
    // the hole's top left corner sits three eighths in from the picture's top left
    expect(g.uvs[8]).toBeCloseTo(0.375, 2);
    expect(g.uvs[9]).toBeCloseTo(0.625, 2);
  });

  it('places a vertex in the picture by its Web Mercator latitude', () => {
    const flat: FrameProjection = {
      toLonLat: () => [0, 0],
      toLocal: (lon, lat) => [lon, 0, -lat],
    };
    const g = ringGeometry([10, 0, 11, 60], [10.2, 30, 10.8, 31], flat);
    // inner bottom left: a fifth across, and ln(tan 60) / ln(tan 75) up
    expect(g.uvs[14]).toBeCloseTo(0.2, 6);
    expect(g.uvs[15]).toBeCloseTo(0.41709, 4);
  });

  it('cuts a hole that sticks out to the picture', () => {
    const g = ringGeometry(inner, outer, proj);
    expect(facing(g).every((f) => f >= 0)).toBe(true);
    expect(Math.abs(area(g))).toBeLessThan(1e-3);
  });
});
