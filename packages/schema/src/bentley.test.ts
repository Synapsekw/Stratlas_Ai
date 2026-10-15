import { describe, expect, it } from 'vitest';
import { ImportItem } from './builder';
import { ipc } from './ipc';
import {
  BentleyImportParams,
  PIPELINES,
  PipelineName,
  PointcloudToCopcParams,
  pipelineParams,
} from './jobs';
import { LensModel, PhotoRef } from './layers';

describe('Bentley import contract', () => {
  it('keeps a pinhole lens valid with and without the principal point and distortion', () => {
    const plain = { model: 'pinhole', hfovDeg: 70.2, aspect: 1.3347 };
    expect(LensModel.parse(plain)).toEqual(plain);
    const full = {
      ...plain,
      cx: 2656.9,
      cy: 1965.6,
      k1: 0.0027,
      k2: -0.0088,
      k3: 0.006,
      p1: 3e-5,
      p2: -1.4e-4,
    };
    expect(LensModel.parse(full)).toEqual(full);
    const photo = {
      id: 'p1',
      src: { path: 'photos/r/p1.jpg' },
      pos: [1, 2, 3],
      q: [0, 0, 0, 1],
      lens: full,
    };
    expect(PhotoRef.parse(photo).lens).toEqual(full);
    expect(LensModel.safeParse({ ...plain, k1: 'x' }).success).toBe(false);
  });

  it('names the job, lists it and checks its parameters', () => {
    expect(PipelineName.options).toContain('bentley.import');
    expect(PIPELINES.find((p) => p.name === 'bentley.import')?.title).toBe('Bentley import');
    expect(pipelineParams('bentley.import')).toBe(BentleyImportParams);
    const ok = { xml: 'D:/jobs/at.xml', photos: 'D:/jobs/photos' };
    expect(BentleyImportParams.parse(ok)).toEqual(ok);
    expect(BentleyImportParams.parse({ ...ok, name: 'Tower block' }).name).toBe('Tower block');
    expect(BentleyImportParams.safeParse({ xml: 'D:/jobs/at.xml' }).success).toBe(false);
    expect(BentleyImportParams.safeParse({ ...ok, name: '' }).success).toBe(false);
    expect(BentleyImportParams.safeParse({ ...ok, bogus: 1 }).success).toBe(false);
  });

  it('lets the raw import report a Bentley block', () => {
    expect(ImportItem.parse({ file: 'at.xml', kind: 'bentley', status: 'queued' }).kind).toBe(
      'bentley',
    );
  });

  it('takes a survey day for a cloud and the dates Add data chose', () => {
    const src = { src: 'D:/jobs/cloud.zpc' };
    expect(PointcloudToCopcParams.parse({ ...src, surveyDate: '2026-10-07' }).surveyDate).toBe(
      '2026-10-07',
    );
    expect(PointcloudToCopcParams.safeParse({ ...src, surveyDate: '7 Oct' }).success).toBe(false);
    const req = ipc['builder:import'].request.parse({
      projectId: 'p',
      paths: ['D:/jobs/cloud.zpc'],
      cloudDates: { 'D:/jobs/cloud.zpc': '2026-10-07', 'D:/jobs/other.zpc': null },
    });
    expect(req.cloudDates).toEqual({
      'D:/jobs/cloud.zpc': '2026-10-07',
      'D:/jobs/other.zpc': null,
    });
    const res = ipc['builder:cloudDates'].response.parse({
      ok: true,
      clouds: [{ path: 'D:/jobs/cloud.zpc', name: 'cloud.zpc', headerDay: null }],
    });
    expect(res.ok).toBe(true);
  });
});
