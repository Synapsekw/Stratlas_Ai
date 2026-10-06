import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createLazPerf } from 'laz-perf';
import { describe, expect, it } from 'vitest';
import {
  loadCopcNode,
  rangeGetter,
  readCopcPage,
  readCopcSource,
  withScalar,
  type Getter,
} from './copc';
import { nodeBounds } from './octree';

// Synthetic fixture from tools/pointcloud/synthetic-cloud.mjs (16 000 points, 5 nodes, EPSG 32639).
const FIXTURE = join(import.meta.dirname, '..', 'test-data', 'synthetic.copc.laz');

async function fileGetter(): Promise<Getter> {
  const buf = new Uint8Array(await readFile(FIXTURE));
  return (begin, end) => Promise.resolve(buf.slice(begin, end));
}

describe('COPC reading', () => {
  it('reads the header, the cube and the root hierarchy page', async () => {
    const src = await readCopcSource(await fileGetter());
    expect(src.pointCount).toBe(16000);
    expect(src.layout.pointDataRecordFormat).toBe(7);
    expect(src.layout.pointDataRecordLength).toBe(36);
    expect(src.cube.max[0] - src.cube.min[0]).toBeCloseTo(2 * 19.996, 3);
    expect(src.spacing).toBeGreaterThan(0);
    expect(src.epsg).toBe(32639);
    const page = await readCopcPage(await fileGetter(), src.rootPage);
    const keys = Object.keys(page.nodes);
    expect(keys).toContain('0-0-0-0');
    const total = Object.values(page.nodes).reduce((s, n) => s + (n?.pointCount ?? 0), 0);
    expect(total).toBe(16000);
  });

  it('decodes every node with laz-perf into the local frame inside its node box', async () => {
    const get = await fileGetter();
    const src = await readCopcSource(get);
    const page = await readCopcPage(get, src.rootPage);
    const laz = await createLazPerf();
    const origin = [500000, 3200040, 0] as const;
    const classes: Record<number, number> = {};
    let points = 0;
    for (const [key, node] of Object.entries(page.nodes)) {
      if (!node) continue;
      const box = nodeBounds(key, src.cube, origin);
      const d = await loadCopcNode(get, node, src.layout, laz, origin, box);
      expect(d.count).toBe(node.pointCount);
      for (let a = 0; a < 3; a++) {
        expect(d.bounds.min[a]).toBeGreaterThanOrEqual((box.min[a] ?? 0) - 1e-6);
        expect(d.bounds.max[a]).toBeLessThanOrEqual((box.max[a] ?? 0) + 1e-6);
      }
      expect(d.rgb).toBeDefined();
      for (const [c, n] of Object.entries(d.classes)) classes[+c] = (classes[+c] ?? 0) + n;
      points += d.count;
    }
    expect(points).toBe(16000);
    expect(Object.keys(classes).map(Number).sort()).toEqual([2, 5, 6]);
    // ground is 60 % of the synthetic points
    expect((classes[2] ?? 0) / points).toBeCloseTo(0.6, 1);
  });

  it('reads byte ranges over HTTP-style fetch, as aio:// serves them', async () => {
    const buf = new Uint8Array(await readFile(FIXTURE));
    const seen: string[] = [];
    const fetchFn = (_url: string, init?: { headers?: Record<string, string> }) => {
      const range = init?.headers?.Range ?? '';
      seen.push(range);
      const m = /bytes=(\d+)-(\d+)/.exec(range);
      const body = m ? buf.slice(Number(m[1]), Number(m[2]) + 1) : buf;
      return Promise.resolve(new Response(body, { status: m ? 206 : 200 }));
    };
    const get = rangeGetter('aio://project/x/c.copc.laz', fetchFn);
    const bytes = await get(0, 4);
    expect(new TextDecoder().decode(bytes)).toBe('LASF');
    expect(seen).toEqual(['bytes=0-3']);
  });

  it('slices a whole-file answer when the server ignores the range', async () => {
    const buf = new Uint8Array(await readFile(FIXTURE));
    const get = rangeGetter('x', () => Promise.resolve(new Response(buf, { status: 200 })));
    expect(new TextDecoder().decode(await get(1, 4))).toBe('ASF');
  });

  it('reports a failed range read clearly', async () => {
    const get = rangeGetter('aio://project/x/missing.copc.laz', () =>
      Promise.resolve(new Response('Not found', { status: 404 })),
    );
    await expect(get(0, 10)).rejects.toThrow(/missing\.copc\.laz.*404/);
  });
});

// Synthetic change cloud from python/scripts/change_fixture.py (change.cloud output, 31 634 points,
// a Distance extra-bytes float): a pipe moved 0.6 m north, a box added, a tank that stayed.
const CHANGE = join(import.meta.dirname, '..', 'test-data', 'change.copc.laz');

describe('a COPC with a Distance field (cloud change)', () => {
  const getter = async (): Promise<Getter> => {
    const buf = new Uint8Array(await readFile(CHANGE));
    return (begin, end) => Promise.resolve(buf.slice(begin, end));
  };

  it('lists its extra-bytes dimensions and places the scalar after the base record', async () => {
    const src = await readCopcSource(await getter());
    expect(src.extraBytes?.map((d) => [d.name, d.dataType])).toEqual([['Distance', 9]]);
    expect(src.layout.scalar).toBeUndefined();
    const s = withScalar(src, 'Distance');
    expect(s.error).toBeUndefined();
    expect(s.source.layout.scalar).toEqual({
      name: 'Distance',
      byteOffset: src.layout.pointDataRecordFormat === 7 ? 36 : 30,
      type: 'f32',
    });
    expect(withScalar(src, 'Missing').source.layout.scalar).toBeUndefined();
  });

  it('decodes the distance of every point: the moved pipe far, the tank and ground near', async () => {
    const get = await getter();
    const src = withScalar(await readCopcSource(get), 'Distance').source;
    const page = await readCopcPage(get, src.rootPage);
    const laz = await createLazPerf();
    const origin = [500000, 3200000, 0] as const;
    const pipe: number[] = [];
    const tank: number[] = [];
    let points = 0;
    for (const [key, node] of Object.entries(page.nodes)) {
      if (!node) continue;
      const box = nodeBounds(key, src.cube, origin);
      const d = await loadCopcNode(get, node, src.layout, laz, origin, box);
      expect(d.scalar).toHaveLength(d.count);
      for (let i = 0; i < d.count; i++) {
        const x = d.quant.offset[0] + d.quant.scale[0] * (d.position[3 * i] ?? 0);
        const y = d.quant.offset[1] + d.quant.scale[1] * (d.position[3 * i + 1] ?? 0);
        const z = d.quant.offset[2] + d.quant.scale[2] * (d.position[3 * i + 2] ?? 0);
        const v = d.scalar?.[i] ?? NaN;
        // the pipe's north side (local z -9.0) moved into empty space
        if (x > 15 && x < 23 && z < -8.9 && z > -9.1 && y > 1.3 && y < 1.7) pipe.push(v);
        if (Math.hypot(x - 8, z + 20) > 2.9 && Math.hypot(x - 8, z + 20) < 3.1 && y > 1 && y < 5)
          tank.push(v);
      }
      points += d.count;
    }
    expect(points).toBe(src.pointCount);
    expect(pipe.length).toBeGreaterThan(20);
    expect(Math.min(...pipe)).toBeGreaterThan(0.3);
    expect(tank.length).toBeGreaterThan(200);
    tank.sort((a, b) => a - b);
    expect(tank[Math.floor(tank.length * 0.99)]).toBeLessThan(0.05);
  });
});
