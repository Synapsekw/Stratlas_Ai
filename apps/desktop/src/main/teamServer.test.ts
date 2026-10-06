import { describe, expect, it } from 'vitest';
import { collectHandlers } from './notYet';
import { registerTeamServerIpc } from './teamServer';

describe('team server IPC (T0 stubs)', () => {
  const ipc = collectHandlers((handle) => {
    registerTeamServerIpc({ handle });
  });

  it('registers every server channel', () => {
    expect(ipc.channels()).toEqual(['server:enrol', 'server:forget', 'server:list']);
  });

  it('lists no server and answers a typed "not implemented"', async () => {
    expect(await ipc.call('server:list', {})).toEqual({ servers: [] });
    expect(
      await ipc.call('server:enrol', { url: 'https://team.example.com', code: 'ABCD-1234' }),
    ).toMatchObject({ ok: false, code: 'not-implemented' });
  });
});
