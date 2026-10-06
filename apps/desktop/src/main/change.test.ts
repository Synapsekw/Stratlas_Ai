import { describe, expect, it } from 'vitest';
import { registerChangeIpc } from './change';
import { collectHandlers } from './notYet';

describe('change IPC (C0 stubs)', () => {
  const ipc = collectHandlers((handle) => {
    registerChangeIpc({ handle });
  });

  it('registers every change channel', () => {
    expect(ipc.channels()).toEqual([
      'change:cancel',
      'change:compute',
      'change:list',
      'change:read',
      'change:write',
    ]);
  });

  it('answers a typed "not implemented" that passes the contract', async () => {
    const r = await ipc.call('change:list', { projectId: 'p' });
    expect(r).toMatchObject({ ok: false, code: 'not-implemented' });
    expect(
      await ipc.call('change:compute', {
        jobId: 'j1',
        projectId: 'p',
        from: 'c1',
        to: 'c2',
        kinds: ['issue'],
      }),
    ).toMatchObject({ ok: false, code: 'not-implemented' });
    expect(await ipc.call('change:cancel', { jobId: 'j1' })).toEqual({ ok: false });
  });
});
