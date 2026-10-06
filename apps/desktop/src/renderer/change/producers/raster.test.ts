import { changeProducers, type ChangePairContext } from '@aio/change';
import {
  ChangeRasterParams,
  ChangeSurfaceParams,
  ChangeThresholds,
  type JobRecord,
  type Layer,
  type ProjectManifest,
} from '@aio/schema';
import { describe, expect, it, vi } from 'vitest';
import {
  imageryProducers,
  jobDone,
  orthoPair,
  rasterParams,
  registerImageryProducers,
  surfacePair,
  surfaceParams,
  type ProducerDeps,
} from './raster';

const raster = (id: string, role: 'ortho' | 'dsm', format = 'kit-pyramid'): Layer =>
  ({
    kind: 'raster',
    id,
    name: id,
    visible: true,
    role,
    format,
    src: { path: `${id}.json` },
  }) as Layer;
const cloud = (id: string): Layer => ({
  kind: 'pointcloud',
  id,
  name: id,
  visible: true,
  format: 'copc',
  src: { path: `${id}.laz` },
});

function pair(from: Layer[], to: Layer[], common: Layer[] = []): ChangePairContext {
  return {
    projectId: 'p',
    manifest: {} as ProjectManifest,
    from: 'c1',
    to: 'c2',
    layersFrom: [...common, ...from],
    layersTo: [...common, ...to],
  };
}

function deps(over: Partial<ProducerDeps> = {}): ProducerDeps {
  return {
    root: () => 'C:/projects/site',
    thresholds: () => undefined,
    start: vi.fn(() => Promise.resolve({ jobId: 'job-1' })),
    follow: vi.fn(),
    ...over,
  };
}

describe('imagery change producer', () => {
  it('pairs the orthos of each date and leaves out common and derived layers', () => {
    const plan = raster('plan', 'ortho');
    const heat = { ...raster('heat', 'ortho'), derived: { kind: 'change' } } as Layer;
    const ctx = pair([raster('o1', 'ortho')], [heat, raster('o2', 'ortho')], [plan]);
    const p = orthoPair(ctx);
    expect(typeof p === 'string' ? p : [p.from.id, p.to.id]).toEqual(['o1', 'o2']);
    expect(orthoPair(pair([raster('o1', 'ortho')], [], [plan]))).toMatch(/ortho on each date/);
    expect(orthoPair(pair([raster('o1', 'ortho', 'pmtiles')], [raster('o2', 'ortho')]))).toMatch(
      /ortho on each date/,
    );
  });

  it('builds valid parameters from the Settings preset', () => {
    const ctx = pair([raster('o1', 'ortho')], [raster('o2', 'ortho')]);
    const p = orthoPair(ctx);
    if (typeof p === 'string') throw new Error(p);
    const params = rasterParams(ctx, p);
    expect(params).toEqual({
      from: 'c1',
      to: 'c2',
      layerFrom: 'o1',
      layerTo: 'o2',
      method: 'gradient',
      threshold: 0.5,
      minAreaM2: 2,
      maxShiftPx: 2,
    });
    expect(ChangeRasterParams.safeParse(params).success).toBe(true);
    const sensitive = ChangeThresholds.parse({ raster: { preset: 'sensitive' } });
    expect(rasterParams(ctx, p, sensitive)).toMatchObject({ threshold: 0.3, minAreaM2: 0.5 });
  });

  it('starts the job in the open project and follows it', async () => {
    const start = vi.fn(() => Promise.resolve({ jobId: 'job-1' }));
    const follow = vi.fn();
    const [imagery] = imageryProducers(deps({ start, follow }));
    const ctx = pair([raster('o1', 'ortho')], [raster('o2', 'ortho')]);
    expect(imagery?.available(ctx)).toBe(true);
    expect(await imagery?.run(ctx)).toEqual({ ok: true, jobId: 'job-1' });
    expect(start).toHaveBeenCalledWith(
      'change.raster',
      'C:/projects/site',
      expect.objectContaining({ layerFrom: 'o1', layerTo: 'o2' }),
    );
    expect(follow).toHaveBeenCalledWith('job-1');
  });

  it('says why it cannot run', async () => {
    const [imagery] = imageryProducers(deps({ root: () => null }));
    const ctx = pair([raster('o1', 'ortho')], [raster('o2', 'ortho')]);
    expect(await imagery?.run(ctx)).toEqual({ ok: false, error: 'Open a project first.' });
    const [failing] = imageryProducers(
      deps({ start: () => Promise.resolve({ error: 'No pack.' }) }),
    );
    expect(await failing?.run(ctx)).toEqual({ ok: false, error: 'No pack.' });
  });
});

describe('surface change producer', () => {
  it('prefers a DSM, else a point cloud, on each date', () => {
    const ctx = pair([raster('d1', 'dsm', 'cog'), cloud('p1')], [cloud('p2')]);
    expect(surfacePair(ctx)).toEqual({
      from: { layer: 'd1', kind: 'dsm' },
      to: { layer: 'p2', kind: 'cloud' },
    });
    expect(surfacePair(pair([raster('o1', 'ortho')], [cloud('p2')]))).toMatch(/DSM or a point/);
  });

  it('passes the date pair and the surface thresholds', () => {
    const ctx = pair([raster('d1', 'dsm', 'cog')], [raster('d2', 'dsm', 'cog')]);
    const p = surfacePair(ctx);
    if (typeof p === 'string') throw new Error(p);
    const params = surfaceParams(ctx, p);
    expect(params).toEqual({
      from: { layer: 'd1', kind: 'dsm' },
      to: { layer: 'd2', kind: 'dsm' },
      captures: { from: 'c1', to: 'c2' },
      minDepthM: 0.1,
      minAreaM2: 1,
    });
    expect(ChangeSurfaceParams.safeParse(params).success).toBe(true);
  });
});

describe('registration with the Changes panel', () => {
  it('registers both producers once and removes them', () => {
    const off = registerImageryProducers(deps());
    expect(registerImageryProducers(deps())).toBe(off);
    const ids = changeProducers().map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining(['raster', 'surface']));
    expect(changeProducers().find((p) => p.id === 'raster')?.label).toBe('Run imagery change');
    expect(changeProducers().find((p) => p.id === 'surface')?.label).toBe('Run surface change');
    off();
    expect(changeProducers().map((p) => p.id)).not.toContain('raster');
  });

  it('knows when a followed job is done', () => {
    const job = (status: JobRecord['status']) => ({ id: 'j', status }) as JobRecord;
    expect(jobDone([job('running')], [job('done')], 'j')).toBe(true);
    expect(jobDone([job('done')], [job('done')], 'j')).toBe(false);
    expect(jobDone([], [job('failed')], 'j')).toBe(false);
  });
});
