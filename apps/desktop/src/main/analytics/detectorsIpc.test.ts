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
/** What the open and save dialogs answer; null is the dialog closed. */
let opened: string | null = null;
let savedAs: string | null = null;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'aio-detectors-ipc-'));
  handlers.clear();
  assertWritable.mockReset();
  opened = null;
  savedAs = join(root, 'chosen.aiodet');
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
    chooseOpen: () => Promise.resolve(opened),
    chooseSave: () => Promise.resolve(savedAs),
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

  it('a closed dialog answers cancelled', async () => {
    expect(await call('detectors:import', { where: 'library' })).toEqual({
      ok: false,
      error: 'Import cancelled.',
      cancelled: true,
    });
    await call('detectors:save', { where: 'library', detector: det('roof-dent') });
    savedAs = null;
    expect(
      await call('detectors:export', { where: 'library', id: 'roof-dent', includeSamples: true }),
    ).toEqual({ ok: false, error: 'Export cancelled.', cancelled: true });
  });

  it('a conflict answers the file picked, so the retry does not ask again', async () => {
    await call('detectors:save', { where: 'library', detector: det('roof-dent') });
    const file = join(root, 'roof-dent.aiodet');
    await call('detectors:export', {
      where: 'library',
      id: 'roof-dent',
      includeSamples: true,
      path: file,
    });
    opened = file;
    expect(await call('detectors:import', { where: 'library' })).toEqual({
      ok: false,
      error: 'A detector "roof-dent" is already here.',
      conflict: { id: 'roof-dent', have: 1, incoming: 1 },
      path: file,
    });
    opened = null;
    expect(
      await call('detectors:import', { where: 'library', path: file, onConflict: 'keep-both' }),
    ).toEqual({ ok: true, id: 'roof-dent-2' });
  });
});
