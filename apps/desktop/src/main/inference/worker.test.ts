import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OrtSession, OrtTensor } from '../maskAssist';
import { createWorkerCore, type OrtNodeLike } from './worker';

let dir = '';
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aio-worker-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function countingOrt(created: string[]): OrtNodeLike {
  const session: OrtSession = {
    inputNames: ['images'],
    outputNames: ['output0'],
    run: () => Promise.resolve({} as Record<string, OrtTensor>),
  };
  return {
    listSupportedBackends: () => [{ name: 'cpu' }],
    Tensor: class {
      constructor(
        readonly type: 'float32',
        readonly data: Float32Array,
        readonly dims: readonly number[],
      ) {}
    },
    InferenceSession: {
      create(path) {
        created.push(String(path));
        return Promise.resolve(session);
      },
    },
  };
}

describe('the worker session cache', () => {
  it('keeps a session for the same file and loads a model replaced in place again', async () => {
    const created: string[] = [];
    const core = createWorkerCore(() => Promise.resolve(countingOrt(created)), 'win32');
    const model = join(dir, 'model.onnx');
    await writeFile(model, 'weights v1');
    let id = 0;
    const open = () => core.handle({ type: 'open', id: ++id, path: model, provider: 'cpu' });
    expect(await open()).toMatchObject({ type: 'result' });
    await open();
    expect(created).toHaveLength(1);
    // a Road defects update: new files at the same path
    await rm(model);
    await writeFile(model, 'weights v2, longer');
    const r = await open();
    expect(r).toMatchObject({ type: 'result' });
    expect(created).toHaveLength(2);
  });
});
