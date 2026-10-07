import type { JobRecord } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { buildParams, FORMS, finishedManifestJob } from './jobs';

/** The OPF job forms (M10 stream G5): opf.import and opf.export from the Jobs panel. */
const job = (over: Partial<JobRecord> = {}): JobRecord => ({
  id: 'o1',
  pipeline: 'opf.import',
  project: 'E:\\p',
  params: { src: 'D:\\survey\\project.opf' },
  status: 'running',
  progress: 0.2,
  steps: [],
  artifacts: [],
  createdAt: '2026-10-07T10:00:00.000Z',
  updatedAt: '2026-10-07T10:00:00.000Z',
  ...over,
});

describe('OPF job forms', () => {
  it('imports an OPF project, with a photos folder when its paths do not resolve', () => {
    expect(buildParams('opf.import', { src: 'D:/survey/project.opf' })).toEqual({
      ok: true,
      params: { src: 'D:/survey/project.opf' },
    });
    expect(
      buildParams('opf.import', { src: 'D:/survey/project.opf', photosRoot: 'D:/survey/images' }),
    ).toEqual({
      ok: true,
      params: { src: 'D:/survey/project.opf', photosRoot: 'D:/survey/images' },
    });
    expect(buildParams('opf.import', {})).toEqual({ ok: false, error: 'OPF project is required.' });
    expect(FORMS['opf.import'].find((f) => f.key === 'src')?.filters?.[0]?.extensions).toContain(
      'opf',
    );
  });

  it('exports a run to a folder and checks the run id', () => {
    expect(buildParams('opf.export', { run: '20261007-0915', out: 'D:/out/opf' })).toEqual({
      ok: true,
      params: { run: '20261007-0915', out: 'D:/out/opf' },
    });
    expect(buildParams('opf.export', { run: 'a run', out: 'D:/out' })).toMatchObject({ ok: false });
    expect(buildParams('opf.export', { run: '20261007-0915' })).toEqual({
      ok: false,
      error: 'Export to folder is required.',
    });
  });

  it('reloads the open project when an OPF import of it finishes, not when an export does', () => {
    const running = job();
    const done = { ...running, status: 'done' as const };
    expect(finishedManifestJob([running], [done], 'e:/p')).toBe(true);
    const exp = job({ id: 'o2', pipeline: 'opf.export', params: { run: 'r', out: 'D:/o' } });
    expect(finishedManifestJob([exp], [{ ...exp, status: 'done' }], 'e:/p')).toBe(false);
  });
});
