import { describe, expect, it } from 'vitest';
import { registerModelBuilderIpc } from './modelBuilder';
import { collectHandlers } from './notYet';

describe('model builder IPC (C0 stubs)', () => {
  const ipc = collectHandlers((handle) => {
    registerModelBuilderIpc({ handle });
  });

  it('registers every model channel and the cloud drawings policy', () => {
    expect(ipc.channels()).toEqual([
      'ai:setCloudDrawings',
      'model:build',
      'model:list',
      'model:read',
      'model:write',
    ]);
  });

  it('answers a typed "not implemented" that passes the contract', async () => {
    expect(await ipc.call('model:build', { projectId: 'p', id: 'site' })).toMatchObject({
      ok: false,
      code: 'not-implemented',
    });
    expect(await ipc.call('ai:setCloudDrawings', { projectId: 'p', allow: true })).toMatchObject({
      ok: false,
      code: 'not-implemented',
    });
  });
});
