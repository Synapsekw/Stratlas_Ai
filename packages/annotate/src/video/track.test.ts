import type { FrameGeom } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import {
  interpolateTrack,
  markRange,
  projectMsFromVideo,
  removeKeyframe,
  setKeyframe,
  trackGeomAt,
  videoTimeS,
  type Keyframe,
} from './track';

const box = (x: number, y = 0, w = 10, h = 10): FrameGeom => ({ type: 'box', x, y, w, h });
const track: Keyframe[] = [
  { t: 1, geom: box(0) },
  { t: 3, geom: box(20, 10, 30, 10) },
];

describe('video time', () => {
  const layer = { flight: { startUtcMs: 1_000_000 }, offsetMs: 500 };

  it('maps project time to video seconds and back', () => {
    expect(videoTimeS(layer, 1_002_500)).toBe(2);
    expect(projectMsFromVideo(layer, 2)).toBe(1_002_500);
  });
});

describe('interpolateTrack', () => {
  it('returns keyframes exactly', () => {
    expect(interpolateTrack(track, 1)).toEqual({ geom: box(0), key: true });
  });

  it('interpolates boxes linearly between keyframes', () => {
    expect(interpolateTrack(track, 2)).toEqual({ geom: box(10, 5, 20, 10), key: false });
  });

  it('is empty outside the track', () => {
    expect(interpolateTrack(track, 0.5)).toBeNull();
    expect(interpolateTrack(track, 3.5)).toBeNull();
  });

  it('shows a single keyframe only near its time', () => {
    const one = [{ t: 2, geom: box(5) }];
    expect(interpolateTrack(one, 2.01)?.geom).toEqual(box(5));
    expect(interpolateTrack(one, 2.5)).toBeNull();
  });

  it('interpolates polygons with the same vertex count', () => {
    const poly = (d: number): FrameGeom => ({
      type: 'polygon',
      points: [
        [d, 0],
        [d + 10, 0],
        [d, 10],
      ],
    });
    const r = interpolateTrack(
      [
        { t: 0, geom: poly(0) },
        { t: 2, geom: poly(10) },
      ],
      1,
    );
    expect(r?.geom).toEqual(poly(5));
  });

  it('holds the earlier shape when shapes cannot be blended', () => {
    const r = interpolateTrack(
      [
        { t: 0, geom: box(0) },
        {
          t: 2,
          geom: {
            type: 'polygon',
            points: [
              [0, 0],
              [1, 0],
              [0, 1],
            ],
          },
        },
      ],
      1,
    );
    expect(r?.geom).toEqual(box(0));
  });
});

describe('editing keyframes', () => {
  it('inserts in time order', () => {
    const next = setKeyframe(track, 2, box(99));
    expect(next.map((k) => k.t)).toEqual([1, 2, 3]);
  });

  it('replaces a keyframe within one frame', () => {
    const next = setKeyframe(track, 3.01, box(99));
    expect(next).toHaveLength(2);
    expect(next[1]?.geom).toEqual(box(99));
    expect(next[1]?.t).toBe(3);
  });

  it('removes a keyframe', () => {
    expect(removeKeyframe(track, 1.005).map((k) => k.t)).toEqual([3]);
  });

  it('never stores a negative time', () => {
    expect(setKeyframe([], -1, box(0))[0]?.t).toBe(0);
  });
});

describe('trackGeomAt', () => {
  it('holds the end shapes outside the track and interpolates inside', () => {
    expect(trackGeomAt(track, 0)).toEqual(box(0));
    expect(trackGeomAt(track, 9)).toEqual(box(20, 10, 30, 10));
    expect(trackGeomAt(track, 2)).toEqual(box(10, 5, 20, 10));
    expect(trackGeomAt([], 2)).toBeNull();
  });
});

describe('markRange', () => {
  it('marks in and out and keeps them ordered', () => {
    expect(markRange(undefined, 'in', 2)).toEqual([2, 2]);
    expect(markRange([2, 2], 'out', 5)).toEqual([2, 5]);
    expect(markRange([2, 5], 'in', 6)).toEqual([6, 6]);
    expect(markRange([2, 5], 'out', 1)).toEqual([1, 1]);
  });
});
