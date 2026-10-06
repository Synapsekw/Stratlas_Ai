import type { IpcChannel, Issue, JobEvent, JobRecord } from '@aio/schema';
import { describe, expect, it } from 'vitest';
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

  it('a draft fills in the next new job form once', () => {
    const { bridge } = fakeBridge({});
    const store = createJobsStore(bridge, undefined);
    store.getState().prepare({ pipeline: 'road.build', project: 'E:\\p', values: { lanes: '3' } });
    expect(store.getState().draft?.values.lanes).toBe('3');
    store.getState().prepare(null);
    expect(store.getState().draft).toBeNull();
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
