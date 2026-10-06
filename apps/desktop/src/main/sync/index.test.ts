import { describe, expect, it } from 'vitest';
import { collectHandlers } from '../notYet';
import { registerSyncIpc } from './index';

describe('sync IPC (T0 stubs)', () => {
  const ipc = collectHandlers((handle) => {
    registerSyncIpc({ handle });
  });

  it('registers the team, sync and exchange channels', () => {
    expect(ipc.channels()).toEqual([
      'exchange:export',
      'exchange:import',
      'exchange:plan',
      'exchange:preview',
      'exchange:reply',
      'sync:conflicts',
      'sync:now',
      'sync:quarantine',
      'sync:release',
      'sync:resolve',
      'team:leave',
      'team:share',
      'team:status',
    ]);
  });

  it('answers a typed "not implemented" that passes the contract', async () => {
    expect(
      await ipc.call('team:share', { projectId: 'p', mode: 'hub', hubPath: 'H:/hub' }),
    ).toMatchObject({ ok: false, code: 'not-implemented' });
    expect(
      await ipc.call('exchange:preview', { projectId: 'p', path: 'C:/in/changes.aiosync' }),
    ).toMatchObject({ ok: false, code: 'not-implemented' });
    expect(await ipc.call('sync:conflicts', { projectId: 'p' })).toMatchObject({
      ok: false,
      code: 'not-implemented',
    });
  });
});
