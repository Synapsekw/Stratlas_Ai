import { describe, expect, it } from 'vitest';
import { registerIdentityIpc } from './identity';
import { collectHandlers } from './notYet';

describe('identity IPC (T0 stubs)', () => {
  const ipc = collectHandlers((handle) => {
    registerIdentityIpc({ handle });
  });

  it('registers every identity and members channel', () => {
    expect(ipc.channels()).toEqual([
      'identity:exportCard',
      'identity:get',
      'identity:importCard',
      'identity:set',
      'members:add',
      'members:list',
      'members:remove',
      'members:revokeDevice',
      'members:setRole',
    ]);
  });

  it('answers a typed "not implemented" that passes the contract', async () => {
    expect(await ipc.call('identity:get', {})).toMatchObject({
      ok: false,
      code: 'not-implemented',
    });
    expect(await ipc.call('identity:set', { name: 'Rana Example', initials: 'RE' })).toMatchObject({
      ok: false,
      code: 'not-implemented',
    });
    expect(
      await ipc.call('members:setRole', {
        projectId: 'p',
        actor: `a_${'a'.repeat(26)}`,
        role: 'viewer',
      }),
    ).toMatchObject({ ok: false, code: 'not-implemented' });
  });
});
