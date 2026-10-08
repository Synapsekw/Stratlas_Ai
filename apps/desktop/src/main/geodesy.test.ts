import { describe, expect, it } from 'vitest';
import { registerGeodesyIpc } from './geodesy';
import { collectHandlers } from './notYet';

describe('geodesy IPC (G0 stubs)', () => {
  const ipc = collectHandlers((handle) => {
    registerGeodesyIpc({ handle });
  });

  it('registers every geodesy channel', () => {
    expect(ipc.channels()).toEqual([
      'geodesy:applyCalibration',
      'geodesy:readCalibration',
      'geodesy:searchCrs',
    ]);
  });

  it('answers a typed "not implemented" that passes the contract', async () => {
    expect(
      await ipc.call('geodesy:searchCrs', { query: 'UTM 39N', near: [51.5, 25.3], limit: 20 }),
    ).toMatchObject({ ok: false, code: 'not-implemented' });
    expect(await ipc.call('geodesy:readCalibration', { projectId: 'p' })).toMatchObject({
      ok: false,
      code: 'not-implemented',
    });
  });
});
