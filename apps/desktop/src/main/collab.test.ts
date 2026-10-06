import { describe, expect, it } from 'vitest';
import { registerCollabIpc } from './collab';
import { collectHandlers } from './notYet';

describe('collab IPC (T0 stubs)', () => {
  const ipc = collectHandlers((handle) => {
    registerCollabIpc({ handle });
  });

  it('registers every collab channel', () => {
    expect(ipc.channels()).toEqual([
      'collab:approve',
      'collab:assign',
      'collab:comment',
      'collab:deleteComment',
      'collab:editComment',
      'collab:policy',
      'collab:read',
      'collab:withdraw',
    ]);
  });

  it('answers a typed "not implemented" that passes the contract', async () => {
    const target = { kind: 'issue', id: 'i_f01' } as const;
    expect(
      await ipc.call('collab:comment', { projectId: 'p', target, text: 'Please check the weld.' }),
    ).toMatchObject({ ok: false, code: 'not-implemented' });
    expect(
      await ipc.call('collab:approve', { projectId: 'p', target, decision: 'approve' }),
    ).toMatchObject({ ok: false, code: 'not-implemented' });
    expect(
      await ipc.call('collab:policy', { projectId: 'p', policy: { approval: { required: 2 } } }),
    ).toMatchObject({ ok: false, code: 'not-implemented' });
  });
});
