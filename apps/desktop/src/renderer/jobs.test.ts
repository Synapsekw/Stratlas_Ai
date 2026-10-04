import type { IpcChannel, JobEvent, JobRecord } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import type { Bridge, Res } from './bridge';
import { applyJobEvent, buildParams, canResume, createJobsStore, isActive } from './jobs';

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
