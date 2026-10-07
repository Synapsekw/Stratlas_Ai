import { describe, expect, it } from 'vitest';
import {
  ipc,
  ipcEvents,
  JobRecord,
  newJobId,
  PipelinePackManifest,
  PIPELINES,
  pipelineParams,
  type JobRecord as JobRecordT,
} from './index';

const record: JobRecordT = {
  id: '20261004-101500-aik-cameras-a1b2',
  pipeline: 'aik.cameras',
  project: 'E:/Stratlas Data/projects/ebsm',
  params: { photos: 'E:/raw' },
  status: 'running',
  progress: 0.4,
  steps: [{ name: 'scan', title: 'Read photo metadata', state: 'done' }],
  artifacts: [],
  createdAt: '2026-10-04T10:15:00.000Z',
  updatedAt: '2026-10-04T10:15:02.000Z',
};

describe('pipeline params', () => {
  it('accepts the cameras params the app sends and refuses unknown keys', () => {
    const p = pipelineParams('aik.cameras');
    expect(
      p.safeParse({ photos: 'C:/raw', origin: [29.02, 48.13, 31.7], longEdge: 2560 }).success,
    ).toBe(true);
    expect(p.safeParse({ photos: 'C:/raw', bogus: 1 }).success).toBe(false);
    expect(p.safeParse({ photos: 'C:/raw', origin: [95, 0, 0] }).success).toBe(false);
  });

  it('keeps outputs inside the project', () => {
    const p = pipelineParams('aik.records');
    expect(p.safeParse({ out: 'records.json' }).success).toBe(true);
    expect(p.safeParse({ out: '../escape.json' }).success).toBe(false);
    expect(p.safeParse({ out: 'C:/abs.json' }).success).toBe(false);
  });

  it('takes a volumetric build as surveys with a DSM or a point cloud each', () => {
    const p = pipelineParams('volumetric.build');
    const dsm = { date: '2026-01-01', dsm: 'D:/s/e1_dsm.tif', ortho: 'D:/s/e1_ortho.tif' };
    const cloud = { date: '2026-01-10', cloud: 'D:/s/e2.laz' };
    expect(p.safeParse({ config: { epochs: [dsm, cloud] } }).success).toBe(true);
    expect(p.safeParse({ job: 'volumetric/job.json' }).success).toBe(true);
    expect(p.safeParse({}).success).toBe(true);
    expect(p.safeParse({ config: { epochs: [] } }).success).toBe(false);
    expect(p.safeParse({ config: { epochs: [dsm, cloud, dsm] } }).success).toBe(false);
    expect(p.safeParse({ config: { epochs: [{ date: '2026-01-01' }] } }).success).toBe(false);
    expect(p.safeParse({ config: { epochs: [{ ...dsm, cloud: 'D:/s/e1.laz' }] } }).success).toBe(
      false,
    );
    expect(p.safeParse({ config: { epochs: [{ ...dsm, date: '1 Jan' }] } }).success).toBe(false);
    expect(p.safeParse({ config: { epochs: [dsm] }, out: 'x' }).success).toBe(false);
  });

  it('lists every pipeline with a title', () => {
    expect(PIPELINES.map((p) => p.name)).toEqual([
      'aik.cameras',
      'aik.project',
      'aik.records',
      'volumetric.process',
      'volumetric.build',
      'pointcloud.to_copc',
      'inspection.run',
      'road.build',
      'system.selftest',
      'change.raster',
      'change.surface',
      'change.cloud',
      'change.mesh',
      'change.frames',
      'drawing.import',
      'model.fit_cloud',
      'photo.align',
      'photo.georef',
      'photo.products',
      'opf.import',
      'opf.export',
      'tiles.mesh',
      'tiles.cloud',
      'packs.imagery',
      'packs.terrain',
    ]);
    for (const p of PIPELINES) expect(p.title.length).toBeGreaterThan(3);
  });

  it('takes the road builder inputs: one ortho or several blocks, units along the road or a grid', () => {
    const p = pipelineParams('road.build');
    expect(p.safeParse({ centreline: 'road/centreline-drawn.geojson' }).success).toBe(true);
    expect(
      p.safeParse({
        centreline: 'C:/raw/cl.dxf',
        centrelineEpsg: 32638,
        ortho: ['C:/raw/b1.tif', 'C:/raw/b2.tif'],
        defects: 'C:/raw/defects.shp',
        units: 'grid',
        unitLength: 15,
        gridOrigin: [787313.5, 3254469.2],
      }).success,
    ).toBe(true);
    expect(p.safeParse({}).success).toBe(false);
    expect(p.safeParse({ centreline: 'x', units: 'hex' }).success).toBe(false);
    expect(p.safeParse({ centreline: 'x', laneWidth: 12 }).success).toBe(false);
  });
});

describe('job ids, records and events', () => {
  it('makes ids the Python runtime accepts', () => {
    // The stamp is the workstation's local time, so the instant is built in local time: an
    // instant in UTC falls on another day east of UTC+13 (Kiritimati) or west of UTC-10.
    const id = newJobId('volumetric.process', new Date(2026, 9, 4, 10, 15, 0), () => 0.5);
    expect(id).toMatch(/^20261004-101500-volumetric-process-[0-9a-z]{4}$/);
    expect(id).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/);
  });

  it('validates a job record and the jobs:event union', () => {
    expect(JobRecord.safeParse(record).success).toBe(true);
    expect(ipcEvents['jobs:event'].safeParse({ type: 'update', job: record }).success).toBe(true);
    expect(
      ipcEvents['jobs:event'].safeParse({
        type: 'log',
        jobId: record.id,
        line: { time: record.createdAt, level: 'info', message: 'hi' },
      }).success,
    ).toBe(true);
  });

  it('starts a job or resumes one, nothing else', () => {
    const start = ipc['jobs:start'].request;
    expect(
      start.safeParse({ pipeline: 'aik.cameras', project: 'E:/p', params: { photos: 'x' } })
        .success,
    ).toBe(true);
    expect(start.safeParse({ resume: record.id }).success).toBe(true);
    expect(start.safeParse({ resume: '../x' }).success).toBe(false);
    expect(start.safeParse({ pipeline: 'rm -rf', project: 'E:/p', params: {} }).success).toBe(
      false,
    );
  });

  it('reads a pipeline pack manifest', () => {
    const m = PipelinePackManifest.safeParse({
      schema: 'aio.pipeline-pack/1',
      version: '0.1.0',
      protocol: 'aio.pipelines/1',
      python: { version: '3.13.7', build: '20260924', executable: 'python/python.exe' },
      platform: 'win32-x64',
      createdAt: '2026-10-04T10:00:00Z',
      pipelines: [{ name: 'aik.cameras', title: 'Cameras from photos' }],
      files: { 'python/python.exe': { size: 10, sha256: 'a'.repeat(64) } },
    });
    expect(m.success).toBe(true);
  });
});
