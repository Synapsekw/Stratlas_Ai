import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createLazPerf } from 'laz-perf';
import { describe, expect, it } from 'vitest';
import { handleDecode, handleRequest, type DecodeDeps } from './protocol';

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
    // the height sample for the elevation range travels with it
    expect(Array.from(result.heights ?? [])).toEqual([0, 0, 0]);
    expect(transfer).toHaveLength(3);
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

describe('handleRequest (COPC)', () => {
  const fixture = join(import.meta.dirname, '..', 'test-data', 'synthetic.copc.laz');
  const copcDeps = async (): Promise<DecodeDeps> => {
    const buf = new Uint8Array(await readFile(fixture));
    return {
      ...deps(new ArrayBuffer(0)),
      copc: {
        getter: () => (a, b) => Promise.resolve(buf.slice(a, b)),
        lazPerf: () => createLazPerf(),
      },
    };
  };

  it('reads the source and the root page, then decodes a node with transferables', async () => {
    const d = await copcDeps();
    const s = await handleRequest({ id: 1, kind: 'copc-source', url: 'c' }, d);
    if (!('source' in s.result)) throw new Error('expected a source');
    const src = s.result.source;
    const p = await handleRequest({ id: 2, kind: 'copc-page', url: 'c', page: src.rootPage }, d);
    if (!('hierarchy' in p.result)) throw new Error('expected a page');
    const root = p.result.hierarchy.nodes['0-0-0-0'];
    if (!root) throw new Error('no root node');
    const n = await handleRequest(
      {
        id: 3,
        kind: 'copc',
        url: 'c',
        node: root,
        layout: src.layout,
        origin: [500000, 3200040, 0],
        box: { min: [-20, -20, -20], max: [60, 60, 60] },
      },
      d,
    );
    if (!('position' in n.result)) throw new Error('expected points');
    expect(n.result.id).toBe(3);
    expect(n.result.count).toBe(root.pointCount);
    expect(n.result.classification).toBeInstanceOf(Uint8Array);
    expect(n.result.quant?.offset).toEqual([-20, -20, -20]);
    expect(n.transfer.length).toBeGreaterThanOrEqual(3);
  });

  it('answers an error when COPC support is missing', async () => {
    const { result } = await handleRequest(
      { id: 4, kind: 'copc-source', url: 'c' },
      deps(new ArrayBuffer(0)),
    );
    expect(result).toEqual({ id: 4, error: expect.stringMatching(/COPC/) as unknown });
  });
});
