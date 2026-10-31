import {
  VLM_DETECTOR_SCHEMA,
  type IpcChannel,
  type IpcRequest,
  type IpcResponse,
  type LedgerEntry,
  type VlmDetector,
} from '@aio/schema';
import { en } from '@aio/ui/i18n/en';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Handler } from '../ipc';
import { registerDetectorsIpc } from './detectorsIpc';
import { ledgerDir, registerLedgerIpc } from './ledgerIpc';
import { readLearning } from './thresholds';
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
let tools: string | null = '0.33.0';
const warnings: string[] = [];
const PROJECT = join(tmpdir(), 'projects', 'site-a');
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
  tools = '0.33.0';
  warnings.length = 0;
  registerLedgerIpc({
    handle,
    userData,
    projectDir: (id) => (id === 'p' ? PROJECT : null),
    pipelinePack: () => Promise.resolve(tools),
    warn: (w) => warnings.push(w),
  });
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
      scored: 0,
      suggestedThreshold: null,
      suggestedFrom: null,
      applied: null,
      learn: true,
    });
    expect(existsSync(join(ledgerDir(userData), 'crops', 'chimney'))).toBe(false);
    expect((await call('ledger:stats', { detectorId: 'flue' })).accepted).toBe(1);
  });

  const crop = Buffer.from([1, 2]).toString('base64');
  /** 20 reviews: 12 right at 0.9 and 8 wrong at 0.6. */
  async function twentyReviews(over: Partial<LedgerEntry> = {}) {
    for (let i = 0; i < 20; i++) {
      const wrong = i < 8;
      await call('ledger:append', {
        entry: {
          ...entry,
          detectionId: `d${String(i)}`,
          score: wrong ? 0.6 : 0.9,
          verdict: wrong ? 'rejected' : 'accepted',
          ...over,
        },
        cropJpegBase64: crop,
      });
    }
  }
  const listed = async (id: string) =>
    (await call('detectors:list', {})).items.find((i) => i.detector.id === id)?.detector.threshold;

  it('ledger:append stamps the project folder and the run examples, never the window', async () => {
    await mkdir(join(ledgerDir(userData), 'runs'), { recursive: true });
    await writeFile(
      join(ledgerDir(userData), 'runs', 'run-abc.json'),
      JSON.stringify({ fewShot: ['chimney'] }),
    );
    await call('ledger:append', {
      entry: { ...entry, pass: 'vlm-run-abc.json', projectDir: 'C:/forged', fewShot: false },
      cropJpegBase64: crop,
    });
    await call('ledger:append', {
      entry: { ...entry, detectionId: 'x', photo: { ...entry.photo, project: 'gone' } },
      cropJpegBase64: crop,
    });
    const lines = (await readFile(join(ledgerDir(userData), 'chimney.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as LedgerEntry);
    expect(lines[0]).toMatchObject({ fewShot: true, projectDir: PROJECT });
    expect(lines[1]?.fewShot).toBeUndefined();
    expect(lines[1]?.projectDir).toBeUndefined();
  });

  it('stats count scored reviews toward 20, and suggest only from 20', async () => {
    await call('ledger:append', { entry: { ...entry, score: null }, cropJpegBase64: crop });
    const s = await call('ledger:stats', { detectorId: 'chimney' });
    expect(s).toMatchObject({ accepted: 1, scored: 0, suggestedThreshold: null, learn: true });
    await twentyReviews();
    const t = await call('ledger:stats', { detectorId: 'chimney' });
    expect(t.scored).toBe(20);
    expect(t.suggestedThreshold).not.toBeNull();
  });

  it('the next run has examples: the suggestion falls back to all reviews and says so', async () => {
    await twentyReviews();
    expect((await call('ledger:stats', { detectorId: 'chimney' })).suggestedFrom).toBe('all');
    // processing tools that take no examples: the next run is like the reviewed ones
    tools = '0.28.0';
    expect((await call('ledger:stats', { detectorId: 'chimney' })).suggestedFrom).toBe('same');
  });

  it('apply needs a suggestion, lists the detector with it, and reset undoes it', async () => {
    await call('detectors:save', { where: 'library', detector: det('chimney') });
    expect(await call('ledger:applyThreshold', { detectorId: 'chimney' })).toEqual({
      ok: false,
      error: en['detect.learn.err.none'],
    });
    expect(await call('ledger:applyThreshold', { detectorId: '../x' })).toEqual({
      ok: false,
      error: en['detect.learn.err.badId'],
    });
    await twentyReviews();
    const suggested = (await call('ledger:stats', { detectorId: 'chimney' })).suggestedThreshold;
    expect(suggested).not.toBeNull();
    expect(await listed('chimney')).toBe(0.8);

    expect(await call('ledger:applyThreshold', { detectorId: 'chimney' })).toEqual({
      ok: true,
      threshold: suggested,
    });
    expect(await listed('chimney')).toBe(suggested);
    expect((await call('ledger:stats', { detectorId: 'chimney' })).applied).toBe(suggested);

    expect(await call('ledger:resetThreshold', { detectorId: 'chimney' })).toEqual({ ok: true });
    expect(await listed('chimney')).toBe(0.8);
    expect((await call('ledger:stats', { detectorId: 'chimney' })).applied).toBeNull();
  });

  it('clearing the reviews or removing the detector drops its applied threshold', async () => {
    await call('detectors:save', { where: 'library', detector: det('chimney') });
    await twentyReviews();
    await call('ledger:applyThreshold', { detectorId: 'chimney' });
    await call('ledger:clear', { detectorId: 'chimney' });
    expect(await listed('chimney')).toBe(0.8);
    expect((await call('ledger:stats', { detectorId: 'chimney' })).applied).toBeNull();

    await twentyReviews();
    await call('ledger:applyThreshold', { detectorId: 'chimney' });
    await call('ledger:setLearn', { detectorId: 'chimney', on: false });
    await call('detectors:remove', { where: 'library', id: 'chimney' });
    expect(await readLearning(userData)).toEqual({ thresholds: {}, learnOff: [] });
  });

  it('learning off: no suggestion, and apply is refused', async () => {
    await twentyReviews();
    expect(await call('ledger:setLearn', { detectorId: 'chimney', on: false })).toEqual({
      ok: true,
    });
    const s = await call('ledger:stats', { detectorId: 'chimney' });
    expect(s).toMatchObject({ learn: false, suggestedThreshold: null, scored: 20 });
    expect(await call('ledger:applyThreshold', { detectorId: 'chimney' })).toEqual({
      ok: false,
      error: en['detect.learn.err.off'],
    });
    await call('ledger:setLearn', { detectorId: 'chimney', on: true });
    expect((await call('ledger:stats', { detectorId: 'chimney' })).learn).toBe(true);
  });
});
