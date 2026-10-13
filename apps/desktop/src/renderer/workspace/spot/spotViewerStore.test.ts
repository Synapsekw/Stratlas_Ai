import { describe, expect, it } from 'vitest';
import {
  createSpotViewer,
  cycleMatch,
  defaultOther,
  matchAt,
  resolveAt,
  startAt,
  stepDate,
} from './spotViewerStore';
import type { SpotHistory, SpotMatch } from './spotTypes';

const m = (capture: string, photo: string): SpotMatch => ({
  capture,
  kind: 'photo',
  item: { kind: 'photo', layer: `photos-${capture}`, photo },
  distanceM: 1,
  angleDeg: 0,
  score: 1,
  aerial: false,
});
const h: SpotHistory = {
  spot: { target: [0, 0, 0], aerial: false },
  dates: [
    { capture: 'd1', matches: [m('d1', 'a')], skipped: 0 },
    { capture: 'd2', matches: [], skipped: 3 },
    { capture: 'd3', matches: [m('d3', 'b'), m('d3', 'c'), m('d3', 'd')], skipped: 0 },
    { capture: 'd4', matches: [], skipped: 0 },
  ],
};

describe('stepping', () => {
  it('steps to the next or previous date with a match, skipping gaps', () => {
    expect(stepDate(h, { capture: 'd1', i: 0 }, 1)).toEqual({ capture: 'd3', i: 0 });
    expect(stepDate(h, { capture: 'd3', i: 2 }, -1)).toEqual({ capture: 'd1', i: 0 });
  });
  it('stays at the ends', () => {
    expect(stepDate(h, { capture: 'd3', i: 1 }, 1)).toEqual({ capture: 'd3', i: 1 });
    expect(stepDate(h, { capture: 'd1', i: 0 }, -1)).toEqual({ capture: 'd1', i: 0 });
  });
  it('cycles the images of a date both ways', () => {
    expect(cycleMatch(h, { capture: 'd3', i: 2 }, 1)).toEqual({ capture: 'd3', i: 0 });
    expect(cycleMatch(h, { capture: 'd3', i: 0 }, -1)).toEqual({ capture: 'd3', i: 2 });
    expect(cycleMatch(h, { capture: 'd1', i: 0 }, 1)).toEqual({ capture: 'd1', i: 0 });
  });
  it('starts at the clicked date, else the newest date with a match', () => {
    expect(startAt(h, 'd1')).toEqual({ capture: 'd1', i: 0 });
    expect(startAt(h, 'd2')).toEqual({ capture: 'd3', i: 0 });
    expect(startAt(h, undefined)).toEqual({ capture: 'd3', i: 0 });
  });
  it('falls back to the start when the shown match is gone', () => {
    expect(resolveAt(h, { capture: 'd3', i: 7 }, 'd1')).toEqual({ capture: 'd1', i: 0 });
    expect(resolveAt(h, { capture: 'gone', i: 0 }, 'd1')).toEqual({ capture: 'd1', i: 0 });
    expect(resolveAt(h, { capture: 'd3', i: 1 }, 'd1')).toEqual({ capture: 'd3', i: 1 });
  });
  it('compares with the date before by default, else the date after', () => {
    expect(defaultOther(h, 'd3')).toEqual({ capture: 'd1', i: 0 });
    expect(defaultOther(h, 'd1')).toEqual({ capture: 'd3', i: 0 });
    expect(matchAt(h, { capture: 'd3', i: 1 })?.item).toEqual({
      kind: 'photo',
      layer: 'photos-d3',
      photo: 'c',
    });
  });
});

describe('store', () => {
  it('opens, moves, compares and closes without other state', () => {
    const s = createSpotViewer();
    s.getState().show({ item: { kind: 'photo', layer: 'photos-d1', photo: 'a' } });
    expect(s.getState().at).toBeNull();
    s.getState().goTo({ capture: 'd3', i: 1 });
    s.getState().setCompare({
      mode: 'swipe',
      left: { capture: 'd3', i: 1 },
      right: null,
      amount: 0.5,
    });
    s.getState().show({ item: { kind: 'pano', layer: 'p', pano: 'x' } }, { capture: 'd1', i: 0 });
    expect(s.getState().at).toEqual({ capture: 'd1', i: 0 });
    expect(s.getState().compare).toBeNull();
    s.getState().close();
    expect(s.getState()).toMatchObject({ open: null, at: null, compare: null });
  });
});
