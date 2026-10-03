import { describe, expect, it } from 'vitest';
import { parsePngCloudIndex } from './pngIndex';

describe('parsePngCloudIndex', () => {
  it('reads an aio.pngcloud/1 index; quantisation defaults to the chunk bounds', () => {
    const idx = parsePngCloudIndex({
      schema: 'aio.pngcloud/1',
      bounds: { min: [0, 0, 0], max: [100, 10, 100] },
      spacing: 0.4,
      chunks: [
        {
          file: 'clouds/c000.png',
          points: 10,
          bounds: { min: [0, 0, 0], max: [65535, 0, 0] },
          lod: 0,
        },
        {
          file: 'clouds/c001.png',
          points: 5,
          bounds: { min: [0, 0, 0], max: [10, 10, 10] },
          lod: 1,
          quant: { offset: [1, 2, 3], scale: [0.01, 0.01, 0.01] },
        },
      ],
    });
    expect(idx.legacy).toBe(false);
    expect(idx.spacing).toBe(0.4);
    expect(idx.chunks).toHaveLength(2);
    expect(idx.chunks[0]?.quant.scale).toEqual([1, 0, 0]);
    expect(idx.chunks[1]?.quant.offset).toEqual([1, 2, 3]);
    expect(idx.chunks[1]?.id).toBe('clouds/c001.png');
  });

  it('reads the Al-Zour artifact pc.json (levels of {f,n,o,q,b})', () => {
    const idx = parsePngCloudIndex({
      levels: [
        [{ f: 'pc/l0.png', n: 1000, o: [-1300, -5, -600], q: 0.05 }],
        [
          {
            f: 'pc/l1_0.png',
            n: 200,
            o: [-1300, -5, -600],
            q: 0.02,
            b: [-1300, -600, -1000, -300],
          },
          { f: 'pc/l1_1.png', n: 300, o: [-1000, -5, -600], q: 0.02, b: [-1000, -600, -700, -300] },
        ],
      ],
      urls: { 'pc/l1_1.png': '_blob/abc' },
    });
    expect(idx.legacy).toBe(true);
    expect(idx.chunks.map((c) => c.lod)).toEqual([0, 1, 1]);
    const c1 = idx.chunks[1];
    expect(c1?.quant).toEqual({ offset: [-1300, -5, -600], scale: [0.02, 0.02, 0.02] });
    expect(c1?.bounds.min).toEqual([-1300, -5, -600]);
    expect(c1?.bounds.max[0]).toBe(-1000);
    expect(c1?.bounds.max[2]).toBe(-300);
    expect(idx.chunks[2]?.file).toBe('_blob/abc');
    // level 0 has no b: bounds come from the quantisation box
    expect(idx.chunks[0]?.bounds.max[0]).toBeCloseTo(-1300 + 65535 * 0.05);
    expect(idx.bounds.min[0]).toBe(-1300);
  });

  it('rejects anything else with a readable message', () => {
    expect(() => parsePngCloudIndex({ hello: 1 })).toThrow('not a png-packed cloud index');
    expect(() => parsePngCloudIndex({ schema: 'aio.pngcloud/1', chunks: [{ file: 1 }] })).toThrow(
      'chunk 0',
    );
  });
});
