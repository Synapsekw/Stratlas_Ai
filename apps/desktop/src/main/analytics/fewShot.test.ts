import { VLM_DETECTOR_SCHEMA, type LedgerEntry, type VlmDetector } from '@aio/schema';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  detectorExamples,
  examplesForRun,
  ledgerPicks,
  passUsedExamples,
  PER_VERDICT,
  recordRun,
  runExamples,
} from './fewShot';
import { appendLedger } from './ledger';
import { setLearn } from './thresholds';

const SHA = 'a'.repeat(64);
const OTHER_SHA = 'b'.repeat(64);
const HERE = join(tmpdir(), 'projects', 'site-a');
const FOR = { version: 1, modelSha256: SHA, projectDir: HERE };
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

const det = (over: Partial<VlmDetector> = {}): VlmDetector => ({
  schema: VLM_DETECTOR_SCHEMA,
  id: 'chimney',
  name: 'Chimney',
  version: 1,
  classId: 'chimney',
  assetTypes: ['roof'],
  looksLike: 'a chimney',
  ignore: '',
  question: 'Is this a chimney?',
  tiles: { n: 2, overlap: 0.2, sendW: 1344, sendH: 1008 },
  threshold: 0.8,
  tunedOn: { model: 'qwen', modelSha256: SHA },
  author: 'tester',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  source: 'user',
  status: 'experimental',
  ...over,
});

let n = 0;
const entry = (verdict: LedgerEntry['verdict'], over: Partial<LedgerEntry> = {}): LedgerEntry => ({
  detectorId: 'chimney',
  detectorVersion: 1,
  modelSha256: SHA,
  score: 0.7,
  verdict,
  box: [0, 0, 10, 10],
  photo: { project: 'here', layer: 'l', id: 'i' },
  projectDir: HERE,
  at: '2026-10-21T10:00:00.000Z',
  detectionId: `d${String(++n)}`,
  ...over,
});

let root: string;
let ledgerDir: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'fewshot-'));
  ledgerDir = join(root, 'detector-ledger');
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const crop = (k: number, id = 'chimney') => join(ledgerDir, 'crops', id, `${String(k)}.jpg`);

describe('ledgerPicks', () => {
  it('takes uncorrected accepts as is and rejects that say "not the thing" as is not', () => {
    const picks = ledgerPicks(
      [
        entry('accepted', { crop: '1.jpg' }),
        entry('accepted', { crop: '2.jpg', corrected: [1, 1, 9, 9] }),
        entry('rejected', { crop: '3.jpg', reason: 'looks-like-but-is-not' }),
        entry('rejected', { crop: '4.jpg', reason: 'box-wrong' }),
        entry('rejected', { crop: '5.jpg', reason: 'other' }),
        entry('rejected', { crop: '6.jpg' }),
        entry('rejected', { crop: '7.jpg', reason: 'wrong-class' }),
        entry('miss', { crop: '8.jpg' }),
        entry('rejected', { reason: 'not-a-defect' }), // no crop
      ],
      FOR,
    );
    expect(picks.is.map((e) => e.crop)).toEqual(['1.jpg']);
    expect(picks.isNot.map((e) => e.crop)).toEqual(['7.jpg', '6.jpg', '3.jpg']);
  });

  it('puts the open project folder first, then the newest; only the latest verdict counts', () => {
    const picks = ledgerPicks(
      [
        // the same registry id, another folder: not this project
        entry('rejected', { crop: '1.jpg', projectDir: join(tmpdir(), 'elsewhere', 'site-a') }),
        entry('rejected', { crop: '2.jpg', at: '2026-10-20T00:00:00.000Z' }),
        entry('rejected', { crop: '3.jpg', at: '2026-10-22T00:00:00.000Z' }),
        entry('rejected', { crop: '4.jpg', detectionId: 'same' }),
        entry('accepted', { crop: '5.jpg', detectionId: 'same' }),
      ],
      { ...FOR, projectDir: `${HERE}/` },
    );
    expect(picks.isNot.map((e) => e.crop)).toEqual(['3.jpg', '2.jpg', '1.jpg']);
    expect(picks.is.map((e) => e.crop)).toEqual(['5.jpg']);
  });

  it("only the detector's current version and the run's model", () => {
    const picks = ledgerPicks(
      [
        entry('rejected', { crop: '1.jpg', detectorVersion: 2 }),
        entry('rejected', { crop: '2.jpg', modelSha256: OTHER_SHA }),
        entry('rejected', { crop: '3.jpg' }),
      ],
      FOR,
    );
    expect(picks.isNot.map((e) => e.crop)).toEqual(['3.jpg']);
    const anyModel = ledgerPicks([entry('rejected', { crop: '2.jpg', modelSha256: OTHER_SHA })], {
      ...FOR,
      modelSha256: null,
    });
    expect(anyModel.isNot).toHaveLength(1);
  });
});

describe('detectorExamples', () => {
  it('curated examples first, then ledger crops, at most PER_VERDICT of each', async () => {
    const folder = join(root, 'detectors', 'chimney');
    await mkdir(join(folder, 'examples'), { recursive: true });
    await writeFile(join(folder, 'examples', 'yes.jpg'), jpeg);
    await writeFile(join(folder, 'examples', 'no.jpg'), jpeg);
    for (let i = 0; i < 4; i++) await appendLedger(ledgerDir, entry('accepted'), jpeg);
    for (let i = 0; i < 4; i++)
      await appendLedger(ledgerDir, entry('rejected', { reason: 'not-a-defect' }), jpeg);
    const got = await detectorExamples({
      detector: det({
        examples: [
          { file: 'examples/yes.jpg', verdict: 'is' },
          { file: 'examples/gone.jpg', verdict: 'is-not' },
          { file: 'examples/no.jpg', verdict: 'is-not' },
        ],
      }),
      folder,
      ledgerDir,
      projectDir: HERE,
      modelSha256: SHA,
    });
    expect(PER_VERDICT).toBe(2);
    expect(got).toEqual([
      { file: join(folder, 'examples', 'yes.jpg'), verdict: 'is' },
      // same time stamp: the newest crop number first
      { file: crop(4), verdict: 'is' },
      { file: join(folder, 'examples', 'no.jpg'), verdict: 'is-not' },
      { file: crop(8), verdict: 'is-not' },
    ]);
  });

  it('a rejected crop is an is-not example on the next run; a deleted crop is passed over', async () => {
    await appendLedger(ledgerDir, entry('rejected', { reason: 'looks-like-but-is-not' }), jpeg);
    await appendLedger(ledgerDir, entry('rejected'), jpeg);
    await rm(crop(2));
    const got = await detectorExamples({
      detector: det(),
      folder: null,
      ledgerDir,
      projectDir: null,
      modelSha256: SHA,
    });
    expect(got).toEqual([{ file: crop(1), verdict: 'is-not' }]);
  });

  it('no ledger and no examples is no examples', async () => {
    expect(
      await detectorExamples({
        detector: det(),
        folder: null,
        ledgerDir,
        projectDir: null,
        modelSha256: SHA,
      }),
    ).toEqual([]);
  });
});

describe('runExamples', () => {
  const refs = [
    { where: 'library' as const, id: 'chimney' },
    { where: 'library' as const, id: 'flue' },
  ];
  const ctx = (learnOff: string[] = []) => ({
    ledgerDir,
    projectDir: HERE,
    modelSha256: SHA,
    learnOff: new Set(learnOff),
  });

  it('gives each detector of the run its own list, empty when it cannot be found', async () => {
    await appendLedger(ledgerDir, entry('accepted'), jpeg);
    const got = await runExamples(
      { pack: null, userData: root },
      refs,
      [det(), det({ id: 'flue' })],
      ctx(),
    );
    expect(got).toEqual([[{ file: crop(1), verdict: 'is' }], []]);
  });

  it('a detector with learning off gets none', async () => {
    await appendLedger(ledgerDir, entry('accepted'), jpeg);
    const got = await runExamples(
      { pack: null, userData: root },
      refs,
      [det(), det({ id: 'flue' })],
      ctx(['chimney']),
    );
    expect(got).toEqual([[], []]);
  });
});

describe('the run record', () => {
  it('files a review of a run with examples as one made with examples', async () => {
    await recordRun(ledgerDir, 'run-abc', ['chimney']);
    expect(await passUsedExamples(ledgerDir, 'vlm-run-abc.json', 'chimney')).toBe(true);
    expect(await passUsedExamples(ledgerDir, 'vlm-run-abc.json', 'flue')).toBe(false);
    expect(await passUsedExamples(ledgerDir, 'vlm-run-zzz.json', 'chimney')).toBe(false);
    expect(await passUsedExamples(ledgerDir, 'ai-run-abc.json', 'chimney')).toBeUndefined();
    expect(await passUsedExamples(ledgerDir, undefined, 'chimney')).toBeUndefined();
  });

  it('examplesForRun reads the switches and records only detectors shown examples', async () => {
    await appendLedger(ledgerDir, entry('accepted'), jpeg);
    await appendLedger(ledgerDir, entry('accepted', { detectorId: 'flue' }), jpeg);
    await setLearn(root, 'flue', false);
    const got = await examplesForRun({
      userData: root,
      ledgerDir,
      o: { pack: null, userData: root, projectDir: HERE },
      refs: [
        { where: 'library', id: 'chimney' },
        { where: 'library', id: 'flue' },
      ],
      stored: [det(), det({ id: 'flue' })],
      run: 'run-abc',
      modelSha256: SHA,
    });
    expect(got).toEqual([[{ file: crop(1), verdict: 'is' }], []]);
    const record = JSON.parse(
      await readFile(join(ledgerDir, 'runs', 'run-abc.json'), 'utf8'),
    ) as unknown;
    expect(record).toEqual({ fewShot: ['chimney'] });
  });
});
