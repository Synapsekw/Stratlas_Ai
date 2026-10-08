import { describe, expect, it } from 'vitest';
import { collectHandlers } from '../notYet';
import { registerGeoidPacksIpc } from './geoid';

describe('geoid packs IPC (G0 stubs)', () => {
  const ipc = collectHandlers((handle) => {
    registerGeoidPacksIpc({ handle });
  });

  it('registers the geoid pack channels', () => {
    expect(ipc.channels()).toEqual(['geoidPacks:import', 'geoidPacks:list', 'geoidPacks:remove']);
  });

  it('answers a typed "not implemented" that passes the contract', async () => {
    expect(await ipc.call('geoidPacks:list', {})).toMatchObject({
      ok: false,
      code: 'not-implemented',
    });
    expect(
      await ipc.call('geoidPacks:import', {
        path: 'D:/in/geoid.tif',
        name: 'Regional geoid',
        licence: 'CC-BY-4.0',
        attribution: 'Test fixture',
        verticalEpsg: 5773,
      }),
    ).toMatchObject({ ok: false, code: 'not-implemented' });
    expect(await ipc.call('geoidPacks:remove', { id: 'regional-geoid' })).toMatchObject({
      ok: false,
      code: 'not-implemented',
    });
  });
});
