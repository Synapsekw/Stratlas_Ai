import { describe, expect, it } from 'vitest';
import { collectHandlers } from '../notYet';
import { registerRasterPacksIpc } from './raster';

describe('raster packs IPC (G0 stubs)', () => {
  const ipc = collectHandlers((handle) => {
    registerRasterPacksIpc({ handle });
  });

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

  it('lists no pack yet and answers a typed "not implemented" for the rest', async () => {
    expect(await ipc.call('imageryPacks:list', {})).toEqual({ ok: true, packs: [] });
    expect(await ipc.call('terrainPacks:list', {})).toEqual({ ok: true, packs: [] });
    expect(
      await ipc.call('imageryPacks:import', {
        path: 'D:/in/ortho.tif',
        label: 'Site imagery',
        licence: 'customer',
        attribution: 'Customer imagery',
        customerLicence: true,
      }),
    ).toMatchObject({ ok: false, code: 'not-implemented' });
    expect(
      await ipc.call('terrainPacks:import', {
        path: 'D:/in/dem.tif',
        label: 'Site terrain',
        licence: 'CC0-1.0',
        attribution: 'CC0 test fixture',
        verticalDatum: 'egm2008',
      }),
    ).toMatchObject({ ok: false, code: 'not-implemented' });
    expect(await ipc.call('terrainPacks:remove', { id: 'site-dem' })).toMatchObject({
      ok: false,
      code: 'not-implemented',
    });
  });
});
