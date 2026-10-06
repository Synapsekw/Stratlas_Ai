import { describe, expect, it } from 'vitest';
import { registerJournalIpc } from './journal';
import { collectHandlers } from './notYet';

describe('journal IPC (T0 stubs)', () => {
  const ipc = collectHandlers((handle) => {
    registerJournalIpc({ handle });
  });

  it('registers the history, verify, redact and audit export channels', () => {
    expect(ipc.channels()).toEqual([
      'audit:export',
      'journal:history',
      'journal:redact',
      'journal:verify',
    ]);
  });

  it('answers a typed "not implemented" that passes the contract', async () => {
    expect(await ipc.call('journal:verify', { projectId: 'p' })).toMatchObject({
      ok: false,
      code: 'not-implemented',
    });
    expect(
      await ipc.call('journal:history', {
        projectId: 'p',
        filter: { target: { rec: 'issue', id: 'i_f01' } },
        limit: 50,
      }),
    ).toMatchObject({ ok: false, code: 'not-implemented' });
    expect(await ipc.call('audit:export', { projectId: 'p', format: 'audit-csv' })).toMatchObject({
      ok: false,
      code: 'not-implemented',
    });
  });
});
