import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ipc } from './ipc';
import { PIPELINES, PipelineName, WalkProcessParams, pipelineParams } from './jobs';
import { SCHEMA_REGISTRY } from './versions';
import {
  WALK_IMU_COLUMNS,
  WALK_IMU_RATE_HZ,
  WALK_PROCESS_SCHEMA,
  WalkProcessFile,
  WalkProcessSummary,
  walkProcessSummary,
} from './walkProcess';

const golden = JSON.parse(
  readFileSync(new URL('./__fixtures__/walk/process.synthetic.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;

describe('aio.walk-process/1', () => {
  it('reads the golden run record', () => {
    const r = WalkProcessFile.safeParse(golden);
    expect(r.success).toBe(true);
    expect(r.data?.schema).toBe(WALK_PROCESS_SCHEMA);
  });

  it('reads a pins-only run from the playback copy, with no outputs but the stills', () => {
    const r = WalkProcessFile.safeParse({
      ...golden,
      input: { layout: 'equirect', calibration: 'none', imu: false },
      outputs: { stills: 'walks/w/stills' },
      stabilize: { levelled: false, keptYaw: true },
      path: { source: 'pins-only', registeredFraction: 0.2, segments: 0 },
      warnings: ['Too short for a path'],
    });
    expect(r.success).toBe(true);
  });

  it('refuses an output path that leaves the project', () => {
    for (const p of ['../x.mp4', '/abs/x.mp4', 'C:/x.mp4', 'walks\\w\\x.mp4']) {
      const r = WalkProcessFile.safeParse({ ...golden, outputs: { stabilized: p } });
      expect(r.success, p).toBe(false);
    }
  });

  it('keeps yaw by contract', () => {
    const r = WalkProcessFile.safeParse({
      ...golden,
      stabilize: { levelled: true, keptYaw: false },
    });
    expect(r.success).toBe(false);
  });

  it('summarises a run for walks:list', () => {
    const f = WalkProcessFile.parse(golden);
    const s = walkProcessSummary(f);
    expect(WalkProcessSummary.parse(s)).toEqual({
      createdAt: f.createdAt,
      stabilized: 'walks/vid-20260101-120000-00-001/stabilized.mp4',
      source: 'sfm',
      warnings: 0,
    });
    const none = walkProcessSummary({ ...f, outputs: {} });
    expect('stabilized' in none).toBe(false);
  });

  it('names the imu.bin layout', () => {
    expect(WALK_IMU_COLUMNS).toEqual(['t', 'ax', 'ay', 'az', 'gx', 'gy', 'gz']);
    expect(WALK_IMU_RATE_HZ).toBe(200);
  });

  it('is registered as a project file beside the walk', () => {
    const row = SCHEMA_REGISTRY.find((e) => e.family === 'aio.walk-process');
    expect(row).toMatchObject({ version: 1, home: 'project', where: 'walks/<id>/process.json' });
  });
});

describe('walk.process', () => {
  it('is a pipeline with a title', () => {
    expect(PipelineName.options).toContain('walk.process');
    expect(PIPELINES.find((p) => p.name === 'walk.process')?.title).toBe('Process 360 walk');
    expect(pipelineParams('walk.process')).toBe(WalkProcessParams);
  });

  it('takes a walk id the import writes and refuses others', () => {
    expect(WalkProcessParams.safeParse({ walk: 'vid-20260101-120000-00-001' }).success).toBe(true);
    expect(WalkProcessParams.safeParse({ walk: 'VID_1' }).success).toBe(false);
    expect(WalkProcessParams.safeParse({ walk: '-x' }).success).toBe(false);
  });

  it('checks its ranges and refuses unknown keys', () => {
    const ok = { walk: 'w1' };
    expect(WalkProcessParams.safeParse({ ...ok, maskBottom: 0.6 }).success).toBe(false);
    expect(WalkProcessParams.safeParse({ ...ok, stillsPerS: 5 }).success).toBe(false);
    expect(WalkProcessParams.safeParse({ ...ok, chunk: 10 }).success).toBe(false);
    expect(WalkProcessParams.safeParse({ ...ok, src: [] }).success).toBe(false);
    expect(WalkProcessParams.safeParse({ ...ok, layer: 'x' }).success).toBe(false);
    expect(
      WalkProcessParams.safeParse({
        ...ok,
        src: ['D:/clips/VID_1_00_001.insv', 'D:/clips/VID_1_00_002.insv'],
        stillsPerS: 2,
        maskBottom: 0.25,
        strideM: 0.7,
        stabilize: true,
        sfm: false,
        chunk: 300,
      }).success,
    ).toBe(true);
  });
});

describe('walks:list', () => {
  it('may carry the processed summaries by walk id', () => {
    const res = ipc['walks:list'].response;
    expect(res.safeParse({ walks: [] }).success).toBe(true);
    expect(
      res.safeParse({
        walks: [],
        processed: { w1: { createdAt: '2026-10-12T10:00:00.000Z', source: 'sfm', warnings: 1 } },
      }).success,
    ).toBe(true);
    expect(
      res.safeParse({ walks: [], processed: { w1: { source: 'sfm', warnings: 1 } } }).success,
    ).toBe(false);
  });
});
