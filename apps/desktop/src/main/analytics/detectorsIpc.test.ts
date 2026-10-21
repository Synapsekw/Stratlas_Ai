import {
  VLM_DETECTOR_SCHEMA,
  type IpcChannel,
  type IpcRequest,
  type IpcResponse,
  type VlmDetector,
} from '@aio/schema';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Handler } from '../ipc';
import { registerDetectorsIpc } from './detectorsIpc';
import type { AnalyticsPack } from './pack';

const SHA = 'a'.repeat(64);
const det = (id: string): VlmDetector => ({
  schema: VLM_DETECTOR_SCHEMA,
  id,
  name: `Detector ${id}`,
  version: 1,
  classId: 'defect',
  assetTypes: ['roof'],
  looksLike: 'a dark patch',
  ignore: '',
  question: 'Is this a defect?',
  tiles: { n: 2, overlap: 0.2, sendW: 1344, sendH: 1008 },
  threshold: 0.8,
  tunedOn: { model: 'qwen', modelSha256: SHA },
  author: 'tester',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  source: 'user',
  status: 'experimental',
});

let root: string;
const handlers = new Map<string, unknown>();
const call = <C extends IpcChannel>(c: C, req: IpcRequest<C>): Promise<IpcResponse<C>> =>
  Promise.resolve((handlers.get(c) as Handler<C>)(req) as Promise<IpcResponse<C>>);
const assertWritable = vi.fn<(path: string, op: string) => void>();

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'aio-detectors-ipc-'));
  handlers.clear();
  assertWritable.mockReset();
  const pack = {
    version: '1.0.0',
    dir: join(root, 'pack'),
    manifest: { model: { sha256: SHA } },
  } as unknown as AnalyticsPack;
  registerDetectorsIpc({
    handle: <C extends IpcChannel>(c: C, h: Handler<C>) => {
      handlers.set(c, h);
    },
    pack: () => Promise.resolve(pack),
    userData: () => join(root, 'user'),
    projectDir: () => null,
    chooseOpen: () => Promise.resolve(null),
    chooseSave: () => Promise.resolve(join(root, 'chosen.aiodet')),
    assertWritable,
  });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('detectors ipc', () => {
  it('export checks the destination is writable before writing', async () => {
    await call('detectors:save', { where: 'library', detector: det('roof-dent') });
    const dest = join(root, 'out.aiodet');
    assertWritable.mockImplementation((p) => {
      if (p === dest) throw new Error('refused: real data');
    });
    expect(
      await call('detectors:export', {
        where: 'library',
        id: 'roof-dent',
        includeSamples: true,
        path: dest,
      }),
    ).toEqual({ ok: false, error: 'refused: real data' });
    expect(assertWritable).toHaveBeenCalledWith(dest, 'detector export');
    expect(existsSync(dest)).toBe(false);
  });

  it('export checks a destination picked in the save dialog too', async () => {
    await call('detectors:save', { where: 'library', detector: det('roof-dent') });
    expect(
      await call('detectors:export', { where: 'library', id: 'roof-dent', includeSamples: true }),
    ).toEqual({ ok: true, path: join(root, 'chosen.aiodet') });
    expect(assertWritable).toHaveBeenCalledWith(join(root, 'chosen.aiodet'), 'detector export');
  });
});
