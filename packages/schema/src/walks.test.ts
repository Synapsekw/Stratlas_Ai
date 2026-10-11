import { describe, expect, it } from 'vitest';
import { ipc } from './ipc';
import { readVersioned, SCHEMA_REGISTRY } from './versions';
import { WalkFile, WALK_SCHEMA } from './walks';

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
