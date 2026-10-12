// walk.process (plan 2026-10-12-walk-process-pipeline) is additive, pinned against the 0.10.0
// schema (tools/compat/schema-0.10):
// - its run record lives in `walks/<id>/process.json`, a folder 0.10 never opens;
// - the one known exception, as in M10 and M11: the job index (userData jobs.json) lists jobs of
//   the new pipeline, which 0.10's index reader skips one by one instead of refusing the file.
import { describe, expect, it } from 'vitest';
import * as current from '../../packages/schema/src/index.ts';
import * as v010 from './schema-0.10/index.mjs';

describe('walk.process is additive', () => {
  it('writes its run record into walks/, which 0.10 never reads', () => {
    const row = current.SCHEMA_REGISTRY.find((e) => e.family === 'aio.walk-process');
    expect(row?.home).toBe('project');
    expect(row?.where.startsWith('walks/')).toBe(true);
  });

  it('the job index lists walk.process jobs that 0.10 skips one by one', () => {
    const job = {
      id: '20261012-090000-walk-process-a1b2',
      pipeline: 'walk.process',
      project: 'D:/data/projects/demo',
      params: { walk: 'vid-20260101-120000-00-001' },
      status: 'failed',
      progress: 0,
      steps: [],
      artifacts: [],
      createdAt: '2026-10-12T09:00:00Z',
      updatedAt: '2026-10-12T09:00:00Z',
    };
    expect(current.JobRecord.safeParse(job).success).toBe(true);
    expect(v010.JobRecord.safeParse(job).success).toBe(false);
    expect(v010.JobRecord.safeParse({ ...job, pipeline: 'photo.align', params: {} }).success).toBe(
      true,
    );
  });
});
