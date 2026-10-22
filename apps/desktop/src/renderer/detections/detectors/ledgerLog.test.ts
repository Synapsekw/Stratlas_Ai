import { type Detection } from '@aio/annotate/detections';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const call = vi.hoisted(() => vi.fn());
vi.mock('../../shell', () => ({ bridge: { call } }));
const cropJpeg = vi.hoisted(() => vi.fn());
vi.mock('./crop', () => ({ cropJpeg }));

import { logMiss, logReview, missPassesFrom, type MissPass } from './ledgerLog';

const SHA = 'a'.repeat(64);
const ctx = { projectId: 'p1', layer: 'photos', photoUrl: 'aio-asset://p1/photos/p001.jpg' };

const draft = (over: Partial<Detection> = {}): Detection => ({
  id: 'vlm-1.json#0',
  pass: 'vlm-1.json',
  source: { kind: 'photo', layer: 'photos', photo: 'p001' },
  size: [4000, 3000],
  geom: { type: 'box', x: 100, y: 200, w: 50, h: 40 },
  classId: 'chimney',
  severity: null,
  uncertain: false,
  note: '',
  confidence: 0.82,
  status: 'accepted',
  origin: {
    kind: 'model',
    producer: 'm (local)',
    detector: { id: 'chimney', version: 3, modelSha256: SHA, threshold: 0.6 },
  },
  ...over,
});

interface Payload {
  entry: Record<string, unknown>;
  cropJpegBase64: string;
}
const payload = (n = 0) => call.mock.calls[n]?.[1] as Payload;

beforeEach(() => {
  call.mockReset();
  call.mockResolvedValue({ ok: true, value: { ok: true } });
  cropJpeg.mockReset();
  cropJpeg.mockResolvedValue('CROP64');
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

describe('logReview', () => {
  it('accepting a detector draft appends one accepted line with score and box', async () => {
    await logReview(draft(), 'accepted', ctx);
    expect(call).toHaveBeenCalledTimes(1);
    expect(call.mock.calls[0]?.[0]).toBe('ledger:append');
    expect(payload().cropJpegBase64).toBe('CROP64');
    expect(payload().entry).toMatchObject({
      detectorId: 'chimney',
      detectorVersion: 3,
      modelSha256: SHA,
      score: 0.82,
      verdict: 'accepted',
      box: [100, 200, 150, 240],
      photo: { project: 'p1', layer: 'photos', id: 'p001' },
      detectionId: 'vlm-1.json#0',
    });
    expect(payload().entry.corrected).toBeUndefined();
    expect(cropJpeg).toHaveBeenCalledWith(ctx.photoUrl, [100, 200, 150, 240]);
  });

  it('rejecting with a reason sends reason and note', async () => {
    await logReview(
      draft({ status: 'rejected', rejectReason: 'not-a-defect', rejectNote: 'a shadow' }),
      'rejected',
      ctx,
    );
    expect(payload().entry).toMatchObject({
      verdict: 'rejected',
      reason: 'not-a-defect',
      note: 'a shadow',
    });
  });

  it('an edited then accepted draft sends box = proposedBox and corrected = the new box', async () => {
    const d = draft({
      proposedBox: [100, 200, 150, 240],
      geom: { type: 'box', x: 90, y: 190, w: 70, h: 60 },
    });
    await logReview(d, 'accepted', ctx);
    expect(payload().entry.box).toEqual([100, 200, 150, 240]);
    expect(payload().entry.corrected).toEqual([90, 190, 160, 250]);
  });

  it('a candidate the detector could not score logs a null score', async () => {
    await logReview(draft({ unscored: true }), 'accepted', ctx);
    expect(payload().entry.score).toBeNull();
  });

  it('a cloud AI draft logs nothing', async () => {
    await logReview(
      draft({
        origin: { kind: 'ai', provider: 'x', model: 'y', promptVersion: '1', runId: 'r' },
      }),
      'accepted',
      ctx,
    );
    await logReview(draft({ origin: { kind: 'human', author: 'me' } }), 'rejected', ctx);
    expect(call).not.toHaveBeenCalled();
  });

  it('a ledger failure is logged and never thrown', async () => {
    call.mockResolvedValue({ ok: true, value: { ok: false, error: 'disk full' } });
    await expect(logReview(draft(), 'accepted', ctx)).resolves.toBeUndefined();
    call.mockRejectedValue(new Error('gone'));
    await expect(logReview(draft(), 'accepted', ctx)).resolves.toBeUndefined();
    cropJpeg.mockRejectedValue(new Error('no photo'));
    await expect(logReview(draft(), 'accepted', ctx)).resolves.toBeUndefined();
    expect(console.warn).toHaveBeenCalledTimes(3);
  });
});

describe('logMiss', () => {
  const human = (over: Partial<Detection> = {}): Detection => {
    const base = draft();
    delete base.confidence;
    return {
      ...base,
      id: 'review.json#0',
      pass: 'review.json',
      status: 'draft',
      origin: { kind: 'human', author: 'me' },
      ...over,
    };
  };
  const pass = (over: Partial<MissPass> = {}): MissPass => ({
    name: 'vlm-1.json',
    assessed: ['p001'],
    detectors: [{ id: 'chimney', version: 3, modelSha256: SHA, classId: 'chimney' }],
    ...over,
  });

  it("a hand-drawn finding of the detector's class on an assessed photo logs a miss", async () => {
    await logMiss(human(), [pass()], ctx);
    expect(call).toHaveBeenCalledTimes(1);
    expect(payload().entry).toMatchObject({
      detectorId: 'chimney',
      detectorVersion: 3,
      modelSha256: SHA,
      score: null,
      verdict: 'miss',
      box: [100, 200, 150, 240],
      photo: { project: 'p1', layer: 'photos', id: 'p001' },
    });
  });

  it('logs one miss per detector of that class', async () => {
    const two = pass({
      detectors: [
        { id: 'chimney', version: 3, modelSha256: SHA, classId: 'chimney' },
        { id: 'chimney-b', version: 1, modelSha256: SHA, classId: 'chimney' },
        { id: 'crack', version: 1, modelSha256: SHA, classId: 'crack' },
      ],
    });
    await logMiss(human(), [two], ctx);
    expect(call).toHaveBeenCalledTimes(2);
    expect(payload(1).entry.detectorId).toBe('chimney-b');
  });

  it('on another class or an unassessed photo logs nothing', async () => {
    await logMiss(human({ classId: 'crack' }), [pass()], ctx);
    await logMiss(
      human({ source: { kind: 'photo', layer: 'photos', photo: 'p002' } }),
      [pass()],
      ctx,
    );
    await logMiss(human(), [pass({ name: 'ai-1.json' })], ctx);
    await logMiss(draft(), [pass()], ctx);
    expect(call).not.toHaveBeenCalled();
  });
});

describe('missPassesFrom', () => {
  const header = {
    assessed: ['p001'],
    detectors: [
      { id: 'chimney', version: 3, classId: 'chimney', name: 'Chimney', threshold: 0.6 },
      { id: 'bolt', version: 1, classId: 'bolt', name: 'Bolt', threshold: 0.5 },
    ],
  };

  it('a detector with zero candidates in the pass still gets a miss line', async () => {
    // only the chimney detector found anything; the bolt detector asked and found nothing
    const found = draft();
    const passes = missPassesFrom([found], new Map([['vlm-1.json', header]]));
    const drawn = {
      ...draft({ classId: 'bolt' }),
      id: 'h',
      pass: 'review.json',
      status: 'draft' as const,
      origin: { kind: 'human' as const, author: 'me' },
    };
    await logMiss(drawn, passes, ctx);
    expect(call).toHaveBeenCalledTimes(1);
    expect(payload().entry).toMatchObject({
      detectorId: 'bolt',
      detectorVersion: 1,
      modelSha256: SHA,
      verdict: 'miss',
    });
  });

  it('falls back to the detectors of the candidates when the pass lists none', () => {
    const passes = missPassesFrom([draft()], new Map([['vlm-1.json', { assessed: ['p001'] }]]));
    expect(passes).toEqual([
      {
        name: 'vlm-1.json',
        assessed: ['p001'],
        detectors: [{ id: 'chimney', version: 3, modelSha256: SHA, classId: 'chimney' }],
      },
    ]);
  });

  it('ignores passes that are not local-detector passes', () => {
    expect(missPassesFrom([], new Map([['ai-1.json', header]]))).toEqual([]);
  });
});
