import { describe, expect, it } from 'vitest';
import { collectHandlers } from './notYet';
import { registerTilesetsIpc } from './tilesets';

describe('tilesets IPC (G0 stubs)', () => {
  const ipc = collectHandlers((handle) => {
    registerTilesetsIpc({ handle });
  });

  it('registers both tileset channels', () => {
    expect(ipc.channels()).toEqual(['tilesets:list', 'tilesets:write']);
  });

  it('answers a typed "not implemented" that passes the contract', async () => {
    expect(await ipc.call('tilesets:list', { projectId: 'p' })).toMatchObject({
      ok: false,
      code: 'not-implemented',
    });
    expect(
      await ipc.call('tilesets:write', {
        projectId: 'p',
        file: { schema: 'aio.tilesets/1', entries: [] },
      }),
    ).toMatchObject({ ok: false, code: 'not-implemented' });
  });
});
