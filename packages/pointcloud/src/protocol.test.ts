import { describe, expect, it } from 'vitest';
import { handleDecode, type DecodeDeps } from './protocol';

function kit(n: number): ArrayBuffer {
  const buf = new ArrayBuffer(n * 7);
  const v = new DataView(buf);
  for (let k = 0; k < n; k++) {
    v.setInt16(k * 6, k * 1000, true);
    v.setUint8(n * 6 + k, k);
  }
  return buf;
}

const deps = (body: ArrayBuffer, rgba?: { data: Uint8ClampedArray; w: number; h: number }) =>
  ({
    fetchBytes: (url: string) =>
      url === 'bad' ? Promise.reject(new Error('404')) : Promise.resolve(body),
    decodeImage: () =>
      rgba ? Promise.resolve(rgba) : Promise.reject(new Error('no image decoder')),
  }) satisfies DecodeDeps;

describe('handleDecode', () => {
  it('decodes a kit file into quantised positions with transferables', async () => {
    const { result, transfer } = await handleDecode(
      { id: 7, kind: 'kit', url: 'x', scale: 0.001 },
      deps(kit(3)),
    );
    if (!('position' in result)) throw new Error('expected a cloud');
    expect(result.id).toBe(7);
    expect(result.count).toBe(3);
    expect(Array.from(result.position)).toEqual([0, 0, 0, 1000, 0, 0, 2000, 0, 0]);
    expect(Array.from(result.intensity ?? [])).toEqual([0, 1, 2]);
    expect(result.bounds.max[0]).toBe(2);
    expect(transfer).toHaveLength(2);
  });

  it('decodes a png chunk through the image decoder', async () => {
    // one point u=(1,2,3), rgb (9,8,7): stream 1,0,2,0,3,0,9,8,7 over three pixels
    const data = new Uint8ClampedArray([1, 0, 2, 255, 0, 3, 0, 255, 9, 8, 7, 255]);
    const { result } = await handleDecode(
      {
        id: 1,
        kind: 'png',
        url: 'c.png',
        points: 1,
        quant: { offset: [0, 0, 0], scale: [1, 1, 1] },
      },
      deps(new ArrayBuffer(0), { data, w: 3, h: 1 }),
    );
    if (!('position' in result)) throw new Error('expected a cloud');
    expect(Array.from(result.position)).toEqual([1, 2, 3]);
    expect(Array.from(result.rgb ?? [])).toEqual([9, 8, 7]);
  });

  it('reports errors as messages rather than throwing', async () => {
    const { result } = await handleDecode(
      { id: 2, kind: 'kit', url: 'bad', scale: 0.001 },
      deps(new ArrayBuffer(0)),
    );
    expect(result).toEqual({ id: 2, error: '404' });
  });
});
