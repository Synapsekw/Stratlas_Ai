import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createLazPerf } from 'laz-perf';
import { describe, expect, it } from 'vitest';
import { loadCopcNode, rangeGetter, readCopcPage, readCopcSource, type Getter } from './copc';
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
