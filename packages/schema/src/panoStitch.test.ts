import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ipc } from './ipc';
import { PIPELINES, PanoStitchParams, PipelineName, pipelineParams } from './jobs';
import { PanoRef } from './layers';
import {
  PANO_STITCH_MIN_PACK,
  PANO_STITCH_SCHEMA,
  PANO_WIDTH,
  PanoCov,
  PanoScan,
  PanoStitchFile,
  PanoStitchState,
  panoFolder,
} from './panoStitch';
import { SCHEMA_REGISTRY } from './versions';

const golden = JSON.parse(
  readFileSync(new URL('./__fixtures__/pano/stitch.synthetic.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;

describe('aio.pano-stitch/1', () => {
  it('reads the golden run record', () => {
    const r = PanoStitchFile.safeParse(golden);
    expect(r.success).toBe(true);
    expect(r.data?.schema).toBe(PANO_STITCH_SCHEMA);
  });

  it('reads a metadata-only run and a wide panorama', () => {
    const meta = { ...golden, aligned: 'metadata', residualPx: null, maxDriftDeg: null };
    expect(PanoStitchFile.safeParse(meta).success).toBe(true);
    const wide = {
      ...golden,
      shape: 'wide',
      size: { width: 4400, height: 1800 },
      coverage: { topDeg: 24, bottomDeg: 55, leftDeg: -100, rightDeg: 93 },
    };
    expect(PanoStitchFile.safeParse(wide).success).toBe(true);
  });

  it('refuses frame names with folders and unknown alignments', () => {
    const bad = { ...golden, frames: { used: ['sub/SYN_0001.JPG'], dropped: [] } };
    expect(PanoStitchFile.safeParse(bad).success).toBe(false);
    expect(PanoStitchFile.safeParse({ ...golden, aligned: 'hugin' }).success).toBe(false);
  });

  it('is registered as a project file beside the sphere', () => {
    const row = SCHEMA_REGISTRY.find((e) => e.family === 'aio.pano-stitch');
    expect(row).toMatchObject({
      version: 1,
      home: 'project',
      where: 'panoramas/<layer>/<pano>/stitch.json',
    });
  });

  it('names the folder of a sphere and the sizes per quality', () => {
    expect(panoFolder('panos-2026-09-10', 'p01')).toBe('panoramas/panos-2026-09-10/p01');
    expect(PANO_WIDTH).toEqual({ standard: 8192, high: 16384 });
    expect(PANO_STITCH_MIN_PACK).toBe('0.7.0');
  });
});

describe('PanoRef gains optional fields', () => {
  const plain = { id: 'p01', src: { path: 'panoramas/l/p01/pano.jpg' }, pos: [0, 70, 0] };

  it('still reads an item without them', () => {
    expect(PanoRef.parse(plain)).toEqual({ ...plain, headingDeg: 0 });
  });

  it('reads name, capture time, stitch state and coverage', () => {
    const item = {
      ...plain,
      name: 'Pano 1',
      capturedAt: '2026-09-10T10:00:00+03:00',
      stitch: { status: 'queued' },
      cov: { top: 24, bottom: 55, left: -100, right: 93 },
    };
    expect(PanoRef.parse(item)).toMatchObject(item);
  });

  it('keeps a run id and an error with the state', () => {
    const s = {
      run: '20261013-101500-pano-stitch-a1b2',
      status: 'failed',
      error: 'Too few frames',
    };
    expect(PanoStitchState.parse(s)).toEqual(s);
    expect(PanoStitchState.safeParse({ status: 'stitched' }).success).toBe(false);
  });

  it('refuses a yaw range that runs backwards', () => {
    expect(PanoCov.safeParse({ top: 20, bottom: 50, left: 90, right: -90 }).success).toBe(false);
    expect(PanoCov.safeParse({ top: 20, bottom: 50, left: 90 }).success).toBe(false);
  });
});

describe('pano.stitch job', () => {
  it('is a pipeline with checked parameters', () => {
    expect(PipelineName.options).toContain('pano.stitch');
    expect(PIPELINES.find((p) => p.name === 'pano.stitch')?.title).toBe('Stitch drone panorama');
    expect(pipelineParams('pano.stitch')).toBe(PanoStitchParams);
    expect(PanoStitchParams.parse({ layer: 'panos-2026-09-10', pano: 'p01' })).toEqual({
      layer: 'panos-2026-09-10',
      pano: 'p01',
    });
    expect(PanoStitchParams.safeParse({ layer: '../x', pano: 'p01' }).success).toBe(false);
    expect(PanoStitchParams.safeParse({ layer: 'l', pano: 'p01', quality: 'ultra' }).success).toBe(
      false,
    );
    expect(PanoStitchParams.safeParse({ layer: 'l', pano: 'p01', width: 1024 }).success).toBe(
      false,
    );
  });
});

describe('scan and import channels', () => {
  const scan = {
    scanId: 'scan-1',
    spheres: [
      {
        key: 's1',
        shape: 'sphere',
        files: ['D:/card/SYN_0001.JPG'],
        frames: 26,
        bytes: 300_000_000,
        startedAt: '2026-09-10T10:00:00',
        lat: 46.5,
        lon: 7.5,
        absAlt: 620,
        relAlt: 70,
        incomplete: false,
      },
    ],
    ready: [],
    skipped: [{ file: 'D:/card/SYN_0100.JPG', reason: 'few-frames' }],
    files: 27,
    day: '2026-09-10',
  };

  it('answers a scan', () => {
    expect(PanoScan.safeParse(scan).success).toBe(true);
    const res = ipc['panos:scan'].response.safeParse({ ok: true, scan });
    expect(res.success).toBe(true);
  });

  it('asks for an import by scan keys', () => {
    const req = {
      projectId: 'p',
      scanId: 'scan-1',
      keys: ['s1'],
      layerName: 'Panoramas 10 Sep',
      date: '2026-09-10',
      quality: 'standard',
    };
    expect(ipc['panos:import'].request.safeParse(req).success).toBe(true);
    expect(ipc['panos:import'].request.safeParse({ ...req, keys: [] }).success).toBe(false);
  });

  it('lets Add data leave files out', () => {
    const req = { projectId: 'p', paths: ['D:/card'], exclude: ['D:/card/SYN_0001.JPG'] };
    expect(ipc['builder:import'].request.safeParse(req).success).toBe(true);
  });
});
