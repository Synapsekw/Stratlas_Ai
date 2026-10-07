import type { IpcRequest, IpcResponse } from '@aio/schema';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectHandlers } from '../notYet';
import { packIdFor, rasterPackFile, registerRasterPacksIpc } from './raster';

let data: string;
let started: IpcRequest<'jobs:start'>[];

beforeEach(async () => {
  data = await mkdtemp(join(tmpdir(), 'aio-raster-packs-'));
  started = [];
});
afterEach(async () => {
  await rm(data, { recursive: true, force: true });
});

const ipc = collectHandlers((handle) => {
  registerRasterPacksIpc({
    handle,
    dataRoot: () => data,
    startJob: (req): Promise<IpcResponse<'jobs:start'>> => {
      started.push(req);
      if (!('pipeline' in req)) return Promise.resolve({ ok: false, error: 'resume' });
      return Promise.resolve({
        ok: true,
        job: {
          id: 'packs.imagery-20261007-1015-abc',
          pipeline: req.pipeline,
          project: req.project,
          params: req.params,
          status: 'starting',
          progress: 0,
          steps: [],
          artifacts: [],
          createdAt: '2026-10-07T10:15:00.000Z',
          updatedAt: '2026-10-07T10:15:00.000Z',
        },
      });
    },
  });
});

const meta = (id: string, over: Record<string, unknown> = {}) => ({
  schema: 'aio.raster-pack/1',
  id,
  kind: 'imagery',
  label: `Pack ${id}`,
  bbox: [51, 28.9, 51.1, 29],
  minZoom: 0,
  maxZoom: 16,
  tileSize: 256,
  format: 'webp',
  licence: 'CC0-1.0',
  attribution: 'CC0 test fixture',
  customerLicence: true,
  builtAt: '2026-10-07T10:00:00.000Z',
  ...over,
});

async function install(kind: 'imagery' | 'terrain', id: string, m: object, archive = true) {
  const dir = join(data, 'packs', kind);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${id}.json`), JSON.stringify(m));
  if (archive) await writeFile(join(dir, `${id}.pmtiles`), Buffer.alloc(1234));
}

describe('raster packs IPC (G7)', () => {
  it('registers the imagery and terrain pack channels', () => {
    expect(ipc.channels()).toEqual([
      'imageryPacks:import',
      'imageryPacks:list',
      'imageryPacks:remove',
      'terrainPacks:import',
      'terrainPacks:list',
      'terrainPacks:remove',
    ]);
  });

  it('lists complete packs of each kind with size and how they arrived', async () => {
    expect(await ipc.call('imageryPacks:list', {})).toEqual({ ok: true, packs: [] });
    await install('imagery', 'site', meta('site', { provenance: 'Synthetic' }));
    await install(
      'imagery',
      'world',
      meta('world', { customerLicence: false, source: 'download' }),
    );
    await install('imagery', 'half', meta('half'), false); // no archive yet
    await install('imagery', 'bad', { ...meta('bad'), licence: '' });
    await install('imagery', 'wrongkind', meta('wrongkind', { kind: 'terrain' }));
    await install(
      'terrain',
      'dem',
      meta('dem', {
        kind: 'terrain',
        format: 'png',
        encoding: 'terrarium',
        verticalDatum: 'egm2008',
        customerLicence: false,
      }),
    );
    const imagery = await ipc.call('imageryPacks:list', {});
    expect(imagery.ok && imagery.packs.map((p) => [p.id, p.source, p.sizeBytes])).toEqual([
      ['site', 'import', 1234],
      ['world', 'download', 1234],
    ]);
    expect(imagery.ok && imagery.packs[0]?.provenance).toBe('Synthetic');
    const terrain = await ipc.call('terrainPacks:list', {});
    expect(terrain.ok && terrain.packs.map((p) => [p.id, p.encoding, p.verticalDatum])).toEqual([
      ['dem', 'terrarium', 'egm2008'],
    ]);
  });

  it('imports by starting the pack pipeline into the data folder', async () => {
    await install('imagery', 'site-imagery', meta('site-imagery'));
    const r = await ipc.call('imageryPacks:import', {
      path: 'D:/in/ortho.tif',
      label: 'Site imagery',
      licence: 'Customer licence',
      attribution: '© Vendor 2026',
      customerLicence: true,
    });
    expect(r).toEqual({ ok: true, jobId: 'packs.imagery-20261007-1015-abc' });
    expect(started[0]).toEqual({
      pipeline: 'packs.imagery',
      project: join(data, 'packs', '.jobs'),
      params: {
        src: ['D:/in/ortho.tif'],
        dest: join(data, 'packs', 'imagery'),
        id: 'site-imagery-2',
        label: 'Site imagery',
        licence: 'Customer licence',
        attribution: '© Vendor 2026',
        customerLicence: true,
      },
    });
    const t = await ipc.call('terrainPacks:import', {
      path: 'D:/in/dem.tif',
      id: 'site-dem',
      label: 'Site terrain',
      licence: 'CC0-1.0',
      attribution: 'CC0 test fixture',
      provenance: 'Synthetic DEM',
      verticalDatum: 'egm2008',
    });
    expect(t.ok).toBe(true);
    expect(started[1]).toMatchObject({
      pipeline: 'packs.terrain',
      params: { id: 'site-dem', verticalDatum: 'egm2008', provenance: 'Synthetic DEM' },
    });
    expect(started[1] && 'params' in started[1] && 'customerLicence' in started[1].params).toBe(
      false,
    );
    expect(
      await ipc.call('imageryPacks:import', {
        path: 'D:/x.tif',
        id: 'site-imagery',
        label: 'x',
        licence: 'x',
        attribution: 'x',
        customerLicence: false,
      }),
    ).toMatchObject({
      ok: false,
      error: 'There is already a pack "site-imagery". Remove it first.',
    });
  });

  it('removes both files of a pack', async () => {
    await install(
      'terrain',
      'dem',
      meta('dem', { kind: 'terrain', encoding: 'terrarium', verticalDatum: 'egm96' }),
    );
    expect(await ipc.call('terrainPacks:remove', { id: 'dem' })).toEqual({ ok: true });
    expect(await readdir(join(data, 'packs', 'terrain'))).toEqual([]);
    expect(await ipc.call('terrainPacks:remove', { id: 'dem' })).toMatchObject({ ok: false });
  });

  it('serves only raster pack archive names', () => {
    const packs = join('D:', 'data', 'packs');
    expect(rasterPackFile(packs, ['imagery', 'site.pmtiles'])).toBe(
      join(packs, 'imagery', 'site.pmtiles'),
    );
    expect(rasterPackFile(packs, ['terrain', 'dem-1.pmtiles'])).toBe(
      join(packs, 'terrain', 'dem-1.pmtiles'),
    );
    expect(rasterPackFile(packs, ['imagery', 'site.json'])).toBeNull();
    expect(rasterPackFile(packs, ['imagery', '..%2Fx.pmtiles'])).toBeNull();
    expect(rasterPackFile(packs, ['streets', 'gcc.pmtiles'])).toBeNull();
    expect(rasterPackFile(packs, ['gcc.pmtiles'])).toBeNull();
    expect(rasterPackFile(packs, ['imagery', 'a', 'b.pmtiles'])).toBeNull();
  });

  it('makes pack ids from labels', () => {
    expect(packIdFor('Site imagery (2026)', new Set())).toBe('site-imagery-2026');
    expect(packIdFor('Site', new Set(['site', 'site-2']))).toBe('site-3');
    expect(packIdFor('???', new Set())).toBe('pack');
  });
});
