import type { AccuracyReport } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { formatResidual, headline, pointRows, rmseRows } from './report';

const report = (o: Partial<AccuracyReport> = {}): AccuracyReport => ({
  schema: 'aio.photo-accuracy/1',
  run: '20261007-0915',
  createdAt: '2026-10-07T10:00:00Z',
  crs: { epsg: 32639 },
  gsdCm: 2,
  images: { total: 60, registered: 58 },
  meanReprojPx: 0.62,
  points: [
    { id: 'GCP10', role: 'check', dxM: 0.012, dyM: -0.016, dzM: 0.031, reprojPx: 0.5, marks: 4 },
    { id: 'GCP2', role: 'control', dxM: 0.004, dyM: -0.0003, dzM: 0.009, reprojPx: 0.41, marks: 5 },
    { id: 'GCP6', role: 'control', dxM: 0.1, dyM: 0.2, dzM: 1.02, reprojPx: 3.1, marks: 3 },
  ],
  rmse: {
    control: { n: 2, horizontalM: 0.16, verticalM: 0.72 },
    check: { n: 1, horizontalM: 0.02, verticalM: 0.031 },
  },
  checkpointsInAdjustment: false,
  warnings: [
    {
      code: 'gcp-outlier',
      message: 'GCP6 is 1.0 m off; check its coordinates or marks.',
      point: 'GCP6',
    },
  ],
  ...o,
});

describe('accuracy report tables', () => {
  it('formats residuals in centimetres, metres from one metre, never minus zero', () => {
    expect(formatResidual(0.0123)).toBe('1.2 cm');
    expect(formatResidual(-0.0004)).toBe('0.0 cm');
    expect(formatResidual(-0.016)).toBe('-1.6 cm');
    expect(formatResidual(1.02)).toBe('1.02 m');
    expect(formatResidual(Number.NaN)).toBe('–');
  });

  it('lists every point, control first, numbers in order, with the outlier flagged', () => {
    const rows = pointRows(report());
    expect(rows.map((r) => [r.id, r.role, r.flagged])).toEqual([
      ['GCP2', 'control', false],
      ['GCP6', 'control', true],
      ['GCP10', 'check', false],
    ]);
    expect(rows[2]).toMatchObject({
      dx: '1.2 cm',
      dy: '-1.6 cm',
      dz: '3.1 cm',
      horizontal: '2.0 cm',
      reproj: '0.50 px',
    });
  });

  it('judges checkpoints against the plan targets in GSDs', () => {
    const rows = rmseRows(report());
    expect(rows.map((r) => [r.role, r.verdict])).toEqual([
      ['control', null],
      ['check', 'within'],
    ]);
    const over = rmseRows(
      report({ rmse: { check: { n: 4, horizontalM: 0.05, verticalM: 0.02 } } }),
    );
    expect(over[0]?.verdict).toBe('over');
    expect(rmseRows(report({ gsdCm: undefined }))[1]?.verdict).toBeNull();
  });

  it('says what the accuracy rests on', () => {
    expect(headline(report())).toBe(
      'Checkpoint RMSE 2.0 cm horizontal, 3.1 cm vertical over 1 point; 58 of 60 photos aligned.',
    );
    expect(
      headline(report({ rmse: { control: { n: 5, horizontalM: 0.01, verticalM: 0.01 } } })),
    ).toMatch(/^No checkpoints: the control RMSE/);
    expect(headline(report({ rmse: {} }))).toMatch(/^GNSS only/);
  });
});
