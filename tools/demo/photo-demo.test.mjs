// The photo demo's run files (photo-demo.mjs): the precomputed alignment in the project's terms,
// valid against the M10 schemas. The full build (Python rendering) runs in CI's demo step.
import { describe, expect, it } from 'vitest';
import * as schema from '../../packages/schema/src/index.ts';
import { PHOTO_RUN, precomputedRun, readGcpCsv } from './photo-demo.mjs';

const truth = {
  site: { crs: { epsg: 32639 }, origin: [550000, 2330000, 142] },
  camera: { width: 1600, height: 1200, focalMm: 8.8, sensorWidthMm: 13.2 },
};
const alignment = {
  registered: ['SYN_0001.JPG', 'SYN_0002.JPG', 'SYN_0003.JPG'],
  rejected: [{ name: 'SYN_0004.JPG', reason: 'motion blur' }],
  meanReprojPx: 0.376,
  gsdCm: 5.6132,
  cameraResiduals: { medianM: 2.1, maxM: 5.3, rmseHorizontalM: 2.6, rmseVerticalM: 1.2 },
  residuals: { G1: [1.1, -0.7, 0.9], C1: [1.0, -0.8, 0.9] },
  predictions: {
    G1: [
      { photo: 'SYN_0001.JPG', px: [100.5, 200.25], radiusPx: 30.6 },
      { photo: 'SYN_9999.JPG', px: [1, 1], radiusPx: 30.6 },
    ],
    C1: [{ photo: 'SYN_0002.JPG', px: [300, 400], radiusPx: 30.6 }],
  },
};
const ids = new Map([
  ['SYN_0001.JPG', 'syn-0001'],
  ['SYN_0002.JPG', 'syn-0002'],
  ['SYN_0003.JPG', 'syn-0003'],
  ['SYN_0004.JPG', 'syn-0004'],
]);

describe('photo demo run files', () => {
  it('reads the GCP survey file', () => {
    const pts = readGcpCsv('id,x,y,z,role\nG1,549928.0,2329925.0,141.5,control\nC1,1,2,3,check\n');
    expect(pts).toEqual([
      { id: 'G1', role: 'control', xyz: [549928, 2329925, 141.5] },
      { id: 'C1', role: 'check', xyz: [1, 2, 3] },
    ]);
  });

  it('writes a valid aligned run, GCP file and GNSS-only accuracy report in photo ids', () => {
    const gcpCsv = readGcpCsv('id,x,y,z,role\nG1,1,2,3,control\nC1,4,5,6,check\n');
    const { run, gcp, accuracy } = precomputedRun(schema, {
      truth,
      alignment,
      ids,
      capture: 'capture-2026-03-14',
      gcpCsv,
    });
    expect(run.id).toBe(PHOTO_RUN);
    expect(run.status).toBe('aligned');
    expect(run.photos).toMatchObject({ count: 4, registered: 3 });
    expect(run.photos.rejected).toEqual([{ name: 'syn-0004', reason: 'motion blur' }]);
    expect(run.accuracy?.check?.horizontalM).toBeCloseTo(Math.hypot(1.0, 0.8), 4);
    // predictions name photos of the layer, and drop photos not in it
    expect(gcp.points[0]?.predicted).toEqual([
      { photo: 'syn-0001', px: [100.5, 200.25], radiusPx: 30.6 },
    ]);
    expect(gcp.points.every((p) => p.marks.length === 0)).toBe(true);
    expect(accuracy.checkpointsInAdjustment).toBe(false);
    expect(accuracy.points.map((p) => [p.id, p.role, p.dzM])).toEqual([
      ['G1', 'control', 0.9],
      ['C1', 'check', 0.9],
    ]);
    // every path in the run file stays inside the project
    for (const f of run.outputs.files)
      expect(f.startsWith(`photogrammetry/${PHOTO_RUN}/`)).toBe(true);
  });
});
