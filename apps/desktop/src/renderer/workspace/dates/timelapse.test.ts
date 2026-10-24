import type { Layer } from '@aio/schema';
import type { CaptureIndex } from '@aio/workspace';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { createDatesPlayer, type PlayerFrame } from './datesPlayer';
import {
  connectTimelapse,
  isManualDateChange,
  playheadDay,
  rasterBlend,
  timelapseStore,
  timelapseView,
  type TimelapseDeps,
} from './timelapse';

const DAY = 86_400_000;
const T0 = Date.parse('2020-12-31T00:00:00Z');
const T1 = Date.parse('2021-01-10T00:00:00Z');

const frame = (f: number, next: number | null = T1): PlayerFrame => ({
  t: next === null ? T0 : T0 + (T1 - T0) * f,
  passed: T0,
  next,
  f,
  ended: false,
});

describe('timelapseView', () => {
  it('crossfade sets both opacities from f', () => {
    const v = timelapseView(frame(0.3), 'crossfade', false);
    expect(v.blend).toBeCloseTo(0.3, 9);
    expect(v.scene).toBe('passed');
    expect(v.swipeX).toBeNull();
  });

  it('3D swaps at the middle with crossfade', () => {
    expect(timelapseView(frame(0.49), 'crossfade', false).scene).toBe('passed');
    expect(timelapseView(frame(0.5), 'crossfade', false).scene).toBe('next');
    expect(timelapseView(frame(0.9), 'crossfade', false).scene).toBe('next');
  });

  it('hold keeps the earlier date until the next survey', () => {
    const v = timelapseView(frame(0.95), 'hold', false);
    expect(v).toEqual({ blend: null, scene: 'passed', swipeX: null });
  });

  it('swipe drives the kit swipe, the later survey growing from the right', () => {
    const v = timelapseView(frame(0.25), 'swipe', true);
    expect(v.blend).toBeNull();
    expect(v.scene).toBe('passed');
    expect(v.swipeX).toBeCloseTo(0.75, 9);
  });

  it('swipe without the kit crossfades instead', () => {
    expect(timelapseView(frame(0.6), 'swipe', false)).toEqual(
      timelapseView(frame(0.6), 'crossfade', false),
    );
  });

  it('on a survey or at the end nothing is blended', () => {
    expect(timelapseView(frame(0), 'crossfade', false).blend).toBeNull();
    expect(timelapseView(frame(0, null), 'crossfade', false)).toEqual({
      blend: null,
      scene: 'passed',
      swipeX: null,
    });
  });
});

describe('rasterBlend', () => {
  const index: CaptureIndex = {
    captures: [
      { id: 'a', date: '2020-12-31' },
      { id: 'b', date: '2021-01-10' },
    ] as CaptureIndex['captures'],
    layers: { a: ['ortho-a', 'dsm-a', 'mesh-a'], b: ['ortho-b', 'dsm-b', 'mesh-b'] },
    of: {
      'ortho-a': 'a',
      'dsm-a': 'a',
      'mesh-a': 'a',
      'ortho-b': 'b',
      'dsm-b': 'b',
      'mesh-b': 'b',
    },
    epochs: {},
    slot: {
      'ortho-a': 'raster:ortho:o',
      'ortho-b': 'raster:ortho:o',
      'dsm-a': 'raster:dsm:d',
      'dsm-b': 'raster:dsm:d',
      'mesh-a': 'mesh:m',
      'mesh-b': 'mesh:m',
    },
  };
  const layers = [
    { id: 'ortho-a', kind: 'raster' },
    { id: 'dsm-a', kind: 'raster' },
    { id: 'mesh-a', kind: 'mesh' },
    { id: 'ortho-b', kind: 'raster' },
    { id: 'dsm-b', kind: 'raster' },
    { id: 'mesh-b', kind: 'mesh' },
    { id: 'basemap', kind: 'raster' },
  ] as Pick<Layer, 'id' | 'kind'>[];

  it('blends the shown rasters of the passed date with their counterparts', () => {
    const hidden = { 'dsm-a': true, 'ortho-b': true, 'dsm-b': true, 'mesh-b': true } as const;
    const b = rasterBlend(index, layers, hidden, 'a', 'b', 0.55);
    expect(b).toHaveLength(2);
    expect(b[0]).toEqual({ layerId: 'ortho-a', opacity: expect.closeTo(0.45, 9) as number });
    expect(b[1]).toEqual({ layerId: 'ortho-b', opacity: 0.55 });
  });

  it('is empty when the passed date shows no raster', () => {
    const hidden = { 'ortho-a': true, 'dsm-a': true } as const;
    expect(rasterBlend(index, layers, hidden, 'a', 'b', 0.5)).toEqual([]);
  });
});

describe('isManualDateChange', () => {
  it('a focus other than the last survey passed is a manual change', () => {
    expect(isManualDateChange('b', 'a')).toBe(true);
    expect(isManualDateChange('a', 'a')).toBe(false);
    expect(isManualDateChange(null, 'a')).toBe(false);
    expect(isManualDateChange('a', null)).toBe(true);
  });
});

describe('playheadDay', () => {
  it('names the playhead calendar day', () => {
    expect(playheadDay(T0 + 5 * DAY + 3600_000)).toBe('2021-01-05');
    expect(playheadDay(Number.NaN)).toBeNull();
  });
});

describe('connectTimelapse', () => {
  let stop: (() => void) | null = null;
  afterEach(() => {
    stop?.();
    stop = null;
    timelapseStore.setState({ scene: null });
  });

  function setup(kit = false) {
    const player = createDatesPlayer();
    const focus = createStore<{ focus: string | null }>(() => ({ focus: 'a' }));
    const pile = createStore<{ focus: string | null }>(() => ({ focus: null }));
    const map = { setRasterBlend: vi.fn() };
    const swipe = vi.fn();
    const keys = new EventTarget();
    const deps: TimelapseDeps = {
      player,
      focus: {
        get: () => focus.getState().focus,
        subscribe: (cb) => focus.subscribe(cb),
      },
      captureAt: (t) => (t === T0 ? 'a' : t === T1 ? 'b' : null),
      map: () => map,
      blendFor: (from, to, f) => [
        { layerId: `ortho-${from}`, opacity: 1 - f },
        { layerId: `ortho-${to}`, opacity: f },
      ],
      kitSwipe: { available: () => kit, set: swipe },
      onPileClick: (cb) =>
        pile.subscribe((s, p) => {
          if (s.focus !== p.focus && s.focus !== null) cb();
        }),
      keys,
    };
    stop = connectTimelapse(deps);
    const playTo = (f: number) => {
      player.setState({ playing: true, frame: frame(f), t: frame(f).t });
    };
    return { player, focus, pile, map, swipe, keys, playTo };
  }

  it('blends the map and swaps the 3D view at the middle while playing', () => {
    const s = setup();
    s.playTo(0.3);
    expect(s.map.setRasterBlend).toHaveBeenLastCalledWith([
      { layerId: 'ortho-a', opacity: 0.7 },
      { layerId: 'ortho-b', opacity: 0.3 },
    ]);
    expect(timelapseStore.getState().scene).toBeNull();
    s.playTo(0.6);
    expect(timelapseStore.getState().scene).toBe('b');
  });

  it('a manual date change stops playback and clears the blend', () => {
    const s = setup();
    s.playTo(0.3);
    s.focus.setState({ focus: 'b' });
    expect(s.player.getState().playing).toBe(false);
    expect(s.map.setRasterBlend).toHaveBeenLastCalledWith(null);
    expect(timelapseStore.getState().scene).toBeNull();
  });

  it('the focus moving with the playhead does not stop it', () => {
    const s = setup();
    s.playTo(0.3);
    s.focus.setState({ focus: 'a' });
    expect(s.player.getState().playing).toBe(true);
  });

  it('a pile click and Esc stop playback', () => {
    const s = setup();
    s.playTo(0.3);
    s.pile.setState({ focus: 'pile-1' });
    expect(s.player.getState().playing).toBe(false);
    s.playTo(0.4);
    s.keys.dispatchEvent(Object.assign(new Event('keydown'), { key: 'Escape' }));
    expect(s.player.getState().playing).toBe(false);
    expect(s.map.setRasterBlend).toHaveBeenLastCalledWith(null);
  });

  it('hold never blends', () => {
    const s = setup();
    s.player.getState().setBetween('hold');
    s.playTo(0.8);
    expect(s.map.setRasterBlend).not.toHaveBeenCalledWith(expect.arrayContaining([]));
    expect(timelapseStore.getState().scene).toBeNull();
  });

  it('swipe drives the kit swipe and turns it off on pause', () => {
    const s = setup(true);
    s.player.getState().setBetween('swipe');
    s.playTo(0.25);
    expect(s.swipe).toHaveBeenLastCalledWith(0.75);
    s.player.getState().pause();
    expect(s.swipe).toHaveBeenLastCalledWith(null);
  });
});
