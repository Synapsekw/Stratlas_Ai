import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DRAWN_CENTRELINE, writeCentreline } from './centreline';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'aio-centreline-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('writeCentreline', () => {
  it('saves the drawn line as GeoJSON for the road builder and keeps the previous one', async () => {
    const a = await writeCentreline(root, [
      [48.1, 29.3],
      [48.1, 29.3],
      [48.2, 29.31],
    ]);
    expect(a).toEqual({ ok: true, path: DRAWN_CENTRELINE });
    const doc = JSON.parse(
      await readFile(join(root, 'road', 'centreline-drawn.geojson'), 'utf8'),
    ) as {
      features: { geometry: { type: string; coordinates: number[][] } }[];
    };
    expect(doc.features[0]?.geometry).toEqual({
      type: 'LineString',
      coordinates: [
        [48.1, 29.3],
        [48.2, 29.31],
      ],
    });
    await writeCentreline(root, [
      [48, 29],
      [48.5, 29.5],
    ]);
    const bak = await readFile(join(root, 'road', 'centreline-drawn.geojson.bak'), 'utf8');
    expect(bak).toContain('48.2');
  });

  it('needs two different points', async () => {
    const r = await writeCentreline(root, [
      [48, 29],
      [48, 29],
    ]);
    expect(r.ok).toBe(false);
  });
});
