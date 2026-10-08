import { GeoidPackMeta } from '@aio/schema';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { collectHandlers } from '../notYet';
import { geoidJobEnv, geotiffBbox, gtxBbox, registerGeoidPacksIpc } from './geoid';

/** A GTX grid: big-endian header (lat0, lon0, dlat, dlon, rows, cols), float32 values. */
function gtx(lat0: number, lon0: number, step: number, rows: number, cols: number): Uint8Array {
  const b = new Uint8Array(40 + rows * cols * 4);
  const v = new DataView(b.buffer);
  v.setFloat64(0, lat0, false);
  v.setFloat64(8, lon0, false);
  v.setFloat64(16, step, false);
  v.setFloat64(24, step, false);
  v.setInt32(32, rows, false);
  v.setInt32(36, cols, false);
  for (let i = 0; i < rows * cols; i++) v.setFloat32(40 + i * 4, -25 + i * 0.001, false);
  return b;
}

/** A tiny little-endian classic GeoTIFF header: width, height, pixel scale and tie point. */
function geotiff(west: number, north: number, step: number, w: number, h: number): Uint8Array {
  const entries = 4;
  const ifd = 8;
  const data = ifd + 2 + entries * 12 + 4;
  const b = new Uint8Array(data + 3 * 8 + 6 * 8);
  const v = new DataView(b.buffer);
  b.set([0x49, 0x49]);
  v.setUint16(2, 42, true);
  v.setUint32(4, ifd, true);
  v.setUint16(ifd, entries, true);
  const entry = (k: number, tag: number, type: number, n: number, value: number) => {
    const at = ifd + 2 + k * 12;
    v.setUint16(at, tag, true);
    v.setUint16(at + 2, type, true);
    v.setUint32(at + 4, n, true);
    v.setUint32(at + 8, value, true);
  };
  entry(0, 256, 4, 1, w);
  entry(1, 257, 4, 1, h);
  entry(2, 33550, 12, 3, data);
  entry(3, 33922, 12, 6, data + 24);
  [step, step, 0].forEach((x, i) => {
    v.setFloat64(data + i * 8, x, true);
  });
  [0, 0, 0, west, north, 0].forEach((x, i) => {
    v.setFloat64(data + 24 + i * 8, x, true);
  });
  return b;
}

describe('geoid grid headers', () => {
  it('reads a GTX extent and refuses a size that does not match', () => {
    const b = gtx(24, 46, 0.1, 11, 21);
    expect(gtxBbox(b, b.byteLength)).toEqual([46, 24, 48, 25]);
    expect(() => gtxBbox(b, b.byteLength + 4)).toThrow('not a GTX');
  });

  it('reads a GeoTIFF extent in degrees', () => {
    const [w, s, e, n] = geotiffBbox(geotiff(110, -10, 0.5, 100, 60));
    expect([w, s, e, n]).toEqual([110, -40, 160, -10]);
    expect(() => geotiffBbox(geotiff(300000, 2800000, 1, 10, 10))).toThrow('not in longitude');
    expect(() => geotiffBbox(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toThrow('not a TIFF');
  });
});

describe('geoid packs IPC', () => {
  let data = '';
  let src = '';
  let pack = '';
  let ipc: ReturnType<typeof collectHandlers>;

  beforeAll(async () => {
    data = await mkdtemp(join(tmpdir(), 'geoid-data-'));
    src = await mkdtemp(join(tmpdir(), 'geoid-src-'));
    pack = await mkdtemp(join(tmpdir(), 'geoid-pack-'));
    await writeFile(join(src, 'kuwait.gtx'), gtx(28, 46, 0.05, 41, 61));
    await writeFile(join(src, 'region.tif'), geotiff(50, 27, 0.1, 30, 30));
    await writeFile(join(pack, 'us_nga_egm96_15.tif'), geotiff(-180, 90, 0.25, 1440, 720));
    ipc = collectHandlers((handle) => {
      registerGeoidPacksIpc({
        handle,
        dataRoot: () => data,
        packGeoidDirs: () => Promise.resolve([pack]),
      });
    });
  });

  afterAll(async () => {
    for (const d of [data, src, pack]) await rm(d, { recursive: true, force: true });
  });

  it('imports a GTX with the licence the person states, lists it, and removes it', async () => {
    const r = await ipc.call('geoidPacks:import', {
      path: join(src, 'kuwait.gtx'),
      name: 'Kuwait geoid (synthetic)',
      licence: 'Test licence',
      attribution: 'Synthetic test grid',
      verticalEpsg: 5773,
    });
    if (!r.ok) throw new Error(r.error);
    expect(r.pack).toMatchObject({
      id: 'Kuwait-geoid-synthetic',
      imported: true,
      projFile: 'Kuwait-geoid-synthetic.gtx',
      bbox: [46, 28, 49, 30],
    });
    expect(GeoidPackMeta.safeParse(r.pack).success).toBe(true);
    expect(r.pack.sha256).toMatch(/^[0-9a-f]{64}$/);

    const list = await ipc.call('geoidPacks:list', {});
    if (!list.ok) throw new Error(list.error);
    expect(list.packs.map((p) => p.id)).toEqual(['egm96', 'Kuwait-geoid-synthetic']);
    expect(list.packs[0]).toMatchObject({ verticalEpsg: 5773, licence: 'Public domain' });

    expect(await ipc.call('geoidPacks:remove', { id: 'egm96' })).toMatchObject({ ok: false });
    expect(await ipc.call('geoidPacks:remove', { id: 'Kuwait-geoid-synthetic' })).toEqual({
      ok: true,
    });
    expect(await readdir(join(data, 'packs', 'geoid'))).toEqual([]);
  });

  it('imports a GeoTIFF and gives a second pack of the same name its own id', async () => {
    const req = {
      path: join(src, 'region.tif'),
      name: 'Region',
      licence: 'CC-BY-4.0',
      attribution: 'Synthetic',
    };
    const a = await ipc.call('geoidPacks:import', req);
    const b = await ipc.call('geoidPacks:import', req);
    expect(a.ok && a.pack.id).toBe('Region');
    expect(b.ok && b.pack.id).toBe('Region-2');
    expect(a.ok && a.pack.bbox).toEqual([50, 24, 53, 27]);
  });

  it('refuses files that are not geoid grids', async () => {
    await writeFile(join(src, 'notes.txt'), 'x');
    expect(
      await ipc.call('geoidPacks:import', {
        path: join(src, 'notes.txt'),
        name: 'x',
        licence: 'x',
        attribution: '',
      }),
    ).toMatchObject({ ok: false });
  });

  it('gives pipeline jobs the folder and keeps PROJ offline', () => {
    expect(geoidJobEnv('D:/data')).toEqual({
      QUADRION_GEOID_DIRS: join('D:/data', 'packs', 'geoid'),
      PROJ_NETWORK: 'OFF',
    });
  });
});
