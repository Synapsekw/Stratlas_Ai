import type { IpcChannel, Issue, JobEvent, JobRecord } from '@aio/schema';
import { describe, expect, it, vi } from 'vitest';
import type { Bridge, Res } from './bridge';
import {
  applyJobEvent,
  buildParams,
  canResume,
  createJobsStore,
  finishedIssuesJob,
  finishedChangeJob,
  finishedManifestJob,
  finishedProjectJob,
  isActive,
  jobsEnded,
  mergeDiskIssues,
  waitForJob,
  watchJobEnds,
} from './jobs';

const job = (over: Partial<JobRecord> = {}): JobRecord => ({
  id: 'j1',
  pipeline: 'aik.cameras',
  project: 'E:\\p',
  params: { photos: 'E:\\raw' },
  status: 'running',
  progress: 0.2,
  steps: [],
  artifacts: [],
  createdAt: '2026-10-04T10:00:00.000Z',
  updatedAt: '2026-10-04T10:00:00.000Z',
  ...over,
});

function fakeBridge(handlers: Partial<Record<IpcChannel, (req: unknown) => unknown>>) {
  const calls: { channel: IpcChannel; req: unknown }[] = [];
  const bridge: Bridge = {
    call: (channel, req) => {
      calls.push({ channel, req });
      const h = handlers[channel];
      return Promise.resolve(
        (h ? { ok: true, value: h(req) } : { ok: false, error: `no ${channel}` }) as Res<never>,
      );
    },
  };
  return { bridge, calls };
}

describe('applyJobEvent', () => {
  it('adds new jobs on top and replaces known ones', () => {
    let s = { jobs: [job()], logs: {} };
    s = applyJobEvent(s, { type: 'update', job: job({ id: 'j2' }) });
    expect(s.jobs.map((j) => j.id)).toEqual(['j2', 'j1']);
    s = applyJobEvent(s, { type: 'update', job: job({ progress: 0.9 }) });
    expect(s.jobs[1]?.progress).toBe(0.9);
  });

  it('ignores a record older than the one it has (a late invoke answer)', () => {
    const newer = job({ updatedAt: '2026-10-04T10:00:05.000Z', progress: 0.5 });
    const s = applyJobEvent({ jobs: [newer], logs: {} }, { type: 'update', job: job() });
    expect(s.jobs[0]).toBe(newer);
  });

  it('appends log lines per job', () => {
    const line = { time: 't', level: 'info' as const, message: 'hello' };
    const s = applyJobEvent({ jobs: [], logs: {} }, { type: 'log', jobId: 'j1', line });
    expect(s.logs).toEqual({ j1: [line] });
  });

  it('knows which jobs are active and which can resume', () => {
    expect(isActive(job())).toBe(true);
    expect(isActive(job({ status: 'done' }))).toBe(false);
    expect(canResume(job({ status: 'interrupted' }))).toBe(true);
    expect(canResume(job({ status: 'done' }))).toBe(false);
  });
});

describe('jobs store', () => {
  it('loads the list and runtime, selects the newest job, and follows pushed events', async () => {
    let push: ((e: JobEvent) => void) | undefined;
    const { bridge } = fakeBridge({
      'jobs:list': () => ({ runtime: { found: true, version: '0.1.0' }, jobs: [job()] }),
      'jobs:log': () => ({ lines: [{ time: 'a', level: 'info', message: 'old' }] }),
    });
    const store = createJobsStore(bridge, ((_name: string, fn: (e: JobEvent) => void) => {
      push = fn;
      return () => undefined;
    }) as never);
    await store.getState().init();
    expect(store.getState().runtime?.version).toBe('0.1.0');
    expect(store.getState().selected).toBe('j1');
    expect(store.getState().logs.j1?.map((l) => l.message)).toEqual(['old']);
    push?.({ type: 'log', jobId: 'j1', line: { time: 'b', level: 'info', message: 'new' } });
    expect(store.getState().logs.j1?.map((l) => l.message)).toEqual(['old', 'new']);
  });

  it('start reports the refusal sentence from main', async () => {
    const { bridge } = fakeBridge({ 'jobs:start': () => ({ ok: false, error: 'No pack.' }) });
    const store = createJobsStore(bridge, undefined);
    expect(await store.getState().start({ resume: 'j1' })).toBe('No pack.');
  });

  it('remove drops finished jobs from the list through main, never a running one', async () => {
    const list = [
      job({ id: 'run' }),
      job({ id: 'done', status: 'done' }),
      job({ id: 'gone', status: 'cancelled' }),
      job({ id: 'bad', status: 'failed' }),
    ];
    const { bridge, calls } = fakeBridge({
      'jobs:list': () => ({ runtime: { found: true }, jobs: list }),
      'jobs:log': () => ({ lines: [] }),
      'jobs:remove': (req) => ({ removed: (req as { jobIds: string[] }).jobIds }),
    });
    const store = createJobsStore(bridge, undefined);
    await store.getState().refresh();
    await store.getState().select('done');

    expect(await store.getState().remove(['done', 'run'])).toBeNull();
    expect(calls.at(-1)).toEqual({ channel: 'jobs:remove', req: { jobIds: ['done'] } });
    expect(store.getState().jobs.map((j) => j.id)).toEqual(['run', 'gone', 'bad']);
    expect(store.getState().selected).toBeNull();
    expect(store.getState().logs.done).toBeUndefined();

    expect(await store.getState().remove(['gone', 'bad'])).toBeNull();
    expect(store.getState().jobs.map((j) => j.id)).toEqual(['run']);
    // nothing finished to remove: main is not asked
    const before = calls.length;
    expect(await store.getState().remove(['run'])).toBeNull();
    expect(calls.length).toBe(before);
  });
});

describe('buildParams', () => {
  it('turns form text into typed params', () => {
    expect(
      buildParams('aik.cameras', {
        photos: ' E:\\raw ',
        origin: '29.0278, 48.1357, 31.7',
        longEdge: '2560',
        out: '',
      }),
    ).toEqual({
      ok: true,
      params: { photos: 'E:\\raw', origin: [29.0278, 48.1357, 31.7], longEdge: 2560 },
    });
  });

  it('explains what is missing or wrong', () => {
    expect(buildParams('aik.cameras', {})).toEqual({
      ok: false,
      error: 'Original photos is required.',
    });
    expect(buildParams('aik.cameras', { photos: 'x', origin: '1, 2' })).toMatchObject({
      ok: false,
    });
    expect(buildParams('aik.records', { out: '..\\x.json' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('inside the project') as string,
    });
  });
});

describe('finishedManifestJob', () => {
  it('reloads the open project once when its point cloud conversion finishes', () => {
    const running = job({
      id: 'c1',
      pipeline: 'pointcloud.to_copc',
      project: 'E:\\data\\projects\\site',
      status: 'running',
    });
    const done = { ...running, status: 'done' as const };
    expect(finishedManifestJob([running], [done], 'e:/data/projects/site/')).toBe(true);
    expect(finishedManifestJob([done], [done], 'E:/data/projects/site')).toBe(false);
    expect(finishedManifestJob([running], [done], 'E:/data/projects/other')).toBe(false);
    const selftest = { ...done, pipeline: 'system.selftest' as const };
    expect(finishedManifestJob([running], [selftest], 'E:/data/projects/site')).toBe(false);
    expect(finishedProjectJob([running], [done], 'E:/data/projects/site')).toBe(false);
  });

  it('reloads the manifest when a walk is processed, so its layer links the new path files', () => {
    const running = job({ id: 'w1', pipeline: 'walk.process', project: 'E:/p', status: 'running' });
    const done = { ...running, status: 'done' as const };
    expect(finishedManifestJob([running], [done], 'E:/p')).toBe(true);
    expect(finishedProjectJob([running], [done], 'E:/p')).toBe(false);
  });

  it('reopens the project whole (manifest and issues) when the road builder finishes', () => {
    const running = job({ id: 'r1', pipeline: 'road.build', project: 'E:\\p', status: 'running' });
    const done = { ...running, status: 'done' as const };
    expect(finishedManifestJob([running], [done], 'E:/p')).toBe(true);
    expect(finishedProjectJob([running], [done], 'E:/p')).toBe(true);
  });

  it('reloads the manifest and the change sets when a change run of the project finishes', () => {
    for (const pipeline of [
      'change.raster',
      'change.surface',
      'change.cloud',
      'change.mesh',
    ] as const) {
      const running = job({ id: 'x', pipeline, project: 'E:\\p\\', status: 'running' });
      const done = { ...running, status: 'done' as const };
      expect(finishedManifestJob([running], [done], 'e:/p'), pipeline).toBe(true);
      expect(finishedChangeJob([running], [done], 'e:/p'), pipeline).toBe(true);
      expect(finishedChangeJob([done], [done], 'e:/p'), pipeline).toBe(false);
      expect(finishedProjectJob([running], [done], 'e:/p'), pipeline).toBe(false);
    }
    // matched frames write a change set and detections, no layer
    const frames = job({ id: 'f', pipeline: 'change.frames', project: 'E:\\p', status: 'running' });
    const framesDone = { ...frames, status: 'done' as const };
    expect(finishedManifestJob([frames], [framesDone], 'E:/p')).toBe(false);
    expect(finishedChangeJob([frames], [framesDone], 'E:/p')).toBe(true);
  });

  it('reloads the manifest when a drawing import or a cloud fit of the project finishes', () => {
    for (const pipeline of ['drawing.import', 'model.fit_cloud'] as const) {
      const running = job({ id: 'm', pipeline, project: 'E:\\p', status: 'running' });
      const done = { ...running, status: 'done' as const };
      expect(finishedManifestJob([running], [done], 'E:/p'), pipeline).toBe(true);
      expect(finishedChangeJob([running], [done], 'E:/p'), pipeline).toBe(false);
    }
  });
});

describe('road builder form', () => {
  it('sends one ortho as a path and several blocks as a list', () => {
    expect(
      buildParams('road.build', {
        centreline: 'road/centreline-drawn.geojson',
        ortho: 'D:/a.tif',
        units: '',
        unitLength: '30',
      }),
    ).toEqual({
      ok: true,
      params: { centreline: 'road/centreline-drawn.geojson', ortho: 'D:/a.tif', unitLength: 30 },
    });
    const two = buildParams('road.build', {
      centreline: 'c.dxf',
      ortho: 'D:/b1.tif; D:/b2.tif;',
      units: 'grid',
    });
    expect(two).toEqual({
      ok: true,
      params: { centreline: 'c.dxf', ortho: ['D:/b1.tif', 'D:/b2.tif'], units: 'grid' },
    });
    expect(buildParams('road.build', {})).toMatchObject({ ok: false });
  });
});

describe('inspection jobs', () => {
  it('sends the review choices as checked params', () => {
    expect(
      buildParams('inspection.run', {
        detections: 'detections/ai.json',
        includeDrafts: 'true',
        minConfidence: '0.5',
      }),
    ).toEqual({
      ok: true,
      params: { detections: 'detections/ai.json', includeDrafts: true, minConfidence: 0.5 },
    });
    expect(buildParams('inspection.run', {})).toEqual({ ok: true, params: {} });
    expect(buildParams('inspection.run', { minConfidence: '3' })).toMatchObject({ ok: false });
  });

  it('takes the merged issues once the inspection pipeline finishes on the open project', () => {
    const running = job({ id: 'i1', pipeline: 'inspection.run', project: 'E:/data/p/' });
    const done = { ...running, status: 'done' as const };
    expect(finishedIssuesJob([running], [done], 'e:/data/p')).toBe(true);
    expect(finishedIssuesJob([done], [done], 'e:/data/p')).toBe(false);
    expect(finishedManifestJob([running], [done], 'e:/data/p')).toBe(false);
  });

  it('keeps edits made in the app while the job ran', () => {
    const issue = (id: string, updatedAt: string, title = id): Issue => ({
      id,
      code: 'D01',
      classId: 'crack',
      severityModelId: 'm',
      severity: 1,
      status: 'draft',
      title,
      note: '',
      author: 'a',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt,
      sightings: [{ on: 'mesh', layer: 'l', geom: { type: 'spoint', p: [0, 0, 0], n: [0, 1, 0] } }],
      source: 'human',
    });
    const disk = [issue('a', '2026-01-02T00:00:00Z', 'disk'), issue('p', '2026-01-03T00:00:00Z')];
    const open = [issue('a', '2026-01-04T00:00:00Z', 'edited'), issue('n', '2026-01-04T00:00:00Z')];
    const r = mergeDiskIssues(open, disk);
    expect(r.issues.map((i) => [i.id, i.title])).toEqual([
      ['a', 'edited'],
      ['p', 'p'],
      ['n', 'n'],
    ]);
    expect(r.unsaved).toBe(true);
    expect(mergeDiskIssues(disk, disk)).toEqual({ issues: disk, unsaved: false });
  });
});

describe('jobsEnded', () => {
  it('names the jobs that finished or failed since the last list, not the history', () => {
    const before = [job({ id: 'a' }), job({ id: 'b' }), job({ id: 'c', status: 'done' })];
    const after = [
      job({ id: 'a', status: 'done' }),
      job({ id: 'b', status: 'failed' }),
      job({ id: 'c', status: 'done' }),
      job({ id: 'd', status: 'done' }),
    ];
    expect(jobsEnded(before, after).map((e) => [e.job.id, e.ok])).toEqual([
      ['a', true],
      ['b', false],
    ]);
    expect(jobsEnded([], after)).toEqual([]);
  });
});

describe('waitForJob', () => {
  const started = (status: JobRecord['status'] = 'starting') =>
    fakeBridge({ 'jobs:start': () => ({ ok: true, job: job({ id: 'q1', status }) }) });

  it('resolves null at once for a job the store does not know', async () => {
    const { bridge } = fakeBridge({});
    const store = createJobsStore(bridge, undefined);
    expect(await waitForJob(store, 'nope')).toBeNull();
  });

  it('resolves null when the signal aborts while the job is at work', async () => {
    const { bridge } = started();
    const store = createJobsStore(bridge, undefined);
    await store.getState().start({ pipeline: 'aik.cameras', project: 'E:/p', params: {} });
    const ctl = new AbortController();
    const waiting = waitForJob(store, 'q1', ctl.signal);
    ctl.abort();
    expect(await waiting).toBeNull();
  });

  it('resolves the record once the job ends', async () => {
    const { bridge } = started();
    const store = createJobsStore(bridge, undefined);
    await store.getState().start({ pipeline: 'aik.cameras', project: 'E:/p', params: {} });
    const waiting = waitForJob(store, 'q1');
    store.setState((s) => ({
      jobs: s.jobs.map((j) => ({ ...j, status: 'done', updatedAt: 'z' })),
    }));
    expect((await waiting)?.status).toBe('done');
  });
});

describe('a quiet start', () => {
  it('keeps the selection and is not announced', async () => {
    const { bridge } = fakeBridge({
      'jobs:start': () => ({ ok: true, job: job({ id: 'q2', pipeline: 'change.lineup' }) }),
    });
    const store = createJobsStore(bridge, undefined);
    store.setState({ selected: 'other' });
    const r = await store
      .getState()
      .startQuiet({ pipeline: 'change.lineup', project: 'E:/p', params: {} });
    expect(r).toEqual({ jobId: 'q2' });
    expect(store.getState().selected).toBe('other');
    expect(store.getState().jobs.map((j) => j.id)).toContain('q2');
    const before = [job({ id: 'q2', status: 'running' })];
    const after = [job({ id: 'q2', status: 'done' })];
    expect(jobsEnded(before, after, new Set(store.getState().quiet))).toEqual([]);
    expect(jobsEnded(before, after)).toHaveLength(1);
  });

  it('says why it did not start', async () => {
    const { bridge } = fakeBridge({ 'jobs:start': () => ({ ok: false, error: 'No pack.' }) });
    const store = createJobsStore(bridge, undefined);
    expect(
      await store.getState().startQuiet({ pipeline: 'change.lineup', project: 'p', params: {} }),
    ).toEqual({ error: 'No pack.' });
  });
});

describe('the quiet list', () => {
  const quietStore = async () => {
    const { bridge } = fakeBridge({
      'jobs:start': () => ({ ok: true, job: job({ id: 'q3', pipeline: 'change.lineup' }) }),
      'jobs:remove': () => ({ removed: ['q3'] }),
    });
    const store = createJobsStore(bridge, undefined);
    await store.getState().startQuiet({ pipeline: 'change.lineup', project: 'E:/p', params: {} });
    return store;
  };
  const end = (store: ReturnType<typeof createJobsStore>) => {
    store.setState((s) => ({
      jobs: s.jobs.map((j) => ({ ...j, status: 'done', updatedAt: 'z' })),
    }));
  };

  it('empties once a quiet job has ended, and the end is still not announced', async () => {
    const store = await quietStore();
    const ended = vi.fn();
    const stop = watchJobEnds(store, ended);
    expect(store.getState().quiet).toEqual(['q3']);
    end(store);
    expect(ended).not.toHaveBeenCalled();
    expect(store.getState().quiet).toEqual([]);
    stop();
  });

  it('still announces a job that was not quiet', () => {
    const { bridge } = fakeBridge({});
    const store = createJobsStore(bridge, undefined);
    store.setState({ jobs: [job({ id: 'n1', status: 'running' })] });
    const ended = vi.fn();
    const stop = watchJobEnds(store, ended);
    store.setState({ jobs: [job({ id: 'n1', status: 'done' })] });
    expect(ended).toHaveBeenCalledTimes(1);
    stop();
  });

  it('drops the ids of removed jobs and of jobs that are gone on a prune', async () => {
    const store = await quietStore();
    end(store);
    await store.getState().remove(['q3']);
    expect(store.getState().quiet).toEqual([]);
    const again = await quietStore();
    again.setState({ jobs: [] });
    again.getState().pruneQuiet();
    expect(again.getState().quiet).toEqual([]);
    const running = await quietStore();
    running.getState().pruneQuiet();
    expect(running.getState().quiet).toEqual(['q3']);
  });
});
