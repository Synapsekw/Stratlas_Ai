import type { Layer, ProjectManifest } from '@aio/schema';
import type { Flight } from '@aio/video';
import { captureIndex } from '@aio/workspace';
import { describe, expect, it } from 'vitest';
import { LENS, lookQuat } from './__fixtures__/spotPoses';
import { safeAssetUrl } from './safeAssetUrl';
import { sampleVideo, spotEntries } from './spotEntries';
import type { TrackSample } from './spotTypes';

const photos = (id: string, capture: string | undefined, items: unknown[]) =>
  ({ kind: 'photos', id, name: id, visible: true, capture, items }) as unknown as Layer;
const clip = {
  kind: 'video',
  id: 'clip-d2',
  name: 'clip',
  visible: true,
  capture: 'd2',
  src: { path: 'v.mp4' },
  flight: { src: { path: 'f.json' }, startUtcMs: 1000 },
  lens: LENS,
  offsetMs: 0,
} as unknown as Extract<Layer, { kind: 'video' }>;
const manifest = {
  captures: [
    { id: 'd1', label: 'd1', date: '2025-01-01' },
    { id: 'd2', label: 'd2', date: '2025-02-01' },
  ],
  layers: [
    photos('photos-d1', 'd1', [
      { id: 'a', src: { path: 'a.jpg' }, pos: [1, 2, 3], q: lookQuat(0), lens: LENS },
      { id: 'b', src: { path: 'b.jpg' } },
      { id: 'c', src: { path: 'c.jpg' }, pos: [4, 5, 6] },
    ]),
    photos('photos-any', undefined, [{ id: 'u', src: { path: 'u.jpg' }, pos: [0, 0, 0] }]),
    {
      kind: 'panoramas',
      id: 'pano-d2',
      name: 'p',
      visible: true,
      capture: 'd2',
      items: [{ id: 'p', src: { path: 'p.jpg' }, pos: [9, 0, 9], headingDeg: 30 }],
    },
    clip,
  ],
} as unknown as ProjectManifest;
const index = captureIndex(manifest);

describe('spotEntries', () => {
  const e = spotEntries({ layers: manifest.layers, index, videoSamples: () => null });
  it('reads photos with their date, pose, position and lens', () => {
    const a = e.find((x) => x.kind === 'photo' && x.id === 'a');
    expect(a).toMatchObject({ capture: 'd1', pos: [1, 2, 3], hasLens: true });
    expect(a?.kind === 'photo' && a.pose?.pos).toEqual([1, 2, 3]);
    const c = e.find((x) => x.kind === 'photo' && x.id === 'c');
    expect(c?.kind === 'photo' && c.pose).toBeNull();
    expect(c).toMatchObject({ pos: [4, 5, 6], hasLens: false });
    expect(e.find((x) => x.kind === 'photo' && x.id === 'b')).not.toHaveProperty('pos');
  });
  it('moves a photo by its correction', () => {
    const moved = spotEntries({
      layers: manifest.layers,
      index,
      videoSamples: () => null,
      correction: (l, p) =>
        l === 'photos-d1' && (p === 'a' || p === 'c')
          ? { yawDeg: 0, pitchDeg: 0, rollDeg: 0, offsetM: [5, 0, 0] }
          : null,
    });
    expect(moved.find((x) => x.kind === 'photo' && x.id === 'a')).toMatchObject({
      pos: [6, 2, 3],
    });
    // a handheld photo has a position and no orientation
    expect(moved.find((x) => x.kind === 'photo' && x.id === 'c')).toMatchObject({
      pos: [9, 5, 6],
    });
  });
  it('keeps undated layers, without a date', () => {
    expect(e.find((x) => x.kind === 'photo' && x.id === 'u')?.capture).toBeUndefined();
  });
  it('reads panoramas', () => {
    expect(e.find((x) => x.kind === 'pano')).toMatchObject({
      capture: 'd2',
      pos: [9, 0, 9],
      headingDeg: 30,
    });
  });
  it('marks a clip whose flight is unreadable, leaves out one still reading, and skips clips without a reader', () => {
    expect(e.find((x) => x.kind === 'video')).toMatchObject({ samples: null });
    expect(
      spotEntries({ layers: manifest.layers, index, videoSamples: () => undefined }).some(
        (x) => x.kind === 'video',
      ),
    ).toBe(false);
    expect(spotEntries({ layers: manifest.layers, index }).some((x) => x.kind === 'video')).toBe(
      false,
    );
  });
  it('reads walks the same way: a track, unplaced (null) or still reading (left out)', () => {
    const walk = (id: string) =>
      ({ kind: 'walk', id, name: id, visible: true, capture: 'd1' }) as unknown as Layer;
    const layers = [walk('w-track'), walk('w-unplaced'), walk('w-reading')];
    const sample: TrackSample = { t: 0, pos: [0, 1.7, 0], groundY: 0, bearingDeg: 0 };
    const got = spotEntries({
      layers,
      index,
      walkSamples: (l) =>
        l.id === 'w-track' ? [sample] : l.id === 'w-unplaced' ? null : undefined,
    });
    expect(got).toEqual([
      { kind: 'walk', layer: 'w-track', capture: 'd1', samples: [sample] },
      { kind: 'walk', layer: 'w-unplaced', capture: 'd1', samples: null },
    ]);
  });
});

describe('sampleVideo', () => {
  const flight: Flight = {
    schema: 'aio.flight/1',
    startUtcMs: 1000,
    durationMs: 10_000,
    lens: LENS,
    samples: Array.from({ length: 11 }, (_, i) => ({
      t: i * 1000,
      pos: [i, 30, 0] as [number, number, number],
      q: lookQuat(0, -90),
    })),
  };
  it('samples every second of the logged flight, in video seconds', () => {
    const s = sampleVideo(clip, flight, null);
    expect(s.map((f) => f.t)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(s[3]?.pose.pos[0]).toBeCloseTo(3);
  });
  it('starts at video second 0 when the log starts earlier', () => {
    const late = { ...clip, offsetMs: 4000 } as typeof clip;
    expect(sampleVideo(late, flight, null)[0]?.t).toBe(0);
    expect(sampleVideo(late, flight, null).at(-1)?.t).toBe(6);
  });
});

describe('safeAssetUrl', () => {
  it('builds the project asset URL and returns undefined for a path that leaves the project', () => {
    expect(safeAssetUrl('p1', { path: 'a/f.json' })).toBe('aio://project/p1/a/f.json');
    expect(safeAssetUrl('p1', { path: '../x.json' })).toBeUndefined();
  });
});

describe('spotEntries and unstitched spheres', () => {
  it('lists only the panoramas that have an image', () => {
    const layers = [
      {
        kind: 'panoramas',
        id: 'pano-new',
        name: 'p',
        visible: true,
        items: [
          {
            id: 'q',
            src: { path: 'q.jpg' },
            pos: [0, 0, 0],
            headingDeg: 0,
            stitch: { status: 'queued' },
          },
          {
            id: 'f',
            src: { path: 'f.jpg' },
            pos: [0, 0, 0],
            headingDeg: 0,
            stitch: { status: 'failed' },
          },
          {
            id: 'd',
            src: { path: 'd.jpg' },
            pos: [0, 0, 0],
            headingDeg: 0,
            stitch: { status: 'done' },
          },
        ],
      },
    ] as unknown as Layer[];
    const out = spotEntries({ layers, index: captureIndex({ ...manifest, layers }) });
    expect(out.map((x) => (x.kind === 'pano' ? x.id : x.kind))).toEqual(['d']);
  });
});
