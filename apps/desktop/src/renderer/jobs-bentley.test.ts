import type { JobRecord } from '@aio/schema';
import { describe, expect, it, vi } from 'vitest';
import { IMPORT_FILTERS } from './builder/state';
import { buildParams, FORMS, finishedManifestJob } from './jobs';

// the builder store reaches main through the bridge; these tests only read its filters
vi.mock('./shell', () => ({ bridge: {}, shell: {} }));

const job = (pipeline: JobRecord['pipeline'], status: JobRecord['status']): JobRecord => ({
  id: `j-${pipeline}`,
  pipeline,
  project: 'E:/data/projects/site',
  params: {},
  status,
  progress: status === 'done' ? 1 : 0.5,
  steps: [],
  artifacts: [],
  createdAt: '2026-10-15T08:00:00.000Z',
  updatedAt: '2026-10-15T08:00:00.000Z',
});

describe('Bentley import in the app', () => {
  it('has a job form: the AT export and its photos folder', () => {
    expect(
      buildParams('bentley.import', { xml: 'D:/jobs/at.xml', photos: 'D:/jobs/photos' }),
    ).toEqual({
      ok: true,
      params: { xml: 'D:/jobs/at.xml', photos: 'D:/jobs/photos' },
    });
    expect(buildParams('bentley.import', { xml: 'D:/jobs/at.xml' }).ok).toBe(false);
    const xml = FORMS['bentley.import'].find((f) => f.key === 'xml');
    expect(xml?.filters?.[0]?.extensions).toEqual(['xml']);
    expect(FORMS['bentley.import'].find((f) => f.key === 'photos')?.kind).toBe('folder');
  });

  it('reloads the manifest when a Bentley import is done', () => {
    const p = 'bentley.import';
    expect(
      finishedManifestJob([job(p, 'running')], [job(p, 'done')], 'e:/data/projects/site'),
    ).toBe(true);
  });

  it('offers .zpc and .xml in Add data', () => {
    const raw = IMPORT_FILTERS[0]?.extensions ?? [];
    expect(raw).toEqual(expect.arrayContaining(['zpc', 'xml']));
  });
});
