import { beforeEach, describe, expect, it, vi } from 'vitest';

const call = vi.fn();
const open: { project: unknown } = {
  project: {
    id: 'p1',
    root: 'D:/Projects/site',
    manifest: {
      crs: { epsg: 32639 },
      captures: [{ id: 'c1', label: 'Survey', date: '2026-10-01' }],
      layers: [
        {
          kind: 'photos',
          id: 'ph',
          name: 'Flight',
          items: [{ takenAt: '2026-03-14T10:00:00' }, { takenAt: '2026-03-14T10:01:00' }],
        },
      ],
    },
  },
};
vi.mock('../shell', () => ({
  bridge: { call: (...a: unknown[]) => call(...a) as unknown },
  jobs: { getState: () => ({ refresh: () => Promise.resolve() }) },
}));
vi.mock('@aio/workspace', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  workspace: { getState: () => ({ project: open.project }) },
}));

import type { ProcessPhotosRequest } from '@aio/ai';
import { agentPhotoRuns, agentProcessPhotos } from './agentHooks';
import { formatMinutes } from './estimate';
import { photoUi } from './store';

const ok = (value: unknown) =>
  Promise.resolve({ ok: true, value: { ok: true, ...(value as object) } });
const estimate = { minutes: [5, 10], notes: [] };
const req: ProcessPhotosRequest = {
  layerId: 'ph',
  preset: 'standard',
  gnss: 'auto',
  products: ['ortho', 'dsm'],
  groundControlFirst: false,
};
const RUN = '20261012-1200';

function answer(over: Record<string, unknown> = {}) {
  call.mockImplementation((channel: string) => {
    if (channel in over) return Promise.resolve(over[channel]);
    if (channel === 'photo:estimate') return ok({ estimate });
    if (channel === 'photo:runs') return ok({ runs: [] });
    if (channel === 'jobs:start') return ok({});
    throw new Error(`unexpected ${channel}`);
  });
}
const started = () => call.mock.calls.filter((c) => c[0] === 'jobs:start');

beforeEach(() => {
  call.mockReset();
  photoUi.setState({ pending: {}, dates: {} });
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 9, 12, 12, 0));
});

describe('agentProcessPhotos', () => {
  it('starts photo.align on the layer and queues the maps under the photos day', async () => {
    answer();
    const r = await agentProcessPhotos(req);
    expect(r).toEqual({ run: RUN, estimate: formatMinutes([5, 10]), surveyDate: '2026-03-14' });
    expect(call).toHaveBeenCalledWith('jobs:start', {
      pipeline: 'photo.align',
      project: 'D:/Projects/site',
      params: { photos: { layer: 'ph' }, run: RUN, preset: 'standard', gnss: 'auto' },
    });
    expect(photoUi.getState().pending[RUN]).toEqual({
      root: 'D:/Projects/site',
      preset: 'standard',
      products: ['ortho', 'dsm'],
      captureDate: '2026-03-14',
    });
    expect(photoUi.getState().dates[RUN]).toEqual({ captureDate: '2026-03-14' });
  });

  it('picks the next free run id', async () => {
    answer({ 'photo:runs': await ok({ runs: [{ id: RUN }] }) });
    expect((await agentProcessPhotos(req)).run).toBe(`${RUN}-2`);
  });

  it('queues no products with ground control first', async () => {
    answer();
    await agentProcessPhotos({ ...req, groundControlFirst: true });
    expect(photoUi.getState().pending).toEqual({});
    expect(photoUi.getState().dates[RUN]).toEqual({ captureDate: '2026-03-14' });
  });

  it('refuses when the disk is short', async () => {
    answer({
      'photo:estimate': await ok({
        estimate: {
          minutes: [5, 10],
          notes: ['Needs 40 GB free on the data drive, has 12 GB. Free some space.'],
        },
      }),
    });
    await expect(agentProcessPhotos(req)).rejects.toThrow(
      'this needs 40 GB on the data drive, and it has 12 GB',
    );
    expect(started()).toHaveLength(0);
  });

  it('refuses a layer with nothing to process', async () => {
    answer({ 'photo:estimate': await ok({ estimate: { minutes: [0, 0], notes: [] } }) });
    await expect(agentProcessPhotos(req)).rejects.toThrow(
      'There are no photos to process in this layer.',
    );
    expect(started()).toHaveLength(0);
  });

  it('passes on a refused start', async () => {
    answer({
      'jobs:start': {
        ok: true,
        value: { ok: false, error: 'Processing photos needs the pipeline pack.' },
      },
    });
    await expect(agentProcessPhotos(req)).rejects.toThrow(
      'Processing photos needs the pipeline pack.',
    );
    expect(photoUi.getState().pending).toEqual({});
    expect(photoUi.getState().dates).toEqual({});
  });

  it('refuses without an open project, or with a layer that is gone', async () => {
    answer();
    await expect(agentProcessPhotos({ ...req, layerId: 'gone' })).rejects.toThrow(
      'The photos layer "gone" is not in the open project.',
    );
    const saved = open.project;
    open.project = null;
    await expect(agentProcessPhotos(req)).rejects.toThrow('No project is open.');
    open.project = saved;
  });
});

describe('agentPhotoRuns', () => {
  it('reads the runs and one run with its control points', async () => {
    const R = { id: 'r1' };
    const A = { rms: 0.1 };
    const G = [{ id: 'g1' }];
    answer({
      'photo:runs': await ok({ runs: [R] }),
      'photo:readRun': await ok({ run: R, accuracy: A }),
      'photo:readGcp': await ok({ gcp: G }),
    });
    expect(await agentPhotoRuns.list()).toEqual([R]);
    expect(call).toHaveBeenCalledWith('photo:runs', { projectId: 'p1' });
    expect(await agentPhotoRuns.read('r1')).toEqual({ run: R, accuracy: A, gcp: G });
    answer({
      'photo:readRun': { ok: false, error: 'boom' },
      'photo:readGcp': await ok({ gcp: G }),
    });
    await expect(agentPhotoRuns.read('r1')).rejects.toThrow('boom');
  });
});
