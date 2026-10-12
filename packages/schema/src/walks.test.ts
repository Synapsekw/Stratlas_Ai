import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LayerPatch } from './builder';
import { ipc } from './ipc';
import { Layer } from './layers';
import { LAYER_KINDS } from './manifest';
import { readVersioned, SCHEMA_REGISTRY } from './versions';
import {
  MAX_WALK_PINS,
  readWalkOrientationData,
  WALK_ORIENT_RECORD_BYTES,
  WALK_PATH_SCHEMA,
  WalkCalibration,
  WalkFile,
  WalkOrientation,
  WalkRawPath,
  WALK_SCHEMA,
} from './walks';

const walk = {
  schema: WALK_SCHEMA,
  id: 'vid-20260101-120000-00-001',
  name: 'VID_20260101_120000_00_001',
  createdAt: '2026-10-11T09:30:00.000Z',
  source: {
    file: 'VID_20260101_120000_00_001.insv',
    bytes: 1_645_660_464,
    layout: 'insv-dual-stream',
    trailer: true,
    capturedAt: '2026-01-01T12:00:00',
    streams: [
      { width: 2880, height: 2880, codec: 'hvc1', fps: 59.94 },
      { width: 2880, height: 2880, codec: 'hvc1', fps: 59.94 },
    ],
  },
  video: {
    src: 'walks/vid-20260101-120000-00-001/playback.mp4',
    width: 3840,
    height: 1920,
    durationS: 81.9,
    fps: 29.97,
    audio: true,
  },
  poster: 'walks/vid-20260101-120000-00-001/poster.jpg',
  stitch: {
    tool: 'ffmpeg',
    filter: 'v360=input=dfisheye:output=e:ih_fov=195:iv_fov=195:w=3840:h=1920',
    fovDeg: 195,
    encoder: 'libx264',
  },
};

describe('walk.json (aio.walk/1)', () => {
  it('reads a stitched walk', () => {
    const r = WalkFile.safeParse(walk);
    expect(r.success).toBe(true);
  });

  it('reads a stitched MP4 stored without a stitch, a poster or source details', () => {
    const r = WalkFile.safeParse({
      schema: WALK_SCHEMA,
      id: 'site-tour',
      name: 'Site tour',
      createdAt: '2026-10-11T09:30:00Z',
      source: {
        file: 'Site tour.mp4',
        layout: 'equirect',
        streams: [{ width: 3840, height: 1920, codec: 'avc1', fps: 30 }],
      },
      video: {
        src: 'walks/site-tour/playback.mp4',
        width: 3840,
        height: 1920,
        durationS: 12,
        fps: 30,
        audio: false,
      },
    });
    expect(r.success).toBe(true);
  });

  it('refuses a layout it does not know, a path that leaves the project and a bad id', () => {
    expect(
      WalkFile.safeParse({ ...walk, source: { ...walk.source, layout: 'cubemap' } }).success,
    ).toBe(false);
    for (const src of ['../outside.mp4', 'C:/clip.mp4', '/abs.mp4', 'walks\\x\\playback.mp4'])
      expect(WalkFile.safeParse({ ...walk, video: { ...walk.video, src } }).success).toBe(false);
    expect(WalkFile.safeParse({ ...walk, id: 'Has Spaces' }).success).toBe(false);
  });

  it('is registered, and a newer version is refused without a parse', () => {
    expect(SCHEMA_REGISTRY.find((e) => e.family === 'aio.walk')).toMatchObject({
      version: 1,
      home: 'project',
      where: 'walks/<id>/walk.json',
    });
    const read = readVersioned(walk, { family: 'aio.walk', schema: WalkFile });
    expect(read.ok).toBe(true);
    const newer = readVersioned(
      { ...walk, schema: 'aio.walk/2' },
      {
        family: 'aio.walk',
        schema: WalkFile,
      },
    );
    expect(newer.ok).toBe(false);
    if (!newer.ok) expect(newer.reason).toBe('newer');
  });
});

describe('walk channels', () => {
  it('walks:list takes a project and answers with walk files', () => {
    const c = ipc['walks:list'];
    expect(c.request.safeParse({ projectId: 'p' }).success).toBe(true);
    expect(c.request.safeParse({ projectId: 'p', extra: 1 }).success).toBe(false);
    expect(c.response.safeParse({ walks: [walk] }).success).toBe(true);
    expect(c.response.safeParse({ walks: [{ ...walk, schema: 'aio.walk/9' }] }).success).toBe(
      false,
    );
  });

  it('builder:cancelImport takes a project and answers whether an import was running', () => {
    const c = ipc['builder:cancelImport'];
    expect(c.request.safeParse({ projectId: 'p' }).success).toBe(true);
    expect(c.request.safeParse({ projectId: 'p', file: 'a.insv' }).success).toBe(false);
    expect(c.request.safeParse({}).success).toBe(false);
    expect(c.response.safeParse({ ok: false }).success).toBe(true);
  });

  it('builder:import takes the optional as360 and still reads without it', () => {
    const req = ipc['builder:import'].request;
    expect(req.safeParse({ projectId: 'p', paths: ['a.mp4'] }).success).toBe(true);
    expect(req.safeParse({ projectId: 'p', paths: ['a.mp4'], as360: true }).success).toBe(true);
    expect(req.safeParse({ projectId: 'p', paths: ['a.mp4'], as360: 'yes' }).success).toBe(false);
  });
});

const fixtureDir = new URL('./__fixtures__/walk/', import.meta.url);
const readJson = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(name, fixtureDir), 'utf8'));

describe('walk layer', () => {
  const layer = {
    kind: 'walk',
    id: 'walk-a',
    name: 'A',
    record: { path: 'walks/a/walk.json' },
    src: { path: 'walks/a/playback.mp4' },
    durationS: 81.9,
  };
  const place = {
    pins: [
      { t: 4, surface: 'sheet-ground', at: [120, 340] },
      { t: 80, surface: '@model', at: [12.5, -40], y: 2.1 },
    ],
    yawOffsetDeg: 0,
    quality: 'good',
  };

  it('parses a bare walk layer and defaults visible', () => {
    expect(Layer.parse(layer)).toMatchObject({ kind: 'walk', visible: true });
  });

  it('parses a placed walk with a drawing pin and a model pin', () => {
    const parsed = Layer.parse({ ...layer, place });
    expect(parsed.kind === 'walk' ? parsed.place?.heightM : undefined).toBe(1.7);
  });

  it('parses the path files and a pose flight', () => {
    const r = Layer.safeParse({
      ...layer,
      poster: { path: 'walks/a/poster.jpg' },
      path: {
        raw: { path: 'walks/a/raw-path.json' },
        orientation: { path: 'walks/a/orientation.json' },
        orientationData: { path: 'walks/a/orientation.bin' },
        points: { path: 'walks/a/sparse.ply' },
      },
      flight: { src: { path: 'walks/a/pose.json' }, startUtcMs: 1_767_268_800_000 },
    });
    expect(r.success).toBe(true);
    expect(Layer.safeParse({ ...layer, path: { raw: layer.record, extra: 1 } }).success).toBe(
      false,
    );
  });

  it(`refuses ${String(MAX_WALK_PINS + 1)} pins`, () => {
    const pins = Array.from({ length: MAX_WALK_PINS + 1 }, (_, i) => ({
      t: i,
      surface: '@model',
      at: [i, i],
    }));
    expect(WalkCalibration.safeParse({ ...place, pins }).success).toBe(false);
    expect(WalkCalibration.safeParse({ ...place, pins: pins.slice(1) }).success).toBe(true);
  });

  it('refuses a yaw offset of 200, a negative pin time and an unknown field', () => {
    expect(Layer.safeParse({ ...layer, place: { ...place, yawOffsetDeg: 200 } }).success).toBe(
      false,
    );
    expect(
      WalkCalibration.safeParse({ ...place, pins: [{ t: -1, surface: '@model', at: [0, 0] }] })
        .success,
    ).toBe(false);
    expect(WalkCalibration.safeParse({ ...place, extra: true }).success).toBe(false);
  });

  it('LAYER_KINDS has walk', () => {
    expect(LAYER_KINDS.has('walk')).toBe(true);
  });
});

describe('raw path and orientation files', () => {
  it('reads the synthetic fixture and its broken variant', () => {
    const r = WalkRawPath.safeParse(readJson('raw-path.synthetic.json'));
    expect(r.success).toBe(true);
    const broken = WalkRawPath.safeParse(readJson('raw-path.broken.json'));
    expect(broken.success).toBe(true);
    if (broken.success) {
      expect(broken.data.stills.some((s) => s.pos === undefined)).toBe(true);
      expect(broken.data.stills.some((s) => s.segment === 1)).toBe(true);
    }
  });

  it('reads a still with no pose (unregistered)', () => {
    const r = WalkRawPath.safeParse({
      schema: WALK_PATH_SCHEMA,
      walk: 'a',
      source: 'pins-only',
      stills: [{ n: 0, t: 0, steps: 0 }],
    });
    expect(r.success).toBe(true);
  });

  it('refuses aio.walkpath/2 as newer, without a parse', () => {
    const fixture = readJson('raw-path.synthetic.json') as Record<string, unknown>;
    expect(readVersioned(fixture, { family: 'aio.walkpath', schema: WalkRawPath }).ok).toBe(true);
    const newer = readVersioned(
      { ...fixture, schema: 'aio.walkpath/2' },
      { family: 'aio.walkpath', schema: WalkRawPath },
    );
    expect(newer.ok).toBe(false);
    if (!newer.ok) expect(newer.reason).toBe('newer');
  });

  it('reads the orientation fixture and its data file', () => {
    const header = WalkOrientation.parse(readJson('orientation.synthetic.json'));
    expect(header.rateHz).toBe(200);
    expect(header.data).toBe('orientation.synthetic.bin');
    const bytes = new Uint8Array(readFileSync(new URL(header.data, fixtureDir)));
    expect(bytes.byteLength).toBe(header.count * WALK_ORIENT_RECORD_BYTES);
    const rows = readWalkOrientationData(header, bytes);
    expect(rows?.length).toBe(header.count);
    const q = rows?.[0] ?? [];
    expect(q[0]).toBe(0);
    expect(Math.hypot(q[1] ?? 0, q[2] ?? 0, q[3] ?? 0, q[4] ?? 0)).toBeCloseTo(1, 6);
  });

  it('refuses an orientation header with a path in data or another layout', () => {
    const header = readJson('orientation.synthetic.json') as Record<string, unknown>;
    expect(WalkOrientation.safeParse({ ...header, data: '../x.bin' }).success).toBe(false);
    expect(WalkOrientation.safeParse({ ...header, data: 'a/x.bin' }).success).toBe(false);
    expect(WalkOrientation.safeParse({ ...header, layout: 'f64le' }).success).toBe(false);
  });
});

describe('readWalkOrientationData', () => {
  const header = WalkOrientation.parse({
    schema: 'aio.walkorient/1',
    rateHz: 100,
    count: 3,
    convention: 'xyzw-camera-threejs',
    frame: 'raw',
    startOffsetS: 1.5,
    data: 'orientation.bin',
    layout: 'f32le-t-xyzw',
  });
  const bytesOf = (rows: number[][]): Uint8Array => {
    const view = new DataView(new ArrayBuffer(rows.length * WALK_ORIENT_RECORD_BYTES));
    rows.forEach((r, i) => {
      r.forEach((v, j) => {
        view.setFloat32(i * WALK_ORIENT_RECORD_BYTES + j * 4, v, true);
      });
    });
    return new Uint8Array(view.buffer);
  };

  it('adds the start offset, normalises and drops non-finite records', () => {
    const rows = readWalkOrientationData(
      header,
      bytesOf([
        [0, 0, 0, 0, 2],
        [0.01, Number.NaN, 0, 0, 1],
        [0.02, 0, 0.5, 0, 0.5],
      ]),
    );
    expect(rows?.length).toBe(2);
    expect(rows?.[0]?.[0]).toBeCloseTo(1.5, 6);
    expect(rows?.[0]?.[4]).toBeCloseTo(1, 6);
    expect(rows?.[1]?.[0]).toBeCloseTo(1.52, 6);
    expect(rows?.[1]?.[2]).toBeCloseTo(Math.SQRT1_2, 6);
  });

  it('drops a zero quaternion and reads a view into a larger buffer', () => {
    const inner = bytesOf([
      [0, 0, 0, 0, 0],
      [0.01, 0, 0, 0, 1],
      [0.02, 0, 0, 0, 1],
    ]);
    const outer = new Uint8Array(inner.byteLength + 8);
    outer.set(inner, 4);
    const rows = readWalkOrientationData(header, outer.subarray(4, 4 + inner.byteLength));
    expect(rows?.length).toBe(2);
    expect(rows?.[0]?.[0]).toBeCloseTo(1.51, 6);
  });

  it('refuses a file whose length is not count * 20', () => {
    const three = bytesOf([
      [0, 0, 0, 0, 1],
      [0.01, 0, 0, 0, 1],
      [0.02, 0, 0, 0, 1],
    ]);
    expect(readWalkOrientationData(header, three.subarray(0, 59))).toBeNull();
    expect(readWalkOrientationData({ ...header, count: 2 }, three)).toBeNull();
  });
});

describe('LayerPatch walk', () => {
  it('takes a calibration and null', () => {
    const place = { pins: [], yawOffsetDeg: 10, quality: 'unplaced' };
    expect(LayerPatch.safeParse({ walk: place }).success).toBe(true);
    expect(LayerPatch.safeParse({ walk: null }).success).toBe(true);
    expect(LayerPatch.safeParse({ walk: { ...place, quality: 'great' } }).success).toBe(false);
  });
});

describe('walks:remove', () => {
  it('takes a project and a layer and answers with the manifest or an error', () => {
    const c = ipc['walks:remove'];
    expect(c.request.safeParse({ projectId: 'p', layerId: 'walk-a' }).success).toBe(true);
    expect(c.request.safeParse({ projectId: 'p' }).success).toBe(false);
    expect(c.response.safeParse({ ok: false, error: 'No such walk' }).success).toBe(true);
    expect(c.response.safeParse({ ok: true }).success).toBe(false);
  });
});
