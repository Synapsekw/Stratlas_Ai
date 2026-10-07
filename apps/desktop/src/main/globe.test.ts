import { describe, expect, it } from 'vitest';
import { registerGlobeIpc } from './globe';
import { collectHandlers } from './notYet';

describe('globe IPC (G0 stubs)', () => {
  const ipc = collectHandlers((handle) => {
    registerGlobeIpc({ handle });
  });

  it('registers every globe channel', () => {
    expect(ipc.channels()).toEqual([
      'globe:getSettings',
      'globe:packs',
      'globe:setSettings',
      'globe:sites',
    ]);
  });

  it('knows no raster pack, reads the default settings, and answers "not implemented"', async () => {
    expect(await ipc.call('globe:packs', {})).toEqual({ ok: true, imagery: [], terrain: [] });
    expect(await ipc.call('globe:getSettings', {})).toMatchObject({
      ok: true,
      settings: { schema: 'aio.globe-settings/1', imagery: 'auto', terrain: 'auto' },
    });
    expect(await ipc.call('globe:sites', {})).toMatchObject({
      ok: false,
      code: 'not-implemented',
    });
    expect(
      await ipc.call('globe:setSettings', {
        settings: { schema: 'aio.globe-settings/1', showIssues: false },
      }),
    ).toMatchObject({ ok: false, code: 'not-implemented' });
  });
});
