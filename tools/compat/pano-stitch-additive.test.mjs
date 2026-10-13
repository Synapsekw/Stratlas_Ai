// Drone panoramas P1 (plan 2026-10-13-drone-panoramas-p1) is additive, pinned against the 0.11
// schema (tools/compat/schema-0.11):
// - PanoRef's new fields are optional: 0.11 reads a new item and drops them when it saves;
// - the run record lives in `panoramas/<layer>/<pano>/stitch.json`, a file 0.11 never opens;
// - the job index lists pano.stitch jobs, which 0.11's index reader skips one by one;
// - `stitch` and `cov` are not strict, so a field a later phase adds does not refuse the project.
import { describe, expect, it } from 'vitest';
import * as current from '../../packages/schema/src/index.ts';
import * as v011 from './schema-0.11/index.mjs';

const item = {
  id: 'p01',
  src: { path: 'panoramas/panos-2026-09-10/p01/pano.jpg' },
  pos: [10, 70, -20],
  headingDeg: -0.8,
  name: 'Pano 1',
  capturedAt: '2026-09-10T10:00:00+02:00',
  stitch: { run: '20261013-101500-pano-stitch-a1b2', status: 'done' },
  cov: { top: 90, bottom: 90 },
};

describe('drone panoramas are additive', () => {
  it('0.11 reads a new pano item and keeps its place', () => {
    expect(current.PanoRef.safeParse(item).success).toBe(true);
    const old = v011.PanoRef.safeParse(item);
    expect(old.success).toBe(true);
    expect(old.data).toEqual({ id: 'p01', src: item.src, pos: item.pos, headingDeg: -0.8 });
  });

  it('a later build may add fields to stitch and cov: this one still reads the item', () => {
    const later = {
      ...item,
      stitch: { ...item.stitch, keptOld: true },
      cov: { ...item.cov, tilt: 2 },
    };
    const r = current.PanoRef.safeParse(later);
    expect(r.success).toBe(true);
    // the unknown fields are dropped, the known ones kept
    expect(r.data?.stitch).toEqual(item.stitch);
    expect(r.data?.cov).toEqual(item.cov);
  });

  it('writes its run record where 0.11 never reads', () => {
    const row = current.SCHEMA_REGISTRY.find((e) => e.family === 'aio.pano-stitch');
    expect(row?.home).toBe('project');
    expect(row?.where.startsWith('panoramas/')).toBe(true);
  });

  it('the job index lists pano.stitch jobs that 0.11 skips one by one', () => {
    const job = {
      id: '20261013-101500-pano-stitch-a1b2',
      pipeline: 'pano.stitch',
      project: 'D:/data/projects/demo',
      params: { layer: 'panos-2026-09-10', pano: 'p01' },
      status: 'failed',
      progress: 0,
      steps: [],
      artifacts: [],
      createdAt: '2026-10-13T10:15:00Z',
      updatedAt: '2026-10-13T10:15:00Z',
    };
    expect(current.JobRecord.safeParse(job).success).toBe(true);
    expect(v011.JobRecord.safeParse(job).success).toBe(false);
  });
});
