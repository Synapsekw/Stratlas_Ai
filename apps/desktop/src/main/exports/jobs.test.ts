import type { IpcEvent } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { createExportJobs, type ExportDeps } from './jobs';

function deps(over: Partial<ExportDeps> = {}) {
  const events: IpcEvent<'export:progress'>[] = [];
  const asked: string[] = [];
  const d: ExportDeps = {
    projectRoot: (id) => (id === 'hcl' ? 'E:/data/hcl' : undefined),
    projectName: () => Promise.resolve('HCl Tank'),
    downloadsDir: 'C:/Users/me/Downloads',
    chooseSavePath: (p) => {
      asked.push(p);
      return Promise.resolve('C:/out/file.csv');
    },
    runFile: (_job, progress) => {
      progress({ phase: 'Writing', done: 1, total: 2 });
      return Promise.resolve({ count: 13, bytes: 900 });
    },
    printReport: () => Promise.resolve({ count: 13, bytes: 5000 }),
    emit: (e) => events.push(e),
    ...over,
  };
  return { d, events, asked };
}

const req = { jobId: 'j1', projectId: 'hcl', format: 'csv' as const };

describe('export jobs', () => {
  it('asks where to save with a default name, runs the job and forwards progress', async () => {
    const { d, events, asked } = deps();
    const r = await createExportJobs(d).run(req);
    expect(asked).toEqual(['C:\\Users\\me\\Downloads\\HCl-Tank-issues.csv'.replace(/\\/g, sep())]);
    expect(r).toEqual({ ok: true, path: 'C:/out/file.csv', count: 13, bytes: 900 });
    expect(events).toEqual([{ jobId: 'j1', phase: 'Writing', done: 1, total: 2 }]);
  });

  it('returns a null path when the person cancels the dialog', async () => {
    const { d } = deps({ chooseSavePath: () => Promise.resolve(null) });
    expect(await createExportJobs(d).run(req)).toEqual({ ok: true, path: null });
  });

  it('prints the PDF report through the report window', async () => {
    let printed = '';
    const { d } = deps({
      printReport: (a) => {
        printed = a.outPath;
        return Promise.resolve({ count: 13, bytes: 5000 });
      },
    });
    const r = await createExportJobs(d).run({ ...req, format: 'report-pdf' });
    expect(printed).toBe('C:/out/file.csv');
    expect(r).toMatchObject({ ok: true, bytes: 5000 });
  });

  it('cancels a running job', async () => {
    const { d } = deps({
      runFile: (_job, _p, signal) =>
        new Promise((_res, rej) => {
          signal.addEventListener('abort', () => {
            rej(new Error('Export cancelled.'));
          });
        }),
    });
    const jobs = createExportJobs(d);
    const running = jobs.run(req);
    await new Promise((r) => setTimeout(r, 0));
    expect(jobs.cancel('j1')).toBe(true);
    expect(await running).toEqual({ ok: true, path: null });
    expect(jobs.cancel('j1')).toBe(false);
  });

  it('explains failures and unknown projects', async () => {
    const { d } = deps({ runFile: () => Promise.reject(new Error('Disk full')) });
    expect(await createExportJobs(d).run(req)).toEqual({ ok: false, error: 'Disk full' });
    expect(await createExportJobs(d).run({ ...req, projectId: 'nope' })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/not open/) as string,
    });
  });
});

function sep(): string {
  return process.platform === 'win32' ? '\\' : '/';
}
