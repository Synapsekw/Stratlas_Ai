import {
  VLM_DETECTOR_SCHEMA,
  type IpcChannel,
  type IpcRequest,
  type IpcResponse,
  type LedgerEntry,
  type VlmDetector,
} from '@aio/schema';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Handler } from '../ipc';
import { registerDetectorsIpc } from './detectorsIpc';
import { ledgerDir, registerLedgerIpc } from './ledgerIpc';
import type { AnalyticsPack } from './pack';

const SHA = 'a'.repeat(64);

const det = (id: string, version = 1): VlmDetector => ({
  schema: VLM_DETECTOR_SCHEMA,
  id,
  name: `Detector ${id}`,
  version,
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

const entry: LedgerEntry = {
  detectorId: 'chimney',
  detectorVersion: 1,
  modelSha256: SHA,
  score: 0.9,
  verdict: 'accepted',
  box: [0, 0, 10, 10],
  photo: { project: 'p', layer: 'l', id: 'i' },
  at: '2026-10-21T10:00:00.000Z',
};

let root: string;
let userData: string;
const handlers = new Map<string, unknown>();
const call = <C extends IpcChannel>(c: C, req: IpcRequest<C>): Promise<IpcResponse<C>> =>
  Promise.resolve((handlers.get(c) as Handler<C>)(req) as Promise<IpcResponse<C>>);

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'aio-ledger-ipc-'));
  userData = join(root, 'user');
  handlers.clear();
  const handle = <C extends IpcChannel>(c: C, h: Handler<C>) => {
    handlers.set(c, h);
  };
  const pack = {
    version: '1.0.0',
    dir: join(root, 'pack'),
    manifest: { model: { sha256: SHA } },
  } as unknown as AnalyticsPack;
  registerLedgerIpc({ handle, userData });
  registerDetectorsIpc({
    handle,
    pack: () => Promise.resolve(pack),
    userData: () => userData,
    projectDir: () => null,
    chooseOpen: () => Promise.resolve(null),
    chooseSave: () => Promise.resolve(null),
  });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('ledger ipc', () => {
  it('keeps the ledger outside the detector library', () => {
    expect(ledgerDir(userData)).toBe(join(userData, 'detector-ledger'));
  });

  it('a library detector named ledger can be saved, imported and removed without touching the ledger', async () => {
    expect(
      await call('ledger:append', {
        entry,
        cropJpegBase64: Buffer.from([1, 2]).toString('base64'),
      }),
    ).toEqual({ ok: true });
    const stats = await call('ledger:stats', { detectorId: 'chimney' });
    expect(stats.accepted).toBe(1);

    expect(await call('detectors:save', { where: 'library', detector: det('ledger') })).toEqual({
      ok: true,
      version: 1,
    });
    const file = join(root, 'ledger.aiodet');
    expect(
      await call('detectors:export', {
        where: 'library',
        id: 'ledger',
        includeSamples: true,
        path: file,
      }),
    ).toMatchObject({ ok: true });
    expect(
      await call('detectors:import', { path: file, where: 'library', onConflict: 'update' }),
    ).toEqual({ ok: true, id: 'ledger' });
    expect(await call('detectors:remove', { where: 'library', id: 'ledger' })).toEqual({
      ok: true,
    });

    expect(await call('ledger:stats', { detectorId: 'chimney' })).toEqual(stats);
    expect(await readdir(join(ledgerDir(userData), 'crops', 'chimney'))).toEqual(['1.jpg']);
  });

  it('ledger:clear refuses a bad id and clears a good one', async () => {
    const crop = Buffer.from([1, 2]).toString('base64');
    await call('ledger:append', { entry, cropJpegBase64: crop });
    await call('ledger:append', { entry: { ...entry, detectorId: 'flue' }, cropJpegBase64: crop });

    const bad = await call('ledger:clear', { detectorId: '../chimney' });
    expect(bad.ok).toBe(false);
    expect((await call('ledger:stats', { detectorId: 'chimney' })).accepted).toBe(1);

    expect(await call('ledger:clear', { detectorId: 'chimney' })).toEqual({ ok: true });
    expect(await call('ledger:stats', { detectorId: 'chimney' })).toEqual({
      accepted: 0,
      rejected: 0,
      misses: 0,
      suggestedThreshold: null,
    });
    expect(existsSync(join(ledgerDir(userData), 'crops', 'chimney'))).toBe(false);
    expect((await call('ledger:stats', { detectorId: 'flue' })).accepted).toBe(1);
  });

  it('ledger:applyThreshold needs a suggestion, then lists the detector with it', async () => {
    const crop = Buffer.from([1, 2]).toString('base64');
    await call('detectors:save', { where: 'library', detector: det('chimney') });
    expect(await call('ledger:applyThreshold', { detectorId: 'chimney' })).toMatchObject({
      ok: false,
    });
    expect(await call('ledger:applyThreshold', { detectorId: '../x' })).toMatchObject({
      ok: false,
    });
    // 12 right at 0.9 and 8 wrong at 0.6: the suggestion is above 0.6
    for (let i = 0; i < 20; i++) {
      const wrong = i < 8;
      await call('ledger:append', {
        entry: {
          ...entry,
          detectionId: `d${String(i)}`,
          score: wrong ? 0.6 : 0.9,
          verdict: wrong ? 'rejected' : 'accepted',
        },
        cropJpegBase64: crop,
      });
    }
    const suggested = (await call('ledger:stats', { detectorId: 'chimney' })).suggestedThreshold;
    expect(suggested).not.toBeNull();
    const before = await call('detectors:list', {});
    expect(before.items.find((i) => i.detector.id === 'chimney')?.detector.threshold).toBe(0.8);

    expect(await call('ledger:applyThreshold', { detectorId: 'chimney' })).toEqual({
      ok: true,
      threshold: suggested,
    });
    const after = await call('detectors:list', {});
    expect(after.items.find((i) => i.detector.id === 'chimney')?.detector.threshold).toBe(
      suggested,
    );
    // clearing the review history keeps the applied threshold
    await call('ledger:clear', { detectorId: 'chimney' });
    const cleared = await call('detectors:list', {});
    expect(cleared.items.find((i) => i.detector.id === 'chimney')?.detector.threshold).toBe(
      suggested,
    );
  });
});
