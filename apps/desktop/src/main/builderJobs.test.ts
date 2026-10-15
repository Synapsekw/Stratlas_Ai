import type { IpcRequest, JobRecord } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { builderPipelineJobs, type JobStarter } from './builderJobs';

function runner(found = true) {
  const started: IpcRequest<'jobs:start'>[] = [];
  const r: JobStarter = {
    list: () => Promise.resolve({ runtime: { found }, jobs: [] }),
    start: (req) => {
      started.push(req);
      return Promise.resolve({ ok: true, job: { id: 'job-1' } as JobRecord });
    },
  };
  return { r, started };
}

describe('builder conversions as pipeline jobs', () => {
  it('starts pointcloud.to_copc on the project folder with the cloud params only', async () => {
    const { r, started } = runner();
    const jobs = builderPipelineJobs(r);
    expect(await jobs.available()).toBe(true);
    const out = await jobs.start('pointcloud.toCopc', {
      projectRoot: 'E:/data/projects/site',
      src: 'D:/scans/site.laz',
      epsg: 32639,
      origin: [1, 2, 3],
      out: 'clouds/site.copc.laz',
    });
    expect(out).toEqual({ jobId: 'job-1' });
    expect(started).toEqual([
      {
        pipeline: 'pointcloud.to_copc',
        project: 'E:/data/projects/site',
        params: {
          src: 'D:/scans/site.laz',
          out: 'clouds/site.copc.laz',
          epsg: 32639,
          origin: [1, 2, 3],
        },
      },
    ]);
  });

  it('starts bentley.import with the block and its photos folder only', async () => {
    const { r, started } = runner();
    await builderPipelineJobs(r).start('bentley.import', {
      projectRoot: 'E:/data/projects/site',
      src: 'D:/jobs/at.xml',
      epsg: 32640,
      origin: [1, 2, 3],
      xml: 'D:/jobs/at.xml',
      photos: 'D:/jobs/photos',
    });
    expect(started).toEqual([
      {
        pipeline: 'bentley.import',
        project: 'E:/data/projects/site',
        params: { xml: 'D:/jobs/at.xml', photos: 'D:/jobs/photos' },
      },
    ]);
  });

  it('passes a cloud survey day to pointcloud.to_copc', async () => {
    const { r, started } = runner();
    await builderPipelineJobs(r).start('pointcloud.toCopc', {
      projectRoot: 'E:/data/projects/site',
      src: 'D:/scans/site.zpc',
      out: 'clouds/site.copc.laz',
      epsg: 32640,
      origin: [1, 2, 3],
      surveyDate: '2026-03-04',
    });
    expect(started).toEqual([
      {
        pipeline: 'pointcloud.to_copc',
        project: 'E:/data/projects/site',
        params: {
          src: 'D:/scans/site.zpc',
          out: 'clouds/site.copc.laz',
          epsg: 32640,
          origin: [1, 2, 3],
          surveyDate: '2026-03-04',
        },
      },
    ]);
  });

  it('starts drawing.import on a dropped DXF with its path only', async () => {
    const { r, started } = runner();
    await builderPipelineJobs(r).start('drawing.import', {
      projectRoot: 'E:/data/projects/site',
      src: 'D:/plans/plot.dxf',
      epsg: 32631,
      origin: [1, 2, 3],
    });
    expect(started).toEqual([
      {
        pipeline: 'drawing.import',
        project: 'E:/data/projects/site',
        params: { src: 'D:/plans/plot.dxf' },
      },
    ]);
  });

  it('starts design.import on a dropped design with its path only', async () => {
    const { r, started } = runner();
    await builderPipelineJobs(r).start('design.import', {
      projectRoot: 'E:/data/projects/site',
      src: 'D:/designs/pad.xml',
      epsg: 32639,
      origin: [1, 2, 3],
    });
    expect(started).toEqual([
      {
        pipeline: 'design.import',
        project: 'E:/data/projects/site',
        params: { src: 'D:/designs/pad.xml' },
      },
    ]);
  });

  it('starts opf.import on a dropped OPF project with its path only', async () => {
    const { r, started } = runner();
    await builderPipelineJobs(r).start('opf.import', {
      projectRoot: 'E:/data/projects/site',
      src: 'D:/pix4d/site/project.opf',
      epsg: 32639,
      origin: [1, 2, 3],
    });
    expect(started).toEqual([
      {
        pipeline: 'opf.import',
        project: 'E:/data/projects/site',
        params: { src: 'D:/pix4d/site/project.opf' },
      },
    ]);
  });

  it('says when the pack is missing or cannot convert a file type yet', async () => {
    expect(await builderPipelineJobs(runner(false).r).available()).toBe(false);
    await expect(
      builderPipelineJobs(runner().r).start('video.transcode', {
        projectRoot: 'E:/p',
        src: 'a.mov',
      }),
    ).rejects.toThrow(/cannot convert this file type yet/);
  });

  it('passes on a refusal from the job runner', async () => {
    const r: JobStarter = {
      list: () => Promise.resolve({ runtime: { found: true }, jobs: [] }),
      start: () => Promise.resolve({ ok: false, error: 'src: Required' }),
    };
    await expect(
      builderPipelineJobs(r).start('pointcloud.toCopc', { projectRoot: 'E:/p' }),
    ).rejects.toThrow('src: Required');
  });
});
