// @vitest-environment jsdom
import { createCleanupRecipes } from '@aio/pointcloud';
import { emptyCleanup, noiseCopyPath, type JobRecord, type Layer } from '@aio/schema';
import { describe, expect, it, vi } from 'vitest';
import { applyNoiseRun, noiseShare, runNoise, saveCleaned, type JobsDeps } from './cleanupJobs';
import { createCleanup } from './cleanupStore';

vi.mock('../shell', () => ({
  shell: { getState: () => ({ pkg: null }) },
  bridge: { call: () => Promise.resolve({ ok: false, error: 'no bridge in tests' }) },
  jobs: { getState: () => ({ jobs: [] }), subscribe: () => () => undefined },
}));

type CloudLayer = Extract<Layer, { kind: 'pointcloud' }>;
const layer: CloudLayer = {
  kind: 'pointcloud',
  id: 'a',
  name: 'Scan',
  visible: true,
  src: { path: 'clouds/a.copc.laz' },
  format: 'copc',
};
const run = (marked: number) => ({
  path: noiseCopyPath('a', 'job1'),
  params: { outlier: { meanK: 8, multiplier: 2 } },
  marked,
  total: 16060,
  runId: 'job1',
});

const PACK_REFUSAL =
  'Point cloud noise removal and cleaned copies needs processing tools 0.10.0 or later (these are 0.9.0). Update them in Settings, Processing tools.';

function deps(marked: number, status: JobRecord['status'] = 'done', refuse: string | null = null) {
  const started: unknown[] = [];
  const call = vi.fn((channel: string, req: unknown) => {
    if (channel === 'jobs:start') {
      started.push(req);
      return Promise.resolve(
        refuse
          ? { ok: true, value: { ok: false, error: refuse } }
          : { ok: true, value: { ok: true, job: { id: 'job1' } } },
      );
    }
    if (channel === 'pointcloud:readCleanup')
      return Promise.resolve({
        ok: true,
        value: { ok: true, recipes: [], noise: run(marked), readOnly: false },
      });
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
    waitForJob: () =>
      Promise.resolve({
        id: 'job1',
        status,
        error: status === 'failed' ? 'PDAL failed' : undefined,
      } as JobRecord),
  };
  return { d, cleanup, started, call };
}

describe('noise runs', () => {
  it('adds the run and hides class 7 once', () => {
    const r = applyNoiseRun({ ...emptyCleanup('a'), hiddenClasses: [7, 2] }, 'a', run(5));
    expect(r.hiddenClasses).toEqual([2, 7]);
    expect(r.noise?.runId).toBe('job1');
    expect(applyNoiseRun(null, 'a', run(5)).hiddenClasses).toEqual([7]);
  });

  it('formats the share of marked points', () => {
    expect(noiseShare(60, 16060)).toBe('0.4 %');
    expect(noiseShare(5, 16060)).toBe('0.03 %');
    expect(noiseShare(0, 0)).toBe('0 %');
  });

  it('starts the job, then writes the run into the recipe as one step', async () => {
    const { d, cleanup, started, call } = deps(60);
    await cleanup.load('p', [layer]);
    expect(await runNoise(d, layer, { outlier: { meanK: 8, multiplier: 2 } })).toBeNull();
    expect(started).toEqual([
      {
        pipeline: 'pointcloud.clean',
        project: 'D:/p',
        params: {
          mode: 'noise',
          layerId: 'a',
          src: 'clouds/a.copc.laz',
          outlier: { meanK: 8, multiplier: 2 },
        },
      },
    ]);
    // the run's record is read only after the job returned
    expect(call).toHaveBeenCalledWith('pointcloud:readCleanup', {
      projectId: 'p',
      noiseRun: { layerId: 'a', runId: 'job1' },
    });
    expect(cleanup.recipeOf('a')?.noise?.marked).toBe(60);
    expect(cleanup.store.getState().notice).toMatchObject({ undo: true });
    expect(cleanup.store.getState().busy).toBeNull();
  });

  it('a noise run that marked nothing leaves the recipe as it was and says so', async () => {
    const { d, cleanup } = deps(0);
    await cleanup.load('p', [layer]);
    expect(await runNoise(d, layer, { outlier: { meanK: 8, multiplier: 2 } })).toBeNull();
    expect(cleanup.recipeOf('a')).toBeNull();
    expect(cleanup.store.getState().layers.a).toBeUndefined(); // no undo step
    expect(cleanup.store.getState().notice?.text).toBe('No new noise found: nothing was marked.');
  });

  it('a failed job leaves the recipe and gives its error', async () => {
    const { d, cleanup } = deps(60, 'failed');
    await cleanup.load('p', [layer]);
    expect(await runNoise(d, layer, { outlier: { meanK: 8, multiplier: 2 } })).toBe('PDAL failed');
    expect(cleanup.recipeOf('a')).toBeNull();
  });

  it('a run that returns after another project opened writes nothing anywhere', async () => {
    const { d, cleanup, call } = deps(60);
    await cleanup.load('p', [layer]);
    const job = d.waitForJob.bind(d);
    d.waitForJob = async (id) => {
      cleanup.close();
      await cleanup.load('q', [layer]);
      return job(id);
    };
    expect(await runNoise(d, layer, { outlier: { meanK: 8, multiplier: 2 } })).toBeNull();
    const channels = call.mock.calls.map(([ch]) => ch);
    expect(channels).not.toContain('pointcloud:writeCleanup');
    expect(call).not.toHaveBeenCalledWith('pointcloud:readCleanup', {
      projectId: 'p',
      noiseRun: { layerId: 'a', runId: 'job1' },
    });
    expect(cleanup.store.getState().projectId).toBe('q');
    expect(cleanup.recipeOf('a')).toBeNull();
    expect(cleanup.store.getState().notice).toBeNull();
  });

  it('a project switch while the record is read still commits nothing', async () => {
    const { d, cleanup, call } = deps(60);
    await cleanup.load('p', [layer]);
    const inner = d.call;
    d.call = (async (channel: string, req: unknown) => {
      const r = await (inner as (c: string, q: unknown) => Promise<unknown>)(channel, req);
      if (channel === 'pointcloud:readCleanup' && (req as { noiseRun?: unknown }).noiseRun) {
        cleanup.close();
        await cleanup.load('q', [layer]);
      }
      return r;
    }) as never;
    expect(await runNoise(d, layer, { outlier: { meanK: 8, multiplier: 2 } })).toBeNull();
    expect(call.mock.calls.map(([ch]) => ch)).not.toContain('pointcloud:writeCleanup');
    expect(cleanup.recipeOf('a')).toBeNull();
  });

  it('a project that is not open refuses the run with that reason', async () => {
    const { d } = deps(60);
    d.project = () => null;
    expect(await runNoise(d, layer, { outlier: { meanK: 8, multiplier: 2 } })).toBe(
      'No project is open.',
    );
  });

  it('an old pipeline pack refuses the run with the pack update wording', async () => {
    const { d, cleanup } = deps(60, 'done', PACK_REFUSAL);
    await cleanup.load('p', [layer]);
    expect(await runNoise(d, layer, { outlier: { meanK: 8, multiplier: 2 } })).toBe(PACK_REFUSAL);
    expect(cleanup.recipeOf('a')).toBeNull();
    expect(cleanup.store.getState().busy).toBeNull();
  });
});

describe('save cleaned copy', () => {
  it('sends the present recipe and the name', async () => {
    const { d, cleanup, started } = deps(0);
    await cleanup.load('p', [layer]);
    await cleanup.commit('a', { ...emptyCleanup('a'), hiddenClasses: [7] });
    expect(await saveCleaned(d, layer, 'Scan')).toBeNull();
    expect(started[0]).toMatchObject({
      pipeline: 'pointcloud.clean',
      params: { mode: 'save', layerId: 'a', name: 'Scan', recipe: { hiddenClasses: [7] } },
    });
  });

  it('an old pipeline pack refuses the save with the pack update wording', async () => {
    const { d, cleanup } = deps(0, 'done', PACK_REFUSAL);
    await cleanup.load('p', [layer]);
    expect(await saveCleaned(d, layer, 'Scan')).toBe(PACK_REFUSAL);
    expect(cleanup.store.getState().busy).toBeNull();
    expect(cleanup.store.getState().notice).toBeNull(); // no "Saving" notice for a refused job
  });
});
