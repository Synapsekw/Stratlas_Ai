import { describe, expect, it } from 'vitest';
import { collectHandlers } from '../notYet';
import { registerInferenceIpc } from './index';

describe('inference IPC (C0 stubs)', () => {
  const ipc = collectHandlers((handle) => {
    registerInferenceIpc({ handle });
  });

  it('registers every inference channel', () => {
    expect(ipc.channels()).toEqual([
      'inference:cancel',
      'inference:importModel',
      'inference:models',
      'inference:removeModel',
      'inference:run',
    ]);
  });

  it('reports no runtime and no models, and refuses a run with a typed error', async () => {
    const models = await ipc.call('inference:models', {});
    expect(models.runtime.available).toBe(false);
    expect(models.models).toEqual([]);
    expect(
      await ipc.call('inference:run', {
        runId: 'r1',
        projectId: 'p',
        model: 'markers',
        items: [{ layer: 'photos', photo: 'p001' }],
        classMap: {},
        minConfidence: 0.25,
      }),
    ).toMatchObject({ ok: false, code: 'not-implemented' });
  });
});
