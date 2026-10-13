import type { JobRecord, PanoRef } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { finishedPanoStitch, jobForPano, panoStatus, panoStatusText } from './panoModel';

const item = (stitch?: PanoRef['stitch']): PanoRef => ({
  id: 'p01',
  src: { path: 'panoramas/l/p01/pano.jpg' },
  pos: [0, 70, 0],
  headingDeg: 0,
  name: 'Pano 1',
  ...(stitch ? { stitch } : {}),
});
const job = (over: Partial<JobRecord>): JobRecord => ({
  id: '20261013-101500-pano-stitch-a1b2',
  pipeline: 'pano.stitch',
  project: 'D:\\projects\\p1',
  params: { layer: 'l', pano: 'p01' },
  status: 'running',
  progress: 0.42,
  steps: [],
  artifacts: [],
  createdAt: '2026-10-13T10:15:00Z',
  updatedAt: '2026-10-13T10:16:00Z',
  ...over,
});

describe('panoStatus', () => {
  it('is ready for a ready-made panorama', () => {
    expect(panoStatus(item(), undefined)).toEqual({ kind: 'ready' });
  });

  it('follows the live job first, then the item', () => {
    expect(panoStatus(item({ status: 'queued' }), job({}))).toEqual({
      kind: 'stitching',
      pct: 42,
      jobId: job({}).id,
    });
    expect(panoStatus(item({ status: 'queued' }), job({ status: 'done', progress: 1 }))).toEqual({
      kind: 'done',
    });
    expect(
      panoStatus(item({ status: 'queued' }), job({ status: 'failed', error: 'Too few frames' })),
    ).toEqual({ kind: 'failed', message: 'Too few frames' });
    expect(panoStatus(item({ status: 'queued' }), job({ status: 'cancelled' }))).toEqual({
      kind: 'queued',
    });
    expect(panoStatus(item({ status: 'done', run: 'a' }), undefined)).toEqual({ kind: 'done' });
    expect(panoStatus(item({ status: 'failed', error: 'x' }), undefined)).toEqual({
      kind: 'failed',
      message: 'x',
    });
    expect(panoStatus(item({ status: 'running', run: 'a' }), undefined)).toEqual({
      kind: 'queued',
    });
  });

  it('ignores a job older than the item’s run', () => {
    const it2 = item({ status: 'done', run: '20261013-120000-pano-stitch-bbbb' });
    expect(panoStatus(it2, job({ status: 'failed' }))).toEqual({ kind: 'done' });
  });

  it('caps a running job at 99 % and words each state', () => {
    expect(panoStatus(item({ status: 'queued' }), job({ progress: 1 }))).toMatchObject({ pct: 99 });
    expect(panoStatusText({ kind: 'stitching', pct: 42, jobId: 'j' })).toBe('Stitching 42 %');
    expect(panoStatusText({ kind: 'queued' })).toBe('Waiting to stitch');
    expect(panoStatusText({ kind: 'failed', message: 'x' })).toBe('Stitch failed: x');
  });
});

describe('jobForPano and finishedPanoStitch', () => {
  it('finds the newest job of a sphere in the open project', () => {
    const jobs = [
      job({ id: 'b' }),
      job({ id: 'a' }),
      job({ id: 'c', params: { layer: 'l', pano: 'p02' } }),
    ];
    expect(jobForPano(jobs, 'd:/projects/p1/', 'l', 'p01')?.id).toBe('b');
    expect(jobForPano(jobs, 'D:/other', 'l', 'p01')).toBeUndefined();
  });

  it('tells when a stitch just failed, stopped or was cancelled', () => {
    const before = [job({})];
    expect(finishedPanoStitch(before, [job({ status: 'failed' })], 'D:/projects/p1')).toBe(true);
    expect(finishedPanoStitch(before, [job({ status: 'cancelled' })], 'D:/projects/p1')).toBe(true);
    expect(finishedPanoStitch(before, [job({ status: 'done' })], 'D:/projects/p1')).toBe(false);
    expect(
      finishedPanoStitch(
        [job({ status: 'failed' })],
        [job({ status: 'failed' })],
        'D:/projects/p1',
      ),
    ).toBe(false);
  });
});
