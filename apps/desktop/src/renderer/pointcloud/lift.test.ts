// @vitest-environment jsdom
import type { Detection } from '@aio/annotate/detections';
import { createCleanupRecipes } from '@aio/pointcloud';
import { MAX_LASSO_VERTICES, type JobRecord, type Layer, type LiftedRegion } from '@aio/schema';
import { describe, expect, it, vi } from 'vitest';
import type { JobsDeps } from './cleanupJobs';
import { createCleanup } from './cleanupStore';
import { liftParams, liftedRegions, maskOf, masksFor, runLift } from './lift';

vi.mock('../shell', () => ({
  shell: { getState: () => ({ pkg: null }) },
  bridge: { call: () => Promise.resolve({ ok: false, error: 'no bridge in tests' }) },
  jobs: { getState: () => ({ jobs: [] }), subscribe: () => () => undefined },
}));

type CloudLayer = Extract<Layer, { kind: 'pointcloud' }>;
const cloud: CloudLayer = {
  kind: 'pointcloud',
  id: 'a',
  name: 'Scan',
  visible: true,
  src: { path: 'clouds/a.copc.laz' },
  format: 'copc',
};

const det = (over: Partial<Detection> = {}): Detection => ({
  id: 'd1',
  pass: 'review.json',
  source: { kind: 'photo', layer: 'photos', photo: 'DJI_0042' },
  size: [4000, 3000],
  geom: {
    type: 'polygon',
    points: [
      [100, 100],
      [400, 120],
      [380, 500],
    ],
  },
  classId: 'roof',
  severity: null,
  uncertain: false,
  note: '',
  status: 'draft',
  origin: { kind: 'human', author: 'x' },
  ...over,
});

const noSize = () => null;

describe('masks from photo outlines', () => {
  it('keeps the outline in the grid it was drawn in, with that grid size', () => {
    expect(maskOf(det(), noSize, 'roof on DJI_0042')).toEqual({
      layer: 'photos',
      photo: 'DJI_0042',
      polygon: [
        [100, 100],
        [400, 120],
        [380, 500],
      ],
      width: 4000,
      height: 3000,
      label: 'roof on DJI_0042',
    });
  });

  it('scales a normalized outline to the photo pixels, or skips it when the size is unknown', () => {
    const d = det({
      size: [1, 1],
      geom: {
        type: 'polygon',
        points: [
          [0.1, 0.2],
          [0.5, 0.2],
          [0.5, 0.6],
        ],
      },
    });
    expect(maskOf(d, () => [2000, 1500], 'x')).toMatchObject({
      polygon: [
        [200, 300],
        [1000, 300],
        [1000, 900],
      ],
      width: 2000,
      height: 1500,
    });
    expect(maskOf(d, noSize, 'x')).toBeNull();
  });

  it('thins a long outline to the lasso limit', () => {
    const points = Array.from({ length: 1000 }, (_, i) => {
      const a = (i / 1000) * Math.PI * 2;
      return [2000 + 500 * Math.cos(a), 1500 + 500 * Math.sin(a)] as [number, number];
    });
    const m = maskOf(det({ geom: { type: 'polygon', points } }), noSize, 'x');
    expect(m?.polygon.length).toBeLessThanOrEqual(MAX_LASSO_VERTICES);
    expect(m?.polygon.length).toBeGreaterThanOrEqual(3);
  });

  it('takes only outlines (not boxes, not rejected) on the picked photos', () => {
    const list = [
      det(),
      det({ id: 'box', geom: { type: 'box', x: 1, y: 1, w: 5, h: 5 } }),
      det({ id: 'gone', status: 'rejected' }),
      det({ id: 'other', source: { kind: 'photo', layer: 'photos', photo: 'DJI_0043' } }),
      det({ id: 'frame', source: { kind: 'frame', layer: 'v', t: 2 } }),
    ];
    const masks = masksFor(list, [{ layerId: 'photos', photoId: 'DJI_0042' }], noSize, (d) => d.id);
    expect(masks.map((m) => m.label)).toEqual(['d1']);
  });

  it('builds the segment.lift params from the cloud and the masks', () => {
    const m = maskOf(det(), noSize, 'x');
    if (!m) throw new Error('no mask');
    expect(liftParams(cloud, [m])).toEqual({ layerId: 'a', src: 'clouds/a.copc.laz', masks: [m] });
    expect(liftParams(cloud, [])).toBeNull();
  });
});

const VP = Array.from({ length: 16 }, (_, i) => (i % 5 === 0 ? 1 : 0));
const lifted: LiftedRegion = {
  photo: 'DJI_0042',
  viewProj: VP,
  polygon: [
    [-0.5, -0.5],
    [0.5, -0.5],
    [0, 0.5],
  ],
  depth: { near: 10, far: 14 },
  points: 812,
  label: 'roof on DJI_0042',
};

describe('lifted regions in the recipe', () => {
  it('maps each lifted mask to a lasso region that sets the class', () => {
    let n = 0;
    expect(liftedRegions([lifted], 6, () => `r${String(++n)}`)).toEqual([
      {
        id: 'r1',
        shape: 'lasso',
        viewProj: VP,
        polygon: lifted.polygon,
        depth: { near: 10, far: 14 },
        label: 'roof on DJI_0042',
        action: { kind: 'class', value: 6 },
      },
    ]);
  });

  function deps(answer: unknown) {
    const started: unknown[] = [];
    const call = vi.fn((channel: string, req: unknown) => {
      if (channel === 'jobs:start') {
        started.push(req);
        return Promise.resolve({ ok: true, value: { ok: true, job: { id: 'job9' } } });
      }
      if (channel === 'pointcloud:readCleanup') {
        const r = req as { liftRun?: unknown };
        return Promise.resolve({
          ok: true,
          value: { ok: true, recipes: [], readOnly: false, ...(r.liftRun ? { lift: answer } : {}) },
        });
      }
      if (channel === 'pointcloud:writeCleanup')
        return Promise.resolve({ ok: true, value: { ok: true, trashed: [] } });
      return Promise.resolve({ ok: false, error: channel });
    });
    const cleanup = createCleanup({
      call: call as never,
      recipes: createCleanupRecipes(),
      now: () => 1,
    });
    const d: JobsDeps = {
      call: call as never,
      cleanup,
      project: () => ({ id: 'p', root: 'D:/p' }),
      waitForJob: () => Promise.resolve({ id: 'job9', status: 'done' } as JobRecord),
    };
    return { d, cleanup, started, call };
  }

  it('runs segment.lift, reads its answer and adds the regions as one step', async () => {
    const skipped = [{ photo: 'DJI_0050', reason: 'The photo is not posed.' }];
    const { d, cleanup, started, call } = deps({ regions: [lifted], skipped });
    await cleanup.load('p', [cloud]);
    const m = maskOf(det(), noSize, 'roof on DJI_0042');
    if (!m) throw new Error('no mask');
    const out = await runLift(d, cloud, [m], 2, () => 'r1');
    expect(out).toEqual({ ok: true, added: 1, skipped });
    expect(started).toEqual([
      {
        pipeline: 'segment.lift',
        project: 'D:/p',
        params: { layerId: 'a', src: 'clouds/a.copc.laz', masks: [m] },
      },
    ]);
    expect(call).toHaveBeenCalledWith('pointcloud:readCleanup', {
      projectId: 'p',
      liftRun: { layerId: 'a', runId: 'job9' },
    });
    expect(cleanup.recipeOf('a')?.regions).toEqual([
      expect.objectContaining({
        id: 'r1',
        action: { kind: 'class', value: 2 },
        depth: lifted.depth,
      }),
    ]);
    // one undo step takes it out again
    expect(await cleanup.undo('a')).toBe(true);
    expect(cleanup.recipeOf('a')).toBeNull();
  });

  it('a lift that reached nothing changes nothing and passes the reasons on', async () => {
    const skipped = [{ photo: 'DJI_0042', reason: 'The point cloud is not in view.' }];
    const { d, cleanup } = deps({ regions: [], skipped });
    await cleanup.load('p', [cloud]);
    const m = maskOf(det(), noSize, 'x');
    if (!m) throw new Error('no mask');
    expect(await runLift(d, cloud, [m], 2)).toEqual({ ok: true, added: 0, skipped });
    expect(cleanup.recipeOf('a')).toBeNull();
  });

  it('a look-only cleanup starts no job', async () => {
    const { d, cleanup, started } = deps({ regions: [lifted], skipped: [] });
    await cleanup.load('p', [cloud]);
    cleanup.store.setState({ readOnly: true });
    const m = maskOf(det(), noSize, 'x');
    if (!m) throw new Error('no mask');
    expect((await runLift(d, cloud, [m], 2)).ok).toBe(false);
    expect(started).toEqual([]);
  });
});
