import { describe, expect, it } from 'vitest';
import { collectHandlers } from './notYet';
import { registerPhotogrammetryIpc } from './photogrammetry';

describe('photogrammetry IPC (G0 stubs)', () => {
  const ipc = collectHandlers((handle) => {
    registerPhotogrammetryIpc({ handle });
  });

  it('registers every photo channel', () => {
    expect(ipc.channels()).toEqual([
      'photo:applyPoses',
      'photo:cleanWork',
      'photo:estimate',
      'photo:probe',
      'photo:readGcp',
      'photo:readRun',
      'photo:runs',
      'photo:writeGcp',
    ]);
  });

  it('answers a typed "not implemented" that passes the contract', async () => {
    expect(await ipc.call('photo:probe', {})).toMatchObject({
      ok: false,
      code: 'not-implemented',
    });
    expect(
      await ipc.call('photo:estimate', {
        photos: { layer: 'photos' },
        preset: 'standard',
        products: ['ortho'],
      }),
    ).toMatchObject({ ok: false, code: 'not-implemented' });
    expect(
      await ipc.call('photo:applyPoses', {
        projectId: 'p',
        run: '20261007-0900',
        layer: 'photos',
        apply: false,
      }),
    ).toMatchObject({ ok: false, code: 'not-implemented' });
  });
});
