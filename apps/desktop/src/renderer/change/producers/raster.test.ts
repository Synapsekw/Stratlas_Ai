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
  areaRasterParams,
  areaSurfaceParams,
  imageryProducers,
  misalignedOf,
  orthoPair,
  rasterParams,
  registerImageryProducers,
  startChangeRun,
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
const cloud = (id: string, format = 'copc'): Layer =>
  ({
    kind: 'pointcloud',
    id,
    name: id,
    visible: true,
    format,
    src: { path: `${id}.laz` },
  }) as Layer;

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

  it('starts the job in the open project', async () => {
    const start = vi.fn(() => Promise.resolve({ jobId: 'job-1' }));
    const [imagery] = imageryProducers(deps({ start }));
    const ctx = pair([raster('o1', 'ortho')], [raster('o2', 'ortho')]);
    expect(imagery?.available(ctx)).toBe(true);
    expect(await imagery?.run(ctx)).toEqual({ ok: true, jobId: 'job-1' });
    expect(start).toHaveBeenCalledWith(
      'change.raster',
      'C:/projects/site',
      expect.objectContaining({ layerFrom: 'o1', layerTo: 'o2' }),
    );
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

  it('offers shaded-relief DSMs and viewer clouds, whose heights the pipeline reads from sources', () => {
    const dsms = pair([raster('d1', 'dsm', 'kit-pyramid')], [raster('d2', 'dsm', 'kit-pyramid')]);
    expect(surfacePair(dsms)).toEqual({
      from: { layer: 'd1', kind: 'dsm' },
      to: { layer: 'd2', kind: 'dsm' },
    });
    const clouds = pair([cloud('p1', 'png-packed')], [cloud('p2', 'png-packed')]);
    expect(surfacePair(clouds)).toEqual({
      from: { layer: 'p1', kind: 'cloud' },
      to: { layer: 'p2', kind: 'cloud' },
    });
    expect(surfacePair(pair([raster('d1', 'dsm', 'pmtiles')], [cloud('p2')]))).toMatch(
      /DSM or a point/,
    );
  });

  it('leaves change layers and scalar clouds out', () => {
    const heat = { ...raster('h', 'dsm', 'kit-pyramid'), derived: { kind: 'change' } } as Layer;
    const scalar = {
      ...cloud('s', 'png-packed'),
      scalar: { dim: 'Distance', label: 'Distance', unit: 'm', range: [0, 0.3], diverging: false },
    } as Layer;
    expect(surfacePair(pair([raster('d1', 'dsm', 'cog')], [heat, scalar]))).toMatch(
      /DSM or a point/,
    );
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

describe('one area', () => {
  const AREA = {
    scope: { id: 'm-pad-a', name: 'Pad A' },
    ring: [
      [151.2, -33.8],
      [151.201, -33.8],
      [151.201, -33.801],
    ] as [number, number][],
  };

  it('limits imagery change to the polygon and files it under the area', () => {
    const ctx = pair([raster('o1', 'ortho')], [raster('o2', 'ortho')]);
    const params = areaRasterParams(ctx, AREA);
    if (typeof params === 'string') throw new Error(params);
    const parsed = ChangeRasterParams.parse(params);
    expect(parsed).toMatchObject({ layerFrom: 'o1', layerTo: 'o2', mask: AREA.ring });
    expect(parsed.scope).toEqual(AREA.scope);
    expect(areaRasterParams(pair([], [raster('o2', 'ortho')]), AREA)).toMatch(/ortho on each/);
  });

  it('limits surface change to the polygon and totals the area as one region', () => {
    const ctx = pair([raster('d1', 'dsm', 'cog')], [raster('d2', 'dsm', 'cog')]);
    const params = areaSurfaceParams(ctx, AREA);
    if (typeof params === 'string') throw new Error(params);
    const parsed = ChangeSurfaceParams.parse(params);
    expect(parsed.mask).toEqual(AREA.ring);
    expect(parsed.scope).toEqual(AREA.scope);
    expect(parsed.areas).toEqual([{ id: 'm-pad-a', name: 'Pad A', ring: AREA.ring }]);
    expect(areaSurfaceParams(pair([], []), AREA)).toMatch(/DSM or a point/);
  });

  it('a refused scoped run keeps its params for the replay', async () => {
    const setMisaligned = vi.fn();
    const job = {
      id: 'job-1',
      pipeline: 'change.raster',
      status: 'failed',
      failure: { code: 'misaligned', data: { from: 'c1', to: 'c2', shiftM: 2.01 } },
    } as unknown as JobRecord;
    const d = deps({ finished: () => Promise.resolve(job), setMisaligned });
    const ctx = pair([raster('o1', 'ortho')], [raster('o2', 'ortho')]);
    const params = areaRasterParams(ctx, AREA);
    if (typeof params === 'string') throw new Error(params);
    expect(await startChangeRun(d, { run: 0 }, 'raster', 'change.raster', params)).toEqual({
      ok: true,
      jobId: 'job-1',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(setMisaligned).toHaveBeenLastCalledWith({
      from: 'c1',
      to: 'c2',
      shiftM: 2.01,
      producer: 'raster',
      params,
    });
    expect(params).toMatchObject({ scope: AREA.scope, mask: AREA.ring });
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
});

describe('a refused run', () => {
  const failed = (over: Partial<JobRecord> = {}): JobRecord =>
    ({
      id: 'job-1',
      pipeline: 'change.raster',
      status: 'failed',
      error: 'The dates are 2.01 m apart. Line up the dates first.',
      failure: {
        code: 'misaligned',
        data: { from: 'c1', to: 'c2', shiftM: 2.01, shiftPx: 40, eastM: -2, northM: 0.2 },
      },
      ...over,
    }) as JobRecord;
  const orthos = pair([raster('o1', 'ortho')], [raster('o2', 'ortho')]);
  const dsms = pair([raster('s1', 'dsm', 'cog')], [raster('s2', 'dsm', 'cog')]);
  const run = async (id: string, job: JobRecord | null, over: Partial<ProducerDeps> = {}) => {
    const setMisaligned = vi.fn();
    const d = deps({ finished: () => Promise.resolve(job), setMisaligned, ...over });
    const producer = imageryProducers(d).find((p) => p.id === id);
    const r = await producer?.run(id === 'surface' ? dsms : orthos);
    // the end of the job is read after the run was handed back
    await new Promise((resolve) => setTimeout(resolve, 0));
    return { r, setMisaligned };
  };

  it('turns a misaligned refusal into the panel state', async () => {
    const imagery = await run('raster', failed());
    expect(imagery.r).toEqual({ ok: true, jobId: 'job-1' });
    expect(imagery.setMisaligned).toHaveBeenNthCalledWith(1, null);
    expect(imagery.setMisaligned).toHaveBeenLastCalledWith({
      from: 'c1',
      to: 'c2',
      shiftM: 2.01,
      producer: 'raster',
    });
    const surface = await run('surface', failed({ pipeline: 'change.surface' }));
    expect(surface.setMisaligned).toHaveBeenLastCalledWith(
      expect.objectContaining({ producer: 'surface' }),
    );
  });

  it('leaves another failure as it is', async () => {
    const other = failed({ error: 'Out of memory.' });
    delete other.failure;
    for (const job of [
      other,
      failed({ failure: { code: 'other', data: {} } }),
      failed({ status: 'done' }),
      failed({ failure: { code: 'misaligned', data: { from: 'c1' } } }),
      null,
    ]) {
      const { setMisaligned } = await run('raster', job);
      // only the clearing call before the run: nothing is kept for the panel
      expect(setMisaligned).toHaveBeenCalledTimes(1);
      expect(setMisaligned).toHaveBeenCalledWith(null);
    }
    expect(misalignedOf(other, 'raster')).toBeNull();
  });

  it('ignores a late refusal after the project changed or a newer run started', async () => {
    let finish: (job: JobRecord) => void = () => undefined;
    const waits: Promise<JobRecord | null>[] = [];
    let project = 'p1';
    const setMisaligned = vi.fn();
    const d = deps({
      projectId: () => project,
      setMisaligned,
      finished: () => {
        const w = new Promise<JobRecord | null>((resolve) => {
          finish = resolve;
        });
        waits.push(w);
        return w;
      },
    });
    const producer = imageryProducers(d).find((p) => p.id === 'raster');
    await producer?.run(orthos);
    project = 'p2';
    finish(failed());
    await waits[0];
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(setMisaligned).toHaveBeenCalledTimes(1);
    expect(setMisaligned).toHaveBeenCalledWith(null);

    project = 'p1';
    await producer?.run(orthos);
    const first = finish;
    await producer?.run(orthos);
    first(failed());
    await waits[1];
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(setMisaligned).not.toHaveBeenCalledWith(expect.objectContaining({ shiftM: 2.01 }));
  });
});
