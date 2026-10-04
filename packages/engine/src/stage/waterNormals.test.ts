import { describe, expect, it } from 'vitest';
import { waterNormalPixels } from './waterNormals';

const decode = (px: Uint8Array, i: number) =>
  [0, 1, 2].map((c) => ((px[i * 4 + c] ?? 0) / 255) * 2 - 1);

describe('waterNormalPixels', () => {
  const size = 64;
  const px = waterNormalPixels(size);

  it('holds unit normals pointing out of the surface', () => {
    for (let i = 0; i < size * size; i += 37) {
      const [x = 0, y = 0, z = 0] = decode(px, i);
      expect(Math.hypot(x, y, z)).toBeCloseTo(1, 1);
      expect(z).toBeGreaterThan(0.3);
    }
  });

  it('tiles without a seam', () => {
    // the jump across the wrap is no larger than between ordinary neighbours
    const diff = (a: number, b: number) => {
      const p = decode(px, a);
      const q = decode(px, b);
      return Math.hypot((p[0] ?? 0) - (q[0] ?? 0), (p[1] ?? 0) - (q[1] ?? 0));
    };
    let inner = 0;
    let wrap = 0;
    for (let y = 0; y < size; y++) {
      inner = Math.max(inner, diff(y * size + size - 2, y * size + size - 1));
      wrap = Math.max(wrap, diff(y * size + size - 1, y * size));
    }
    expect(wrap).toBeLessThan(inner * 1.6 + 0.05);
  });

  it('is deterministic', () => {
    expect(waterNormalPixels(16)).toEqual(waterNormalPixels(16));
  });
});
