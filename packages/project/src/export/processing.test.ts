import type { AccuracyReport, PhotoRun, ProjectManifest } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { sampleIssues, sampleManifest } from './fixtures';
import { houseReportModel } from './house';
import { CHECK_TARGET_GSD, processingSummary, runFootprints } from './processing';
import { resolveReportBranding } from './report';

const report = (o: Partial<AccuracyReport> = {}): AccuracyReport => ({
  schema: 'aio.photo-accuracy/1',
  run: '20261007-0915',
  createdAt: '2026-10-07T10:00:00Z',
  crs: { epsg: 32639 },
  gsdCm: 2,
  images: { total: 63, registered: 58 },
  meanReprojPx: 0.71,
  points: [
    { id: 'GCP10', role: 'control', dxM: 0.01, dyM: 0, dzM: 0.02, reprojPx: 0.4, marks: 4 },
    { id: 'GCP6', role: 'control', dxM: 0.8, dyM: 0.6, dzM: 0.1, reprojPx: 3.1, marks: 3 },
    { id: 'CHK1', role: 'check', dxM: -0.012, dyM: 0.016, dzM: -0.03, reprojPx: 0.6, marks: 3 },
    {
      id: 'GCP2',
      role: 'control',
      dxM: 0.004,
      dyM: -0.003,
      dzM: 0.01,
      reprojPx: 0.3,
      marks: 5,
      usedInAdjustment: true,
    },
  ],
  rmse: {
    control: { n: 3, horizontalM: 0.006, verticalM: 0.015 },
    check: { n: 1, horizontalM: 0.02, verticalM: 0.03 },
  },
  checkpointsInAdjustment: false,
  warnings: [{ code: 'gcp-outlier', message: 'GCP6 is 1.0 m off; left out.', point: 'GCP6' }],
  ...o,
});

describe('processingSummary', () => {
  it('lists control points first, every residual, and flags the outlier', () => {
    const s = processingSummary(report());
    expect(s.basis).toBe('check');
    expect(s.points.map((p) => p.id)).toEqual(['GCP2', 'GCP6', 'GCP10', 'CHK1']);
    expect(s.points.find((p) => p.id === 'GCP6')).toMatchObject({
      flagged: true,
      usedInAdjustment: null,
    });
    expect(s.points.find((p) => p.id === 'GCP2')?.usedInAdjustment).toBe(true);
    expect(s.points.find((p) => p.id === 'CHK1')?.horizontalM).toBeCloseTo(0.02, 9);
    expect(s.warnings).toEqual(['GCP6 is 1.0 m off; left out.']);
  });

  it('judges checkpoints against 1.5 and 2.5 GSD, never the control', () => {
    expect(CHECK_TARGET_GSD).toEqual({ horizontal: 1.5, vertical: 2.5 });
    const s = processingSummary(report());
    expect(s.rmse).toEqual([
      expect.objectContaining({ role: 'control', verdict: null, targetHorizontalM: null }),
      expect.objectContaining({ role: 'check', verdict: 'within' }),
    ]);
    expect(s.rmse[1]?.targetHorizontalM).toBeCloseTo(0.03, 9);
    expect(s.rmse[1]?.targetVerticalM).toBeCloseTo(0.05, 9);
    const over = processingSummary(
      report({ rmse: { check: { n: 4, horizontalM: 0.031, verticalM: 0.02 } } }),
    );
    expect(over.rmse[0]?.verdict).toBe('over');
    const noGsd = processingSummary(report({ gsdCm: undefined }));
    expect(noGsd.rmse.find((r) => r.role === 'check')?.verdict).toBeNull();
  });

  it('says what the accuracy rests on', () => {
    expect(
      processingSummary(report({ rmse: { control: { n: 3, horizontalM: 0.01, verticalM: 0.01 } } }))
        .basis,
    ).toBe('control');
    expect(processingSummary(report({ rmse: {}, points: [] })).basis).toBe('gnss');
  });

  it('draws footprints of a layer run only', () => {
    const m = {
      ...sampleManifest(),
      layers: [
        {
          kind: 'photos',
          id: 'flight',
          name: 'Flight',
          visible: true,
          items: [
            {
              id: 'a',
              src: { path: 'p/a.jpg' },
              pos: [0, 60, 0],
              lens: { model: 'pinhole', hfovDeg: 90, aspect: 1.5 },
            },
            { id: 'b', src: { path: 'p/b.jpg' } },
          ],
        },
      ],
    } as ProjectManifest;
    const run = {
      photos: { source: { layer: 'flight' }, count: 2 },
      preset: 'standard',
    } as unknown as PhotoRun;
    const feet = runFootprints(run, m);
    expect(feet).toHaveLength(1);
    expect(feet[0]?.r).toBeCloseTo(60, 6);
    const folder = { ...run, photos: { source: { folders: ['D:/f'] }, count: 2 } } as PhotoRun;
    expect(runFootprints(folder, m)).toEqual([]);
    expect(processingSummary(report(), run, m).preset).toBe('standard');
  });
});

describe('the house report processing section', () => {
  const branding = resolveReportBranding(undefined, 'Stratlas');
  const base = { manifest: sampleManifest(), issues: sampleIssues(), branding };

  it('prints after the site only for a project with a processing run', () => {
    expect(houseReportModel(base).sections).not.toContain('processing');
    const h = houseReportModel({ ...base, processing: processingSummary(report()) });
    expect(h.sections.slice(0, 6)).toEqual([
      'contents',
      'summary',
      'scope',
      'site',
      'processing',
      'statistics',
    ]);
    expect(h.processing?.run).toBe('20261007-0915');
    const off = houseReportModel({
      ...base,
      processing: processingSummary(report()),
      contents: { sections: { processing: false } },
    });
    expect(off.sections).not.toContain('processing');
  });
});
