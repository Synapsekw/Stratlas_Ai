import { HardwareProbe, PhotoRun } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { photoDiagnostics, probeSummary, runSummary } from './photo';

const probe = HardwareProbe.parse({
  platform: 'win32',
  arch: 'x64',
  cpu: { model: 'Test CPU', cores: 8, threads: 16 },
  memoryBytes: 34_359_738_368,
  freeDiskBytes: 512_000_000_000,
  gpus: [{ name: 'Test GPU', vendor: 'Test', vramBytes: 8_589_934_592 }],
  cuda: false,
  processing: 'available',
});

function run(id: string, createdAt: string, extra: Record<string, unknown> = {}): PhotoRun {
  return PhotoRun.parse({
    schema: 'aio.photo-run/1',
    id,
    createdAt,
    status: 'done',
    preset: 'standard',
    photos: {
      source: { folders: ['C:\\Users\\tester\\flight'] },
      count: 24,
      registered: 22,
      rejected: [
        { name: 'IMG_0003.JPG', reason: 'motion blur' },
        { name: 'IMG_0004.JPG', reason: 'duplicate of IMG_0005.JPG' },
      ],
    },
    cameras: [{ id: 'cam1', widthPx: 4000, heightPx: 3000, photos: 24 }],
    crs: {
      wkt: 'PROJCS["x",PARAMETER["false_easting",612345.5],PARAMETER["false_northing",2798765.25]]',
    },
    settings: { folders: ['D:\\drone\\day1'], products: ['ortho'] },
    region: [
      [51.5, 25.3],
      [51.6, 25.3],
      [51.6, 25.4],
      [51.5, 25.3],
    ],
    stages: [],
    outputs: { layers: [], tilesets: [], files: [] },
    versions: { pack: '0.5.4', colmap: '3.12.0' },
    ...extra,
  });
}

const full = run('20260314-1000', '2026-03-14T10:00:00Z', {
  updatedAt: '2026-03-14T11:00:00Z',
  stages: [
    { name: 'sfm', state: 'done', seconds: 10, memoryPeakBytes: 1e9, device: 'cpu' },
    {
      name: 'dense',
      state: 'done',
      seconds: 20.5,
      memoryPeakBytes: 3e9,
      device: 'gpu',
      fallbacks: 2,
    },
    {
      name: 'ortho',
      state: 'failed',
      seconds: 30,
      memoryPeakBytes: 2e9,
      message: 'could not read C:\\Users\\tester\\flight\\IMG_0001.JPG',
    },
  ],
  accuracy: {
    control: { n: 5, horizontalM: 0.02, verticalM: 0.03 },
    check: { n: 3, horizontalM: 0.04, verticalM: 0.05 },
    meanReprojPx: 0.8,
    gsdCm: 2.1,
  },
  warnings: ['IMG_0002.JPG has no GPS'],
  hardware: probe,
});

describe('probeSummary', () => {
  it('keeps the machine facts and nothing of an old accelerator', () => {
    const old = HardwareProbe.parse({
      ...probe,
      accelerator: { state: 'failed', reason: 'could not load C:\\drivers\\x' },
    });
    expect(probeSummary(old)).toEqual({
      platform: 'win32',
      arch: 'x64',
      cpu: { model: 'Test CPU', cores: 8, threads: 16 },
      memoryBytes: 34_359_738_368,
      freeDiskBytes: 512_000_000_000,
      gpus: [{ name: 'Test GPU', vendor: 'Test', vramBytes: 8_589_934_592 }],
      cuda: false,
      processing: 'available',
    });
  });

  it('copies no unknown fields of a loose probe', () => {
    const loose = { ...probe, dataRoot: 'C:\\Users\\tester\\data' } as HardwareProbe;
    expect(JSON.stringify(probeSummary(loose))).not.toContain('tester');
  });
});

describe('runSummary', () => {
  it('keeps the allow-listed fields', () => {
    expect(runSummary('proj-a', full)).toEqual({
      project: 'proj-a',
      id: '20260314-1000',
      createdAt: '2026-03-14T10:00:00Z',
      updatedAt: '2026-03-14T11:00:00Z',
      status: 'done',
      preset: 'standard',
      photos: { count: 24, registered: 22, rejected: 2 },
      versions: { pack: '0.5.4', colmap: '3.12.0' },
      stages: [
        { name: 'sfm', state: 'done', seconds: 10, memoryPeakBytes: 1e9, device: 'cpu' },
        {
          name: 'dense',
          state: 'done',
          seconds: 20.5,
          memoryPeakBytes: 3e9,
          device: 'gpu',
          fallbacks: 2,
        },
        { name: 'ortho', state: 'failed', seconds: 30, memoryPeakBytes: 2e9 },
      ],
      totalSeconds: 60.5,
      memoryPeakBytes: 3e9,
      accuracy: {
        control: { n: 5, horizontalM: 0.02, verticalM: 0.03 },
        check: { n: 3, horizontalM: 0.04, verticalM: 0.05 },
        meanReprojPx: 0.8,
        gsdCm: 2.1,
      },
      warnings: 1,
      hardware: probeSummary(probe),
    });
  });

  it('holds no photo names, folders, coordinates, parameters or free text', () => {
    const text = JSON.stringify(runSummary('proj-a', full));
    for (const leak of [
      'tester',
      'drone',
      'IMG_',
      '51.5',
      '25.3',
      '612345',
      '2798765',
      'drivers',
      'message',
      'settings',
      'region',
      'source',
      'motion blur',
    ]) {
      expect(text, leak).not.toContain(leak);
    }
  });

  it('keeps only version-like tool versions', () => {
    const odd = run('r9', '2026-03-14T10:00:00Z', {
      versions: { pack: '0.5.4', colmap: 'C:\\Users\\tester\\colmap', 'a b': '1.0' },
    });
    expect(runSummary('p', odd).versions).toEqual({ pack: '0.5.4' });
  });

  it('leaves out totals no stage reports', () => {
    const bare = runSummary(
      'p',
      run('r1', '2026-03-14T10:00:00Z', {
        stages: [{ name: 'sfm', state: 'pending' }],
      }),
    );
    expect(bare).not.toHaveProperty('memoryPeakBytes');
    expect(bare).not.toHaveProperty('totalSeconds');
    expect(bare).not.toHaveProperty('accuracy');
    expect(bare).not.toHaveProperty('hardware');
    expect(bare).not.toHaveProperty('updatedAt');
    expect(bare.stages).toEqual([{ name: 'sfm', state: 'pending' }]);
  });
});

describe('photoDiagnostics', () => {
  it('is empty without a probe or runs', () => {
    expect(photoDiagnostics(null, [])).toEqual({ probe: null, runs: [] });
  });

  it('lists the newest three runs, newest first', () => {
    const runs = [
      { project: 'a', run: run('r1', '2026-03-01T10:00:00Z') },
      { project: 'a', run: run('r2', '2026-03-02T10:00:00Z') },
      { project: 'b', run: run('r3', '2026-03-03T10:00:00Z') },
      {
        project: 'b',
        run: run('r4', '2026-03-01T09:00:00Z', { updatedAt: '2026-03-05T10:00:00Z' }),
      },
      { project: 'c', run: run('r5', '2026-02-01T10:00:00Z') },
    ];
    const out = photoDiagnostics(probe, runs);
    expect(out.probe).toEqual(probeSummary(probe));
    expect(out.runs.map((r) => [r.project, r.id])).toEqual([
      ['b', 'r4'],
      ['b', 'r3'],
      ['a', 'r2'],
    ]);
  });
});
