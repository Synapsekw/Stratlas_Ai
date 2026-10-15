// Point cloud cleanup (plan 2026-10-15-pointcloud-cleanup), pinned against the 0.11 schema
// (tools/compat/schema-0.11):
// - the recipes, noise records and working copies live in `edits/pointcloud/`, which 0.11 never reads;
// - the job index lists pointcloud.clean jobs and survey.export jobs with a recipe, which 0.11's index
//   reader skips one by one instead of refusing the file;
// - the known break: a manifest holding a cleaned copy (`derived.kind: 'cleanup'`) is refused by
//   0.11 and every build before this one (LayerDerived is strict). Contract row of 15 Oct 2026.
import { describe, expect, it } from 'vitest';
import * as current from '../../packages/schema/src/index.ts';
import * as v011 from './schema-0.11/index.mjs';

const job = (pipeline, params) => ({
  id: '20261015-101500-pointcloud-clean-a1b2',
  pipeline,
  project: 'D:/data/projects/demo',
  params,
  status: 'done',
  progress: 1,
  steps: [],
  artifacts: [],
  createdAt: '2026-10-15T10:15:00Z',
  updatedAt: '2026-10-15T10:16:00Z',
});

const manifest = (layers) => ({
  schema: 'aio.project/1',
  id: 'demo',
  name: 'Demo',
  customer: 'Demo',
  site: 'Synthetic',
  crs: { epsg: 32639 },
  origin: [500000, 3200000, 0],
  captures: [],
  layers,
  severityModels: [],
  classCatalogues: [],
});
const cloud = {
  kind: 'pointcloud',
  id: 'cloud-a',
  name: 'Scan',
  visible: false,
  src: { path: 'clouds/a.copc.laz' },
  format: 'copc',
};

describe('point cloud cleanup is additive, but for cleaned copies', () => {
  it('keeps its files in edits/pointcloud, which 0.11 never reads', () => {
    const row = current.SCHEMA_REGISTRY.find((e) => e.family === 'aio.pccleanup');
    expect(row?.home).toBe('project');
    expect(row?.where.startsWith('edits/pointcloud/')).toBe(true);
    expect(v011.SCHEMA_REGISTRY.some((e) => e.family === 'aio.pccleanup')).toBe(false);
  });

  it('lists pointcloud.clean jobs that 0.11 skips one by one', () => {
    const j = job('pointcloud.clean', {
      mode: 'noise',
      layerId: 'cloud-a',
      src: 'clouds/a.copc.laz',
      outlier: { meanK: 8, multiplier: 2 },
    });
    expect(current.JobRecord.safeParse(j).success).toBe(true);
    expect(v011.JobRecord.safeParse(j).success).toBe(false);
  });

  it('keeps survey.export jobs without a recipe readable by 0.11', () => {
    const params = { what: 'cloud', format: 'laz', crs: 'site', layer: 'cloud-a', out: 'D:/a.laz' };
    expect(v011.SurveyExportParams.safeParse(params).success).toBe(true);
    expect(
      current.SurveyExportParams.safeParse({ ...params, cleanup: current.emptyCleanup('cloud-a') })
        .success,
    ).toBe(true);
    expect(
      v011.SurveyExportParams.safeParse({ ...params, cleanup: current.emptyCleanup('cloud-a') })
        .success,
    ).toBe(false);
  });

  it('a manifest without a cleaned copy still opens in 0.11; one with a copy does not', () => {
    expect(v011.ProjectManifest.safeParse(manifest([cloud])).success).toBe(true);
    const copy = {
      ...cloud,
      id: 'cloud-a-cleaned',
      name: 'Scan (cleaned)',
      visible: true,
      src: { path: 'clouds/cloud-a-cleaned.copc.laz' },
      derived: { kind: 'cleanup', source: ['cloud-a'], runId: 'j1' },
    };
    expect(current.ProjectManifest.safeParse(manifest([cloud, copy])).success).toBe(true);
    expect(v011.ProjectManifest.safeParse(manifest([cloud, copy])).success).toBe(false);
  });
});
