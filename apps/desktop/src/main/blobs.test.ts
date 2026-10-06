import { describe, expect, it } from 'vitest';
import { registerBlobsIpc } from './blobs';
import { collectHandlers } from './notYet';

describe('blobs IPC (T0 stubs)', () => {
  const ipc = collectHandlers((handle) => {
    registerBlobsIpc({ handle });
  });

  it('registers every blobs channel', () => {
    expect(ipc.channels()).toEqual([
      'blobs:cancel',
      'blobs:fetch',
      'blobs:index',
      'blobs:policy',
      'blobs:status',
    ]);
  });

  it('answers a typed "not implemented" that passes the contract', async () => {
    expect(await ipc.call('blobs:status', { projectId: 'p' })).toMatchObject({
      ok: false,
      code: 'not-implemented',
    });
    expect(
      await ipc.call('blobs:policy', { projectId: 'p', layer: 'cloud', policy: 'on-demand' }),
    ).toMatchObject({ ok: false, code: 'not-implemented' });
    expect(await ipc.call('blobs:cancel', { jobId: 'j1' })).toEqual({ ok: false });
  });
});
