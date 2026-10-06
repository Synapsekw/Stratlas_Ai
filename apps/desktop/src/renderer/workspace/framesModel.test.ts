import type { Layer } from '@aio/schema';
import { captureIndex } from '@aio/workspace';
import { describe, expect, it } from 'vitest';
import {
  createFramesStore,
  frameTime,
  layerCapture,
  otherCapture,
  pickSource,
  splitWithFrames,
  stepPhoto,
} from './framesModel';
import { paneOptions, parseSplitPref, resolveSplit } from './splitModel';

const Q = [0, 0, 0, 1] as [number, number, number, number];
const photos = (id: string, items: string[], extra: object = {}): Layer =>
  ({
    kind: 'photos',
    id,
    name: id,
    visible: true,
    opacity: 1,
    items: items.map((p, i) => ({
      id: p,
      src: { path: `photos/${p}.jpg` },
      ...(i > 0 ? { pos: [i, 30, 0], q: Q } : {}),
    })),
    ...extra,
  }) as Layer;
const video = (id: string): Layer =>
  ({
    kind: 'video',
    id,
    name: id,
    visible: true,
    opacity: 1,
    src: { path: `video/${id}.mp4` },
    flight: { src: { path: `video/${id}.json` }, startUtcMs: 0 },
    lens: { model: 'pinhole', hfovDeg: 70, aspect: 1.5 },
    offsetMs: 0,
  }) as Layer;

describe('pickSource', () => {
  const layers = [photos('ph', ['p0', 'p1', 'p2']), video('v1'), video('v2')];

  it('keeps the chosen view while it exists', () => {
    expect(pickSource(layers, { kind: 'video', layer: 'v2' }, null, 'v1')).toEqual({
      kind: 'video',
      layer: 'v2',
    });
    expect(pickSource(layers, { kind: 'photo', layer: 'ph', photo: 'gone' }, null, 'v1')).toEqual({
      kind: 'video',
      layer: 'v1',
    });
  });

  it('takes the selected photo, then the playing clip, then the first clip', () => {
    expect(pickSource(layers, null, { kind: 'photo', id: 'p2', layer: 'ph' }, 'v2')).toEqual({
      kind: 'photo',
      layer: 'ph',
      photo: 'p2',
    });
    expect(pickSource(layers, null, null, 'v2')).toEqual({ kind: 'video', layer: 'v2' });
    expect(pickSource(layers, null, null, null)).toEqual({ kind: 'video', layer: 'v1' });
  });

  it('falls back to the first photo with a camera position', () => {
    expect(pickSource([photos('ph', ['p0', 'p1'])], null, null, null)).toEqual({
      kind: 'photo',
      layer: 'ph',
      photo: 'p1',
    });
    expect(pickSource([photos('ph', ['p0'])], null, null, null)).toBeNull();
  });
});

describe('dates', () => {
  const manifest = {
    captures: [
      { id: 'c3', label: 'C', date: '2026-09-01' },
      { id: 'c1', label: 'A', date: '2026-01-01' },
      { id: 'c2', label: 'B', date: '2026-06-01' },
    ],
    layers: [
      photos('photos-2026-01-01', ['a']),
      photos('photos-2026-06-01', ['b']),
      photos('later', ['c'], { capture: 'c3' }),
    ],
  };
  const index = captureIndex(manifest);

  it('reads the date of a layer, the explicit capture first', () => {
    const [first, , last] = manifest.layers;
    if (!first || !last) throw new Error('fixture');
    expect(layerCapture(first, index)).toBe('c1');
    expect(layerCapture(last, index)).toBe('c3');
  });

  it('compares with the next date, the earlier one from the last, or the chosen one', () => {
    expect(otherCapture(index, 'c1', null)).toBe('c2');
    expect(otherCapture(index, 'c3', null)).toBe('c2');
    expect(otherCapture(index, 'c1', 'c3')).toBe('c3');
    expect(otherCapture(index, 'c1', 'c1')).toBe('c2');
    expect(otherCapture(index, 'nope', null)).toBeUndefined();
  });
});

describe('the split with the Frames pane', () => {
  it('is offered with photos or video on two dates, and remembered', () => {
    expect(paneOptions([{ kind: 'mesh' }], 0, 2)).not.toContain('frames');
    expect(paneOptions([{ kind: 'video' }], 0)).not.toContain('frames');
    expect(paneOptions([{ kind: 'video' }], 0, 2)).toContain('frames');
    expect(paneOptions([{ kind: 'photos' }], 0, 3)).toContain('frames');
    expect(parseSplitPref({ left: '3d', right: 'frames' })).toEqual({
      left: '3d',
      right: 'frames',
    });
    expect(resolveSplit({ left: '3d', right: 'frames' }, ['3d', 'map', 'frames'])).toMatchObject({
      left: '3d',
      right: 'frames',
    });
  });

  it('goes on the right, beside what the left shows', () => {
    expect(splitWithFrames({ left: 'video', right: 'map' })).toEqual({
      left: 'video',
      right: 'frames',
    });
    expect(splitWithFrames({ left: 'frames', right: 'map' })).toEqual({
      left: 'frames',
      right: 'map',
    });
    // two maps of two dates: the left becomes the 3D view
    expect(splitWithFrames({ left: 'map', right: 'map' })).toMatchObject({
      left: '3d',
      right: 'frames',
    });
  });
});

describe('stepping and time', () => {
  it('steps through a photo set, wrapping', () => {
    const l = photos('ph', ['a', 'b', 'c']) as Extract<Layer, { kind: 'photos' }>;
    expect(stepPhoto(l, 'a', 1)).toBe('b');
    expect(stepPhoto(l, 'a', -1)).toBe('c');
    expect(stepPhoto(l, 'c', 1)).toBe('a');
  });

  it('snaps the clock to frames', () => {
    expect(frameTime(1.01)).toBeCloseTo(1, 9);
    expect(frameTime(1.02)).toBeCloseTo(1 + 1 / 30, 9);
    expect(frameTime(-2)).toBe(0);
  });

  it('keeps the blend amount between 0 and 1', () => {
    const s = createFramesStore();
    s.getState().setAmount(2);
    expect(s.getState().amount).toBe(1);
    s.getState().setMode('blend');
    expect(s.getState().mode).toBe('blend');
  });
});
