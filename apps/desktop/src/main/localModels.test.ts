import { describe, expect, it } from 'vitest';
import { registerLocalModelsIpc } from './localModels';
import { collectHandlers } from './notYet';

describe('local model IPC (C0 stubs)', () => {
  const ipc = collectHandlers((handle) => {
    registerLocalModelsIpc({ handle });
  });

  it('registers discovery and the probe', () => {
    expect(ipc.channels()).toEqual(['ai:localModels', 'ai:localProbe']);
  });

  it('answers a typed "not implemented" that passes the contract', async () => {
    expect(await ipc.call('ai:localModels', {})).toMatchObject({
      ok: false,
      code: 'not-implemented',
    });
    expect(await ipc.call('ai:localProbe', { model: 'qwen2.5:7b' })).toMatchObject({
      ok: false,
      code: 'not-implemented',
    });
  });
});
