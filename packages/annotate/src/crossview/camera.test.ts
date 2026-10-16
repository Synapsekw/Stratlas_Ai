import type { Layer, PoseSample, Quat, Sighting } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { sightingCamera, type CameraSources } from './camera';

const down: Quat = [-Math.SQRT1_2, 0, 0, Math.SQRT1_2];
const layers: Layer[] = [
  {
    kind: 'photos',
    id: 'photos',
    name: 'Photos',
    visible: true,
    items: [
      {
        id: 'F01',
        src: { path: 'photos/F01.jpg' },
        pos: [3, 10, 4],
        q: down,
        lens: { model: 'pinhole', hfovDeg: 90, aspect: 4 / 3 },
      },
      { id: 'nopose', src: { path: 'photos/x.jpg' } },
    ],
  },
];
const src = (size: [number, number] | null): CameraSources => ({
  layers: () => layers,
  flight: () => null,
  imageSize: () => size,
});
const box: Sighting = {
  on: 'image',
  layer: 'photos',
  photo: 'F01',
  geom: { type: 'box', x: 1, y: 2, w: 3, h: 4 },
};

describe('sightingCamera', () => {
  it('builds the photo camera with its pixel size and shape', () => {
    expect(sightingCamera(box, src([1200, 900]))).toEqual({
      pose: { pos: [3, 10, 4], q: down },
      lens: { model: 'pinhole', hfovDeg: 90, aspect: 4 / 3 },
      size: [1200, 900],
      geom: { type: 'box', x: 1, y: 2, w: 3, h: 4 },
    });
  });

  it('has no camera without a pose or a known size', () => {
    expect(sightingCamera(box, src(null))).toBeNull();
    expect(sightingCamera({ ...box, photo: 'nopose' }, src([10, 10]))).toBeNull();
    expect(sightingCamera({ on: 'map', layer: 'photos', geojson: {} }, src([10, 10]))).toBeNull();
  });

  it('frames an image sighting of a lined-up date from the shifted camera', () => {
    const shifted: CameraSources = {
      ...src([1200, 900]),
      shiftOf: (id) => (id === 'photos' ? { eastM: 2, northM: 1 } : null),
      // the hand-set position comes first, then the shift
      orientation: () => ({
        schema: 'aio.orientation/1',
        clips: {},
        photos: { photos: { F01: { yawDeg: 0, pitchDeg: 0, rollDeg: 0, offsetM: [2, 0, 0] } } },
      }),
    };
    expect(sightingCamera(box, shifted)?.pose.pos).toEqual([7, 10, 3]);
    expect(sightingCamera(box, { ...src([1200, 900]), shiftOf: () => null })?.pose.pos).toEqual([
      3, 10, 4,
    ]);
  });

  it('frames a video sighting of a lined-up date through the shifted offset', () => {
    const video: Layer = {
      kind: 'video',
      id: 'clip',
      name: 'Flight',
      visible: true,
      src: { path: 'video/a.mp4' },
      flight: { src: { path: 'flights/a.json' }, startUtcMs: 0 },
      lens: { model: 'ftheta', hfovDeg: 114, aspect: 16 / 9 },
      offsetMs: 0,
      positionOffsetM: [0, 1, 0],
    };
    const samples: PoseSample[] = [
      { t: 0, pos: [0, 10, 0], q: down },
      { t: 10_000, pos: [10, 10, 0], q: down },
    ];
    const s: Sighting = {
      on: 'video',
      layer: 'clip',
      track: [{ t: 5, geom: { type: 'box', x: 0, y: 0, w: 1, h: 1 } }],
    };
    const base: CameraSources = {
      layers: () => [video],
      flight: () => samples,
      imageSize: () => [1280, 720],
    };
    const plain = sightingCamera(s, base)?.pose.pos ?? [];
    const moved =
      sightingCamera(s, { ...base, shiftOf: () => ({ eastM: 2, northM: 3 }) })?.pose.pos ?? [];
    expect(moved[0]).toBeCloseTo((plain[0] ?? 0) + 2, 6);
    expect(moved[1]).toBeCloseTo(plain[1] ?? 0, 6);
    expect(moved[2]).toBeCloseTo((plain[2] ?? 0) - 3, 6);
  });
});
