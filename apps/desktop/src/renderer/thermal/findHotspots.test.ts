import type { JobRecord } from '@aio/schema';
import { describe, expect, it, vi } from 'vitest';
import {
  HOTSPOT_PARAMS,
  candidatesOf,
  createHotspotFinder,
  stepManifestPath,
  type HotspotFinderDeps,
} from './findHotspots';

const job = (over: Partial<JobRecord> = {}): JobRecord => ({
  id: 'j1',
  pipeline: 'thermal.hotspots',
  project: 'C:/p',
  params: {},
  status: 'done',
  progress: 1,
  steps: [
    { name: 'find', state: 'done' },
    { name: 'commit', state: 'done' },
  ],
  artifacts: [],
  createdAt: '',
  updatedAt: '',
  ...over,
});

function setup(over: Partial<HotspotFinderDeps> = {}) {
  const deps: HotspotFinderDeps = {
    start: vi.fn(() => Promise.resolve({ jobId: 'j1' })),
    wait: vi.fn(() => Promise.resolve(job())),
    readCandidates: vi.fn(() => Promise.resolve(3)),
    reload: vi.fn(() => Promise.resolve()),
    ...over,
  };
  return { deps, store: createHotspotFinder(deps) };
}

describe('hot spot finder', () => {
  it('starts thermal.hotspots on the layer with the delta rule at 4 °C', async () => {
    const { deps, store } = setup();
    await store.getState().run('p', 'th');
    expect(deps.start).toHaveBeenCalledWith({ layerId: 'th', rule: 'delta', thresholdC: 4 });
    expect(HOTSPOT_PARAMS).toEqual({ rule: 'delta', thresholdC: 4 });
  });

  it('reports the candidates of the finished job and reloads the review', async () => {
    const { deps, store } = setup();
    await store.getState().run('p', 'th');
    expect(store.getState().find).toEqual({ layerId: 'th', phase: 'done', count: 3, error: null });
    expect(deps.readCandidates).toHaveBeenCalledWith('p', expect.objectContaining({ id: 'j1' }));
    expect(deps.reload).toHaveBeenCalledWith('p');
  });

  it('is running until the job ends', async () => {
    let finish: (j: JobRecord) => void = () => undefined;
    const { store } = setup({
      wait: () =>
        new Promise<JobRecord>((r) => {
          finish = r;
        }),
    });
    const done = store.getState().run('p', 'th');
    await vi.waitFor(() => {
      expect(store.getState().find?.phase).toBe('running');
    });
    finish(job());
    await done;
    expect(store.getState().find?.phase).toBe('done');
  });

  it('says why when the job cannot start or fails', async () => {
    const refused = setup({ start: () => Promise.resolve({ error: 'Update the tools.' }) });
    await refused.store.getState().run('p', 'th');
    expect(refused.store.getState().find).toMatchObject({
      phase: 'error',
      error: 'Update the tools.',
    });
    expect(refused.deps.reload).not.toHaveBeenCalled();

    const failed = setup({
      wait: () => Promise.resolve(job({ status: 'failed', error: 'No rasters.' })),
    });
    await failed.store.getState().run('p', 'th');
    expect(failed.store.getState().find).toMatchObject({ phase: 'error', error: 'No rasters.' });
  });

  it('a job without its own error text gets a sentence, never a raw status word', async () => {
    for (const status of ['failed', 'cancelled', 'interrupted'] as const) {
      const { store } = setup({ wait: () => Promise.resolve(job({ status })) });
      await store.getState().run('p', 'th');
      expect(store.getState().find).toMatchObject({
        phase: 'error',
        error: 'The hot spot search did not finish. Open Processing for its log.',
      });
    }
    const gone = setup({ wait: () => Promise.resolve(null) });
    await gone.store.getState().run('p', 'th');
    expect(gone.store.getState().find?.error).toBe(
      'The hot spot search stopped before it finished.',
    );
  });

  it('a count it cannot read leaves the generic line', async () => {
    const { store } = setup({ readCandidates: () => Promise.resolve(null) });
    await store.getState().run('p', 'th');
    expect(store.getState().find).toMatchObject({ phase: 'done', count: null });
  });

  it('does not start twice while one runs', async () => {
    const { deps, store } = setup({ wait: () => new Promise<JobRecord>(() => undefined) });
    void store.getState().run('p', 'th');
    await vi.waitFor(() => {
      expect(store.getState().find?.phase).toBe('running');
    });
    await store.getState().run('p', 'th');
    expect(deps.start).toHaveBeenCalledTimes(1);
  });
});

describe('the commit step of a finished job', () => {
  it('is the step manifest the runtime writes, by position and name', () => {
    expect(stepManifestPath(job())).toBe('jobs/j1/steps/02-commit.json');
    expect(stepManifestPath(job({ steps: [] }))).toBeNull();
  });
  it('reads the candidates count from its outputs', () => {
    expect(candidatesOf({ outputs: { candidates: 5, photos: 3 } })).toBe(5);
    expect(candidatesOf({ outputs: { candidates: 0 } })).toBe(0);
    expect(candidatesOf({ outputs: { candidates: -1 } })).toBeNull();
    expect(candidatesOf({ outputs: {} })).toBeNull();
    expect(candidatesOf(null)).toBeNull();
  });
});
