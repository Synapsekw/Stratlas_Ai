import type { JobRecord } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { buildParams, FORMS, finishedManifestJob, TILESET_WRITERS } from './jobs';

const job = (pipeline: JobRecord['pipeline'], status: JobRecord['status']): JobRecord => ({
  id: `j-${pipeline}`,
  pipeline,
  project: 'E:/data/projects/site',
  params: {},
  status,
  progress: status === 'done' ? 1 : 0.5,
  steps: [],
  artifacts: [],
  createdAt: '2026-10-08T08:00:00.000Z',
  updatedAt: '2026-10-08T08:00:00.000Z',
});

describe('M10 jobs and the open project', () => {
  it('reloads the manifest after the jobs that add layers, not after the others', () => {
    const reloads = (p: JobRecord['pipeline']) =>
      finishedManifestJob([job(p, 'running')], [job(p, 'done')], 'e:/data/projects/site');
    expect(reloads('photo.products')).toBe(true);
    expect(reloads('opf.import')).toBe(true);
    // the run folder only
    expect(reloads('photo.align')).toBe(false);
    expect(reloads('photo.georef')).toBe(false);
    expect(reloads('opf.export')).toBe(false);
    // tilesets.json and the data folder: listed again by the site view, not the manifest
    expect(reloads('tiles.mesh')).toBe(false);
    expect(reloads('tiles.cloud')).toBe(false);
    expect(reloads('packs.imagery')).toBe(false);
    expect(reloads('packs.terrain')).toBe(false);
    expect([...TILESET_WRITERS].sort()).toEqual(['photo.products', 'tiles.cloud', 'tiles.mesh']);
  });
});

describe('list fields', () => {
  it('sends the ticked products of photo.products as a list', () => {
    const field = FORMS['photo.products'].find((f) => f.key === 'products');
    expect(field?.kind).toBe('list');
    expect(field?.options?.map((o) => o.value)).toEqual([
      'ortho',
      'dsm',
      'dtm',
      'cloud',
      'mesh',
      'tiles',
    ]);
    expect(buildParams('photo.products', { run: '20261007-0915', products: 'ortho' })).toEqual({
      ok: true,
      params: { run: '20261007-0915', products: ['ortho'] },
    });
    expect(
      buildParams('photo.products', { run: '20261007-0915', products: 'ortho,dsm, mesh,ortho' }),
    ).toEqual({
      ok: true,
      params: { run: '20261007-0915', products: ['ortho', 'dsm', 'mesh'] },
    });
    expect(buildParams('photo.products', { run: '20261007-0915', products: '' })).toEqual({
      ok: false,
      error: 'Products is required.',
    });
    expect(buildParams('photo.products', { run: '20261007-0915', products: ',' })).toEqual({
      ok: false,
      error: 'Products is required.',
    });
    expect(
      buildParams('photo.products', { run: '20261007-0915', products: 'ortho,video' }),
    ).toEqual({ ok: false, error: 'Products: "video" is not one of the choices.' });
  });

  it('leaves an optional list out when nothing is ticked (OPF import brings in all)', () => {
    expect(buildParams('opf.import', { src: 'D:/opf/project.opf' })).toEqual({
      ok: true,
      params: { src: 'D:/opf/project.opf' },
    });
    expect(
      buildParams('opf.import', { src: 'D:/opf/project.opf', products: 'cloud,mesh' }),
    ).toEqual({ ok: true, params: { src: 'D:/opf/project.opf', products: ['cloud', 'mesh'] } });
  });

  it('offers every array parameter of a form as a list of fixed choices', () => {
    for (const [pipeline, fields] of Object.entries(FORMS))
      for (const f of fields.filter((x) => x.kind === 'list'))
        expect(f.options?.length, `${pipeline}.${f.key}`).toBeGreaterThan(0);
  });
});
