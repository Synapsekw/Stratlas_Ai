import { describe, expect, it } from 'vitest';
import {
  blockMean,
  buildTerrain,
  pointInRing,
  readNpyF32,
  sampleHeight,
  type HeightGrid,
} from './terrain';

function npy(h: number, w: number, values: number[]): Uint8Array {
  let header = `{'descr': '<f4', 'fortran_order': False, 'shape': (${h}, ${w}), }`;
  while ((10 + header.length + 1) % 64) header += ' ';
  header += '\n';
  const out = new Uint8Array(10 + header.length + values.length * 4);
  out.set([0x93, ...Buffer.from('NUMPY'), 1, 0], 0);
  new DataView(out.buffer).setUint16(8, header.length, true);
  out.set(Buffer.from(header, 'latin1'), 10);
  out.set(new Uint8Array(Float32Array.from(values).buffer), 10 + header.length);
  return out;
}

/** A lattice whose height is a plane, so interpolation is exact. */
function planeGrid(w: number, h: number, res: number, f: (e: number, n: number) => number) {
  const g: HeightGrid = { w, h, res, x0: 1000, y1: 2000, z: new Float32Array(w * h) };
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) g.z[j * w + i] = f(1000 + (i + 0.5) * res, 2000 - (j + 0.5) * res);
  return g;
}

describe('numpy grids', () => {
  it('reads a little-endian float32 array with its shape', () => {
    const r = readNpyF32(npy(2, 3, [1, 2, 3, 4, NaN, 6]));
    expect(r.h).toBe(2);
    expect(r.w).toBe(3);
    expect([...r.data].map((v) => (Number.isNaN(v) ? null : v))).toEqual([1, 2, 3, 4, null, 6]);
  });

  it('rejects other dtypes', () => {
    const b = npy(1, 1, [1]);
    b.set(Buffer.from('<f8'), 10 + "{'descr': '".length);
    expect(() => readNpyF32(b)).toThrow(/f4/);
  });
});

describe('block mean', () => {
  it('averages valid samples and drops blocks with too few', () => {
    const g: HeightGrid = {
      w: 4,
      h: 2,
      res: 0.1,
      x0: 0,
      y1: 0.2,
      z: Float32Array.from([1, 3, NaN, NaN, 5, 7, NaN, 9]),
    };
    const m = blockMean(g, 2, 0.5);
    expect(m).toMatchObject({ w: 2, h: 1, res: 0.2, x0: 0, y1: 0.2 });
    expect(m.z[0]).toBe(4);
    expect(Number.isNaN(m.z[1])).toBe(true); // only 1 of 4 samples
  });
});

describe('height sampling', () => {
  const g = planeGrid(4, 4, 1, (e, n) => 50 + 0.5 * (e - 1000) - 0.25 * (2000 - n));
  it('interpolates between cell centres', () => {
    expect(sampleHeight(g, 1001.7, 1998.2)).toBeCloseTo(50 + 0.85 - 0.45, 5);
  });
  it('returns null outside the data', () => {
    expect(sampleHeight(g, 999, 1999)).toBeNull();
  });
});

describe('ring test', () => {
  it('tells inside from outside', () => {
    const sq: [number, number][] = [
      [0, 0],
      [2, 0],
      [2, 2],
      [0, 2],
    ];
    expect(pointInRing(1, 1, sq)).toBe(true);
    expect(pointInRing(3, 1, sq)).toBe(false);
  });
});

describe('terrain mesh', () => {
  // 9 x 9 lattice of 0.5 m: 4 x 4 coarse cells of 1 m.
  const f = (e: number, n: number) => 52 + 0.1 * (e - 1000) + Math.sin(e) * 0.3 + Math.cos(n);
  const g = planeGrid(9, 9, 0.5, f);
  // region around coarse cell (1, 1) = lattice vertices 2..4, centre vertex (3, 3) at
  // E 1001.75, N 1998.25
  const ring: [number, number][] = [
    [1001.6, 1998.4],
    [1001.9, 1998.4],
    [1001.9, 1998.1],
    [1001.6, 1998.1],
  ];
  const t = buildTerrain(g, {
    origin: [1002, 1998, 50],
    regions: [{ name: 'P01', ring }],
    regionBuffer: 0,
    uvWindow: { x0: 1000, y0: 1995.5, x1: 1004.5, y1: 2000 },
  });

  it('gives the region its own finely meshed part', () => {
    expect(t.regions.map((r) => r.name)).toEqual(['P01']);
    const p = t.regions[0];
    expect(p?.indices.length).toBe(4 * 2 * 3); // one coarse cell as 2 x 2 fine cells
    expect(p?.positions.length).toBe(9 * 3);
  });

  it('meshes the rest coarsely', () => {
    expect(t.ground.indices.length).toBe((16 - 1) * 2 * 3);
  });

  it('places vertices in the local frame with ortho UVs', () => {
    const p = t.ground;
    // first ground vertex is lattice (0, 0): E 1000.25, N 1999.75
    expect(p.positions[0]).toBeCloseTo(-1.75, 5);
    expect(p.positions[1]).toBeCloseTo(f(1000.25, 1999.75) - 50, 4);
    expect(p.positions[2]).toBeCloseTo(-1.75, 5);
    expect(p.uvs[0]).toBeCloseTo(0.25 / 4.5, 6);
    expect(p.uvs[1]).toBeCloseTo(0.25 / 4.5, 6);
    for (let i = 1; i < p.normals.length; i += 3) expect(p.normals[i]).toBeGreaterThan(0.5);
  });

  it('snaps fine edge midpoints onto the coarse edges (no cracks)', () => {
    const p = t.regions[0];
    if (!p) throw new Error('no region');
    const at = (x: number, z: number) => {
      for (let k = 0; k < p.positions.length; k += 3)
        if (
          Math.abs((p.positions[k] ?? 0) - x) < 1e-4 &&
          Math.abs((p.positions[k + 2] ?? 0) - z) < 1e-4
        )
          return p.positions[k + 1] ?? NaN;
      return NaN;
    };
    // top edge of the cell (lattice row 2): vertices 2, 3, 4 at x -0.75, -0.25, 0.25
    const y2 = at(-0.75, -0.75);
    const y4 = at(0.25, -0.75);
    expect(at(-0.25, -0.75)).toBeCloseTo((y2 + y4) / 2, 5);
    expect(at(-0.25, -0.75)).not.toBeCloseTo(f(1001.75, 1998.75) - 50, 3);
    // the centre vertex keeps its own height
    expect(at(-0.25, -0.25)).toBeCloseTo(f(1001.75, 1998.25) - 50, 4);
  });
});
