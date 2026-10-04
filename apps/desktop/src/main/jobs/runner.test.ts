import type { JobEvent, JobRecord } from '@aio/schema';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JobRunner, jobDir } from './runner';
import { JobStore } from './store';

const FAKE = join(import.meta.dirname, '__fixtures__', 'fake-runtime.mjs');

let base: string;
let project: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'aio-jobs-'));
  project = join(base, 'project');
  await import('node:fs/promises').then((fs) => fs.mkdir(project));
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

function setup(mode: string, opts: { pack?: boolean; grace?: number } = {}) {
  const store = new JobStore(join(base, 'jobs.json'));
  const events: JobEvent[] = [];
  const spawned: string[][] = [];
  const runner = new JobRunner({
    store,
    emit: (e) => events.push(e),
    cancelGraceMs: opts.grace ?? 2000,
    findPack: () =>
      Promise.resolve(
        opts.pack === false
          ? { pack: null, runtime: { found: false, problem: 'No pipeline pack in X.' } }
          : {
              pack: { dir: base, version: '0.1.0', python: 'python.exe' },
              runtime: { found: true, version: '0.1.0', dir: base },
            },
      ),
    spawn: (_cmd, args, options) => {
      spawned.push(args);
      return spawn(process.execPath, [FAKE], {
        ...options,
        env: { ...options.env, FAKE_MODE: mode },
      });
    },
  });
  return { store, runner, events, spawned };
}

function finished(runner: JobRunner, id: string): Promise<JobRecord> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const poll = () => {
      const j = runner.get(id);
      if (j && ['done', 'failed', 'cancelled'].includes(j.status) && !runner.isRunning(id))
        resolve(j);
      else if (Date.now() - t0 > 15_000) reject(new Error(`timeout, status ${String(j?.status)}`));
      else setTimeout(poll, 20);
    };
    poll();
  });
}

const START = { pipeline: 'system.selftest' as const, params: { seconds: 1 } };

describe('JobRunner', () => {
  it('runs a job to the end: plan, steps, progress, artifacts, log file', async () => {
    const { runner, events, spawned, store } = setup('ok');
    const r = await runner.start({ ...START, project });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(spawned[0]).toEqual(['-I', '-u', '-X', 'utf8', '-m', 'aio_pipelines']);
    const job = await finished(runner, r.job.id);
    expect(job.status).toBe('done');
    expect(job.progress).toBe(1);
    expect(job.steps.map((s) => [s.name, s.title, s.state])).toEqual([
      ['one', 'Step one', 'done'],
      ['two', 'Step two', 'done'],
    ]);
    expect(job.artifacts).toEqual([{ path: 'out/result.json', kind: 'file' }]);
    expect(job.packVersion).toBe('0.1.0');
    const lines = await runner.log(job.id);
    expect(lines.map((l) => l.message)).toEqual(
      expect.arrayContaining(['working', 'second line', 'a library warning', 'Done.']),
    );
    expect(lines.find((l) => l.message === 'a library warning')?.level).toBe('stderr');
    const file = await readFile(join(jobDir(job), 'job.log'), 'utf8');
    expect(file).toContain('\tinfo\tone\tworking\n');
    expect(events.some((e) => e.type === 'update' && e.job.status === 'running')).toBe(true);
    await store.flush();
    const saved = JSON.parse(await readFile(join(base, 'jobs.json'), 'utf8')) as JobRecord[];
    expect(saved[0]?.status).toBe('done');
  });

  it('a failing job keeps the error and the traceback in the log, and can resume', async () => {
    const { runner } = setup('fail');
    const r = await runner.start({ ...START, project });
    if (!r.ok) throw new Error(r.error);
    const job = await finished(runner, r.job.id);
    expect(job.status).toBe('failed');
    expect(job.error).toBe('Bad input');
    expect(
      (await runner.log(job.id)).some((l) => l.level === 'debug' && l.message === '  line'),
    ).toBe(true);
    const again = await runner.start({ resume: job.id });
    expect(again.ok).toBe(true);
    expect((await finished(runner, job.id)).status).toBe('failed');
  });

  it('cancel asks the runtime to stop, and the job can resume with the same id', async () => {
    const { runner } = setup('slow');
    const r = await runner.start({ ...START, project });
    if (!r.ok) throw new Error(r.error);
    await new Promise((res) => setTimeout(res, 300));
    expect(runner.cancel(r.job.id)).toEqual({ ok: true });
    const job = await finished(runner, r.job.id);
    expect(job.status).toBe('cancelled');
    expect(job.steps.find((s) => s.name === 'two')?.state).toBe('cancelled');
    const resumed = await runner.start({ resume: job.id });
    expect(resumed.ok && resumed.job.id).toBe(job.id);
    runner.cancel(job.id);
    await finished(runner, job.id);
  });

  it('kills a runtime that ignores cancel after the grace period', async () => {
    const { runner } = setup('stubborn', { grace: 200 });
    const r = await runner.start({ ...START, project });
    if (!r.ok) throw new Error(r.error);
    await new Promise((res) => setTimeout(res, 300));
    runner.cancel(r.job.id);
    const job = await finished(runner, r.job.id);
    expect(job.status).toBe('cancelled');
    expect((await runner.log(job.id)).some((l) => l.message.includes('did not stop'))).toBe(true);
  });

  it('a crash is a failure with the last stderr lines', async () => {
    const { runner } = setup('crash');
    const r = await runner.start({ ...START, project });
    if (!r.ok) throw new Error(r.error);
    const job = await finished(runner, r.job.id);
    expect(job.status).toBe('failed');
    expect(job.error).toMatch(/exit code 3.*Fatal Python error: boom/);
  });

  it('refuses bad params, a missing project and a missing pack before spawning', async () => {
    const { runner, spawned } = setup('ok');
    const bad = await runner.start({
      pipeline: 'aik.cameras',
      project,
      params: { photos: 'x', out: '../x' },
    });
    expect(bad).toMatchObject({
      ok: false,
      error: expect.stringContaining('inside the project') as string,
    });
    const missing = await runner.start({ ...START, project: join(base, 'nope') });
    expect(missing).toMatchObject({
      ok: false,
      error: expect.stringContaining('does not exist') as string,
    });
    const nopack = await setup('ok', { pack: false }).runner.start({ ...START, project });
    expect(nopack).toEqual({ ok: false, error: 'No pipeline pack in X.' });
    expect(spawned).toEqual([]);
  });

  it('an index left with running jobs loads them as interrupted', async () => {
    const file = join(base, 'jobs.json');
    const job: JobRecord = {
      id: 'j1',
      pipeline: 'system.selftest',
      project,
      params: {},
      status: 'running',
      progress: 0.3,
      steps: [{ name: 'one', state: 'running' }],
      artifacts: [],
      createdAt: '2026-10-04T10:00:00.000Z',
      updatedAt: '2026-10-04T10:00:00.000Z',
    };
    await import('node:fs/promises').then((fs) => fs.writeFile(file, JSON.stringify([job])));
    const store = new JobStore(file);
    await store.load();
    expect(store.get('j1')?.status).toBe('interrupted');
    expect(store.get('j1')?.steps[0]?.state).toBe('cancelled');
  });
});
