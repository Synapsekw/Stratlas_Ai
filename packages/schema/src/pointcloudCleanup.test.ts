import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ipc } from './ipc';
import { LayerDerived } from './layers';
import { PIPELINES, PipelineName, SurveyExportParams, pipelineParams } from './jobs';
import {
  MAX_LASSO_VERTICES,
  NoiseRun,
  POINTCLOUD_CLEAN_MIN_PACK,
  PointcloudCleanParams,
  PointcloudCleanup,
  cleanupRemoves,
  emptyCleanup,
  isEmptyCleanup,
  noiseCopyPath,
  noiseRunPath,
  pccleanupPath,
} from './pointcloudCleanup';
import { SCHEMA_REGISTRY, readerFor } from './versions';

const ORTHO = [0.02, 0, 0, 0, 0, 0.02, 0, 0, 0, 0, 0, 0, -10001, -64001, 0, 1];
const square = (): [number, number][] => [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
];
const region = (over: Record<string, unknown> = {}) => ({
  id: 'r1',
  shape: 'box',
  viewProj: ORTHO,
  polygon: square(),
  action: { kind: 'delete' },
  ...over,
});
const recipe = (over: Record<string, unknown> = {}) => ({
  ...emptyCleanup('cloud-a'),
  ...over,
});

describe('the cleanup recipe (aio.pccleanup/1)', () => {
  it('starts empty and knows when it changes nothing', () => {
    const r = emptyCleanup('cloud-a');
    expect(r).toEqual({
      schema: 'aio.pccleanup/1',
      layerId: 'cloud-a',
      hiddenClasses: [],
      regions: [],
    });
    expect(PointcloudCleanup.parse(r)).toEqual(r);
    expect(isEmptyCleanup(r)).toBe(true);
    expect(isEmptyCleanup({ ...r, hiddenClasses: [7] })).toBe(false);
    expect(isEmptyCleanup({ ...r, height: {} })).toBe(true);
  });

  it('takes a clip box, a height range, classes, regions and a noise run', () => {
    const r = recipe({
      clipBox: { center: [500050, 3200050, 20], size: [60, 60, 40], yaw: 0.5, keep: 'inside' },
      height: { min: 0, max: 20 },
      hiddenClasses: [7, 18],
      regions: [
        region(),
        region({ id: 'r2', shape: 'lasso', action: { kind: 'class', value: 2 } }),
      ],
      noise: {
        path: noiseCopyPath('cloud-a', '20261015-101500-pointcloud-clean-a1b2'),
        params: { outlier: { meanK: 8, multiplier: 2 } },
        marked: 12,
        total: 16000,
        runId: '20261015-101500-pointcloud-clean-a1b2',
      },
    });
    expect(PointcloudCleanup.safeParse(r).success).toBe(true);
  });

  it('refuses a lasso of 257 vertices and a box of 3 corners', () => {
    const many = Array.from({ length: MAX_LASSO_VERTICES + 1 }, (_, i): [number, number] => [
      Math.cos(i),
      Math.sin(i),
    ]);
    expect(
      PointcloudCleanup.safeParse(recipe({ regions: [region({ shape: 'lasso', polygon: many })] }))
        .success,
    ).toBe(false);
    expect(
      PointcloudCleanup.safeParse(
        recipe({ regions: [region({ shape: 'lasso', polygon: many.slice(0, 256) })] }),
      ).success,
    ).toBe(true);
    expect(
      PointcloudCleanup.safeParse(recipe({ regions: [region({ polygon: square().slice(0, 3) })] }))
        .success,
    ).toBe(false);
  });

  it('caps regions at 200 and checks the matrix, classes and heights', () => {
    const r200 = Array.from({ length: 200 }, (_, i) => region({ id: `r${String(i)}` }));
    expect(PointcloudCleanup.safeParse(recipe({ regions: r200 })).success).toBe(true);
    expect(
      PointcloudCleanup.safeParse(recipe({ regions: [...r200, region({ id: 'x' })] })).success,
    ).toBe(false);
    expect(
      PointcloudCleanup.safeParse(recipe({ regions: [region({ viewProj: ORTHO.slice(1) })] }))
        .success,
    ).toBe(false);
    expect(PointcloudCleanup.safeParse(recipe({ hiddenClasses: [256] })).success).toBe(false);
    expect(PointcloudCleanup.safeParse(recipe({ hiddenClasses: [7, 7] })).success).toBe(false);
    expect(PointcloudCleanup.safeParse(recipe({ height: { min: 5, max: 1 } })).success).toBe(false);
    expect(
      PointcloudCleanup.safeParse(
        recipe({ clipBox: { center: [0, 0, 0], size: [0, 1, 1], yaw: 0, keep: 'inside' } }),
      ).success,
    ).toBe(false);
    expect(PointcloudCleanup.safeParse({ ...recipe(), extra: 1 }).success).toBe(false);
  });

  it('keeps the working copy and its record inside edits/pointcloud', () => {
    expect(pccleanupPath('cloud-a')).toBe('edits/pointcloud/cloud-a.json');
    expect(noiseCopyPath('cloud-a', 'j1')).toBe('edits/pointcloud/cloud-a.noise-j1.copc.laz');
    expect(noiseRunPath('cloud-a', 'j1')).toBe('edits/pointcloud/cloud-a.noise-j1.json');
    const run = {
      path: 'clouds/a.copc.laz',
      params: { outlier: { meanK: 8, multiplier: 2 } },
      marked: 0,
      total: 1,
      runId: 'j1',
    };
    expect(NoiseRun.safeParse(run).success).toBe(false);
    expect(NoiseRun.safeParse({ ...run, path: noiseCopyPath('cloud-a', 'j1') }).success).toBe(true);
  });

  it('says what a save or an export removes', () => {
    expect(
      cleanupRemoves(
        recipe({
          clipBox: { center: [0, 0, 0], size: [1, 1, 1], yaw: 0, keep: 'outside' },
          height: { max: 3 },
          hiddenClasses: [7],
          regions: [region(), region({ id: 'r2', action: { kind: 'hide' } })],
        }),
      ),
    ).toEqual({ box: 'inside', height: true, deletes: 1, hiddenClasses: [7] });
  });
});

describe('the pointcloud.clean pipeline and the export', () => {
  it('is a pipeline with a title and two modes', () => {
    expect(PipelineName.options).toContain('pointcloud.clean');
    expect(PIPELINES.find((p) => p.name === 'pointcloud.clean')?.title).toBe(
      'Clean up a point cloud',
    );
    const p = pipelineParams('pointcloud.clean');
    expect(
      p.safeParse({
        mode: 'noise',
        layerId: 'cloud-a',
        src: 'clouds/a.copc.laz',
        outlier: { meanK: 8, multiplier: 2 },
      }).success,
    ).toBe(true);
    expect(
      p.safeParse({
        mode: 'save',
        layerId: 'cloud-a',
        src: 'clouds/a.copc.laz',
        recipe: emptyCleanup('cloud-a'),
        name: 'Site scan',
      }).success,
    ).toBe(true);
    expect(PointcloudCleanParams.safeParse({ mode: 'save', layerId: 'a' }).success).toBe(false);
    expect(
      PointcloudCleanParams.safeParse({
        mode: 'noise',
        layerId: 'a',
        src: '../a.copc.laz',
        outlier: { meanK: 8, multiplier: 2 },
      }).success,
    ).toBe(false);
  });

  it('lets a cloud export carry a recipe', () => {
    const base = { what: 'cloud', format: 'laz', crs: 'site', layer: 'cloud-a', out: 'C:/x.laz' };
    expect(SurveyExportParams.safeParse(base).success).toBe(true);
    expect(
      SurveyExportParams.safeParse({ ...base, cleanup: emptyCleanup('cloud-a') }).success,
    ).toBe(true);
  });

  it('names a cleaned copy as derived from its source', () => {
    expect(
      LayerDerived.safeParse({ kind: 'cleanup', source: ['cloud-a'], runId: 'j1' }).success,
    ).toBe(true);
  });

  it('needs pack 0.10.0 or later', () => {
    expect(POINTCLOUD_CLEAN_MIN_PACK).toMatch(/^0\.1[01]\.0$/);
  });
});

describe('the cleanup channels and registry', () => {
  it('reads every recipe and writes one at a time', () => {
    const read = ipc['pointcloud:readCleanup'].request;
    expect(read.safeParse({ projectId: 'p' }).success).toBe(true);
    expect(
      read.safeParse({ projectId: 'p', noiseRun: { layerId: 'a', runId: 'j1' } }).success,
    ).toBe(true);
    const write = ipc['pointcloud:writeCleanup'].request;
    expect(write.safeParse({ projectId: 'p', layerId: 'a', recipe: null }).success).toBe(true);
    expect(
      write.safeParse({ projectId: 'p', layerId: 'a', recipe: emptyCleanup('a'), keep: [] })
        .success,
    ).toBe(true);
    expect(write.safeParse({ projectId: 'p', layerId: 'a' }).success).toBe(false);
  });

  it('registers aio.pccleanup/1 under edits/pointcloud since 0.16', () => {
    expect(SCHEMA_REGISTRY.find((e) => e.family === 'aio.pccleanup')).toMatchObject({
      version: 1,
      home: 'project',
      where: 'edits/pointcloud/<layer>.json',
      since: '0.16',
    });
    expect(readerFor('aio.pccleanup/1').kind).toBe('current');
  });
});

describe('the shared evaluator vectors', () => {
  const file = join(import.meta.dirname, '..', 'test-data', 'pccleanup-vectors.json');
  const v = JSON.parse(readFileSync(file, 'utf8')) as {
    points: { id: string; xyz: number[]; cls: number }[];
    cases: { name: string; recipe: unknown; expect: { state: string[]; cls: number[] } }[];
  };

  it('holds valid recipes and one outcome per point', () => {
    expect(v.cases.length).toBeGreaterThanOrEqual(14);
    for (const c of v.cases) {
      const r = PointcloudCleanup.safeParse(c.recipe);
      expect(r.success, `${c.name}: ${r.success ? '' : r.error.message}`).toBe(true);
      expect(c.expect.state).toHaveLength(v.points.length);
      expect(c.expect.cls).toHaveLength(v.points.length);
      for (const s of c.expect.state) {
        expect(['kept', 'hidden', 'classHidden', 'deleted', 'dropped'], c.name).toContain(s);
      }
    }
  });
});
