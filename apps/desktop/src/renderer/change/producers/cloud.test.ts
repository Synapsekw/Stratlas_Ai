import { changeProducers, type ChangePairContext } from '@aio/change';
import {
  ChangeSet,
  DEFAULT_CHANGE_THRESHOLDS,
  pipelineParams,
  type JobRecord,
  type Layer,
  type ProjectManifest,
} from '@aio/schema';
import { describe, expect, it, vi } from 'vitest';
import {
  changeCloudLayers,
  cloudChangeFinished,
  cloudChangeProducer,
  cloudJob,
  cloudPair,
  registerCloudChangeProducers,
  surfaceSetId,
  surfaceVolumes,
  volumeJob,
} from './cloud';

type Cloud = Extract<Layer, { kind: 'pointcloud' }>;

const cloud = (id: string, name: string, extra: Partial<Cloud> = {}): Cloud => ({
  kind: 'pointcloud',
  id,
  name,
  visible: true,
  src: { path: `clouds/${id}.copc.laz` },
  format: 'copc',
  ...extra,
});

const ctx = (layersFrom: Layer[], layersTo: Layer[]): ChangePairContext => ({
  projectId: 'p',
  manifest: { id: 'p', layers: [...layersFrom, ...layersTo] } as unknown as ProjectManifest,
  from: 'c1',
  to: 'c2',
  layersFrom,
  layersTo,
});

describe('the cloud pair of two dates', () => {
  it('takes the one COPC cloud of each date', () => {
    const r = cloudPair(ctx([cloud('a', 'Scan 10 Jan')], [cloud('b', 'Scan 10 Feb')]));
    expect(r).toMatchObject({ from: { id: 'a' }, to: { id: 'b' } });
  });

  it('matches counterparts by name when a date has several, and leaves change clouds out', () => {
    const r = cloudPair(
      ctx(
        [cloud('a1', 'Tank farm 2026-01-10'), cloud('a2', 'Jetty 2026-01-10')],
        [
          cloud('b2', 'Jetty 2026-02-10'),
          cloud('b1', 'Tank farm 2026-02-10'),
          cloud('ch', 'Cloud change', { derived: { kind: 'change', from: 'c1', to: 'c2' } }),
        ],
      ),
    );
    expect(r).toMatchObject({ from: { id: 'a1' }, to: { id: 'b1' } });
  });

  it('says what is missing', () => {
    expect(cloudPair(ctx([cloud('a', 'A')], []))).toMatch(/point cloud/);
    const packed = cloud('k', 'Kit', { format: 'kit-packed' });
    expect(cloudPair(ctx([packed], [cloud('b', 'B')]))).toMatch(/COPC/);
  });
});

describe('the cloud change job', () => {
  it('fills the founder thresholds and the date pair, and passes the contract', () => {
    const job = cloudJob(
      ctx([cloud('a', 'A')], [cloud('b', 'B')]),
      'E:/projects/p',
      DEFAULT_CHANGE_THRESHOLDS,
    );
    expect(job).toEqual({
      pipeline: 'change.cloud',
      project: 'E:/projects/p',
      params: {
        layerFrom: 'a',
        layerTo: 'b',
        captures: { from: 'c1', to: 'c2' },
        minDistM: 0.05,
        maxDistM: 0.3,
      },
    });
    if (typeof job === 'string') throw new Error(job);
    expect(pipelineParams('change.cloud').safeParse(job.params).success).toBe(true);
  });

  it('starts the volume change of the same clouds (change.surface on clouds)', () => {
    const job = volumeJob(ctx([cloud('a', 'A')], [cloud('b', 'B')]), 'E:/projects/p');
    if (typeof job === 'string') throw new Error(job);
    expect(job.params).toEqual({
      from: { layer: 'a', kind: 'cloud' },
      to: { layer: 'b', kind: 'cloud' },
      captures: { from: 'c1', to: 'c2' },
    });
    expect(pipelineParams('change.surface').safeParse(job.params).success).toBe(true);
  });
});

describe('the cloud change producer', () => {
  const deps = (error: string | null = null) => ({
    projectRoot: () => 'E:/projects/p',
    thresholds: () => DEFAULT_CHANGE_THRESHOLDS,
    start: vi.fn(() => Promise.resolve(error ? { error } : { jobId: 'job-1' })),
  });

  it('is offered when both dates have a COPC cloud, and starts change.cloud', async () => {
    const d = deps();
    const p = cloudChangeProducer(d);
    expect(p).toMatchObject({ id: 'cloud', label: 'Run cloud change', kinds: ['region'] });
    const c = ctx([cloud('a', 'A')], [cloud('b', 'B')]);
    expect(p.available(c)).toBe(true);
    expect(p.available(ctx([], []))).toMatch(/point cloud/);
    await expect(p.run(c)).resolves.toEqual({ ok: true, jobId: 'job-1' });
    expect(d.start).toHaveBeenCalledWith(expect.objectContaining({ pipeline: 'change.cloud' }));
  });

  it('reports a job that could not start', async () => {
    const p = cloudChangeProducer(deps('No pipeline pack.'));
    await expect(p.run(ctx([cloud('a', 'A')], [cloud('b', 'B')]))).resolves.toEqual({
      ok: false,
      error: 'No pipeline pack.',
    });
    await expect(
      cloudChangeProducer({ ...deps(), projectRoot: () => null }).run(
        ctx([cloud('a', 'A')], [cloud('b', 'B')]),
      ),
    ).resolves.toMatchObject({ ok: false });
  });

  it('registers the cloud and model producers once', () => {
    const stop = registerCloudChangeProducers(deps());
    expect(changeProducers().map((p) => p.id)).toEqual(['cloud', 'mesh']);
    expect(registerCloudChangeProducers(deps())).toBe(stop);
    stop();
    expect(changeProducers()).toEqual([]);
  });
});

describe('the volume change of the same dates (read only, from change.surface)', () => {
  const set = (stats: Record<string, number>) =>
    ChangeSet.parse({
      schema: 'aio.change/1',
      id: 'c1-c2-surface',
      from: 'c1',
      to: 'c2',
      producer: 'change.surface',
      createdAt: '2026-10-06T10:00:00Z',
      items: [
        {
          kind: 'region',
          id: 'region:1',
          verdict: 'fill',
          volume: { cutM3: 0, fillM3: 120.5, netM3: 120.5 },
        },
        {
          kind: 'region',
          id: 'region:2',
          verdict: 'cut',
          volume: { cutM3: 40, fillM3: 0, netM3: -40 },
        },
      ],
      stats,
    });

  it('names the set as the pipeline does', () => {
    expect(surfaceSetId('c1', 'c2')).toBe('c1-c2-surface');
  });

  it('takes the site totals from the stats, else adds up the regions', () => {
    expect(surfaceVolumes(set({ fillM3: 130, cutM3: 41, netM3: 89 }))).toEqual({
      id: 'c1-c2-surface',
      fillM3: 130,
      cutM3: 41,
      netM3: 89,
      regions: 2,
      createdAt: '2026-10-06T10:00:00Z',
    });
    expect(surfaceVolumes(set({}))).toMatchObject({ fillM3: 120.5, cutM3: 40, netM3: 80.5 });
    expect(surfaceVolumes({ ...set({}), producer: 'change.raster' })).toBeNull();
  });
});

describe('change layers and finished jobs', () => {
  it('finds the change clouds and their dates', () => {
    const layers: Layer[] = [
      cloud('a', 'A'),
      cloud('ch', 'Cloud change', {
        derived: { kind: 'change', from: 'c1', to: 'c2', source: ['a', 'b'] },
        scalar: {
          dim: 'Distance',
          label: 'Distance',
          unit: 'm',
          range: [0, 0.3],
          diverging: false,
        },
      }),
    ];
    expect(changeCloudLayers(layers).map((l) => l.id)).toEqual(['ch']);
  });

  it('tells when a cloud change of the open project has just finished', () => {
    const job = (id: string, pipeline: string, status: JobRecord['status']) =>
      ({ id, pipeline, status, project: 'E:\\projects\\p\\' }) as unknown as JobRecord;
    const before = [job('1', 'change.cloud', 'running'), job('2', 'change.mesh', 'running')];
    const after = [job('1', 'change.cloud', 'done'), job('2', 'change.mesh', 'done')];
    expect(cloudChangeFinished(before, after, 'e:/projects/p')).toBe(true);
    expect(cloudChangeFinished(after, after, 'e:/projects/p')).toBe(false);
    expect(cloudChangeFinished(before, after, 'e:/projects/other')).toBe(false);
    expect(
      cloudChangeFinished(
        [job('2', 'change.mesh', 'running')],
        [job('2', 'change.mesh', 'done')],
        'e:/projects/p',
      ),
    ).toBe(false);
  });
});
