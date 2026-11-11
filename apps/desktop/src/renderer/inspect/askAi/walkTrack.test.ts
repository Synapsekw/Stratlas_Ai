import type { IpcRequest, JobRecord } from '@aio/schema';
import { describe, expect, it, vi } from 'vitest';
import type { DetectItem } from '../../detections/convert';
import { modelPassName, runPasses, trackWalkPasses, walkPassesOf } from './walkTrack';

const WALKS = new Set(['w1', 'w2']);
const frame = (layer: string, t: number): DetectItem => ({ kind: 'frame', layer, t });

describe('the walk passes of a local model run', () => {
  it('names the pass as main does', () => {
    expect(modelPassName('20261111-101500-a1b2c3')).toBe('model-20261111-101500-a1b2c3.json');
    expect(modelPassName('a/b c')).toBe('model-a-b-c.json');
  });

  it('is the run pass when the run read one walk', () => {
    expect(walkPassesOf('r1', [frame('w1', 1), frame('w1', 3)], WALKS)).toEqual([
      { pass: 'detections/model-r1.json', layer: 'w1' },
    ]);
  });

  it('is one pass per walk layer, named after it, when the run read several layers', () => {
    const items: DetectItem[] = [
      { kind: 'photo', layer: 'ph', photo: 'p1' },
      frame('w1', 1),
      frame('w2', 2),
    ];
    expect(walkPassesOf('r1', items, WALKS)).toEqual([
      { pass: 'detections/model-r1-w1.json', layer: 'w1' },
      { pass: 'detections/model-r1-w2.json', layer: 'w2' },
    ]);
    expect(runPasses('r1', items).map((p) => p.name)).toEqual([
      'model-r1-ph.json',
      'model-r1-w1.json',
      'model-r1-w2.json',
    ]);
  });

  it('is none for photos only', () => {
    expect(walkPassesOf('r1', [{ kind: 'photo', layer: 'ph', photo: 'p1' }], WALKS)).toEqual([]);
  });
});

describe('tracking the walk passes', () => {
  const done = (id: string) => ({ id, status: 'done' }) as JobRecord;
  const passes = [
    { pass: 'detections/model-r1-w1.json', layer: 'w1' },
    { pass: 'detections/model-r1-w2.json', layer: 'w2' },
  ];

  it('starts walk.track quietly for each pass and waits for it', async () => {
    const started: IpcRequest<'jobs:start'>[] = [];
    const deps = {
      startQuiet: vi.fn((req: IpcRequest<'jobs:start'>) => {
        started.push(req);
        return Promise.resolve({ jobId: `j${String(started.length)}` });
      }),
      wait: vi.fn((id: string) => Promise.resolve(done(id))),
      cancel: vi.fn(() => Promise.resolve(null)),
    };
    expect(await trackWalkPasses(deps, '/projects/p', passes)).toBe(2);
    expect(started).toEqual([
      {
        pipeline: 'walk.track',
        project: '/projects/p',
        params: { pass: 'detections/model-r1-w1.json', layer: 'w1' },
      },
      {
        pipeline: 'walk.track',
        project: '/projects/p',
        params: { pass: 'detections/model-r1-w2.json', layer: 'w2' },
      },
    ]);
    expect(deps.wait.mock.calls.map((c) => c[0])).toEqual(['j1', 'j2']);
  });

  it('leaves the drafts as they are when the job is refused, fails or cannot start', async () => {
    const refused = {
      startQuiet: () => Promise.resolve({ error: 'needs processing tools 0.35.0' }),
      wait: vi.fn(() => Promise.resolve(null)),
      cancel: () => Promise.resolve(null),
    };
    expect(await trackWalkPasses(refused, '/p', passes)).toBe(0);
    expect(refused.wait).not.toHaveBeenCalled();
    const failed = {
      startQuiet: () => Promise.resolve({ jobId: 'j' }),
      wait: () => Promise.resolve({ id: 'j', status: 'failed' } as JobRecord),
      cancel: () => Promise.resolve(null),
    };
    expect(await trackWalkPasses(failed, '/p', passes)).toBe(0);
    const throws = {
      startQuiet: () => {
        throw new Error('no jobs here');
      },
      wait: () => Promise.reject(new Error('gone')),
      cancel: () => Promise.resolve(null),
    };
    expect(await trackWalkPasses(throws, '/p', passes)).toBe(0);
  });

  it('cancels the job in hand on Stop and starts no other', async () => {
    const stop = new AbortController();
    const deps = {
      startQuiet: vi.fn(() => Promise.resolve({ jobId: 'j1' })),
      // the job only ends when the wait is aborted, as waitForJob does
      wait: vi.fn(
        (_id: string, signal?: AbortSignal) =>
          new Promise<JobRecord | null>((resolve) => {
            signal?.addEventListener('abort', () => {
              resolve(null);
            });
          }),
      ),
      cancel: vi.fn(() => Promise.resolve(null)),
    };
    const tracking = trackWalkPasses(deps, '/p', passes, stop.signal);
    await vi.waitFor(() => {
      expect(deps.wait).toHaveBeenCalledOnce();
    });
    stop.abort();
    expect(await tracking).toBe(0);
    expect(deps.cancel).toHaveBeenCalledWith('j1');
    expect(deps.startQuiet).toHaveBeenCalledOnce();
    // a Stop before anything started starts nothing
    const none = { ...deps, startQuiet: vi.fn(() => Promise.resolve({ jobId: 'j2' })) };
    expect(await trackWalkPasses(none, '/p', passes, stop.signal)).toBe(0);
    expect(none.startQuiet).not.toHaveBeenCalled();
  });
});
