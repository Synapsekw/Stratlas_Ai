// @vitest-environment jsdom
import { createStore } from 'zustand/vanilla';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../shell', () => ({
  shell: {
    getState: () => ({ screen: 'scene', stageMode: 'split', go: vi.fn(), setStageMode: vi.fn() }),
  },
}));
vi.mock('./walks', () => ({ walks: { getState: () => ({ select: vi.fn() }) } }));

import {
  APART_M,
  comparedWalks,
  createWalkCompareStore,
  detourBands,
  followStep,
  inBand,
  leadTimeAt,
  placeRate,
  linkedYawDeg,
  lookBearingDeg,
  nearestOnTrack,
  pairFollower,
  speedAt,
  type TrackPt,
} from './walkCompare';

/** A straight track from `a` to `b` (x/z metres) over `t0`..`t1` seconds, a point every `step`. */
function line(
  a: [number, number],
  b: [number, number],
  t0: number,
  t1: number,
  step = 0.25,
): TrackPt[] {
  const out: TrackPt[] = [];
  const n = Math.round((t1 - t0) / step);
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    out.push({ t: t0 + f * (t1 - t0), x: a[0] + f * (b[0] - a[0]), z: a[1] + f * (b[1] - a[1]) });
  }
  return out;
}

describe('pairing by place', () => {
  it('finds the moment of the track nearest a spot, and how far it is', () => {
    const track = line([0, 0], [100, 0], 0, 100);
    const n = nearestOnTrack(track, 40, 3, {});
    expect(n?.t).toBeCloseTo(40, 1);
    expect(n?.dist).toBeCloseTo(3, 5);
  });

  it('has no moment on an empty track', () => {
    expect(nearestOnTrack([], 0, 0, {})).toBeNull();
  });

  it('prefers the pass going the same way when a walk crosses a spot twice', () => {
    // out east along z = 0, back west along z = 0.4 (a hair nearer the spot on the way back)
    const there = line([0, 0], [100, 0], 0, 100);
    const back = line([100, 0.4], [0, 0.4], 100, 200);
    const track = [...there, ...back];
    const east = nearestOnTrack(track, 50, 0.5, { dir: [1, 0] });
    expect(east?.t).toBeCloseTo(50, 0);
    const west = nearestOnTrack(track, 50, 0.5, { dir: [-1, 0] });
    expect(west?.t).toBeCloseTo(150, 0);
    // no direction known: the nearest pass
    expect(nearestOnTrack(track, 50, 0.5, {})?.t).toBeCloseTo(150, 0);
  });

  it('keeps to the pass it is on while playing (no jump to the other pass)', () => {
    const there = line([0, 0], [100, 0], 0, 100);
    const back = line([100, 0.4], [0, 0.4], 100, 200);
    const track = [...there, ...back];
    // the lead heads west, but the follower was just at 49 s on the way out
    expect(nearestOnTrack(track, 50, 0.5, { dir: [-1, 0], prevT: 49 })?.t).toBeCloseTo(50, 0);
  });

  it('pairs the follower with the lead by place, the lead going the same way', () => {
    const lead = line([0, 0], [100, 0], 0, 50); // fast: 2 m/s
    const followThere = line([0, 1], [100, 1], 0, 200); // slow: 0.5 m/s
    const followBack = line([100, 1.2], [0, 1.2], 200, 300);
    const follow = [...followThere, ...followBack];
    const p = pairFollower(lead, follow, 20, 'place', null);
    // the lead is at x = 40 heading east: the follower's way out passes x = 40 at 80 s
    expect(p.t).toBeCloseTo(80, 0);
    expect(p.dist).toBeCloseTo(1, 1);
  });

  it('pairs by time: the same second, and the distance between the two spots', () => {
    const lead = line([0, 0], [100, 0], 0, 100);
    const follow = line([0, 6], [100, 6], 0, 100);
    const p = pairFollower(lead, follow, 30, 'time', 12);
    expect(p.t).toBe(30);
    expect(p.dist).toBeCloseTo(6, 5);
  });

  it('pairs nothing when a walk is not placed', () => {
    expect(pairFollower([], line([0, 0], [1, 0], 0, 1), 3, 'place', null)).toEqual({
      t: 3,
      dist: null,
    });
  });
});

describe('detours', () => {
  it('shades the stretches where the other walk has no frame within 5 m', () => {
    const own = line([0, 0], [100, 0], 0, 100, 0.5);
    // the other walk only covers x 0..30 and 70..100
    const other = [...line([0, 1], [30, 1], 0, 30, 0.5), ...line([70, 1], [100, 1], 30, 60, 0.5)];
    const bands = detourBands(own, other);
    expect(bands).toHaveLength(1);
    const [b] = bands;
    // within 5 m of x = 30 and x = 70 still counts as together
    expect(b?.fromT).toBeGreaterThan(34);
    expect(b?.fromT).toBeLessThan(36);
    expect(b?.toT).toBeGreaterThan(64);
    expect(b?.toT).toBeLessThan(66);
    expect(inBand(bands, 50)).toBe(true);
    expect(inBand(bands, 10)).toBe(false);
    expect(APART_M).toBe(5);
  });

  it('shades nothing for two walks along one route, and everything when the other is missing', () => {
    const own = line([0, 0], [100, 0], 0, 100, 0.5);
    expect(detourBands(own, line([0, 2], [100, 2], 0, 60, 0.5))).toEqual([]);
    expect(detourBands(own, [])).toEqual([]);
  });
});

describe('a smooth follower', () => {
  it('measures the ground speed along a track', () => {
    expect(speedAt(line([0, 0], [100, 0], 0, 50), 20)).toBeCloseTo(2, 5);
    expect(speedAt([], 20)).toBe(0);
  });

  it('plays at the lead rate scaled by the two speeds when on time', () => {
    const s = followStep({ targetT: 10, currentT: 10, desiredRate: 1.5, leadPlaying: true });
    expect(s).toEqual({ play: true, rate: 1.5, seekTo: null });
  });

  it('catches up a small drift with the rate, never with a seek', () => {
    const s = followStep({ targetT: 10.4, currentT: 10, desiredRate: 1, leadPlaying: true });
    expect(s.seekTo).toBeNull();
    expect(s.rate).toBeGreaterThan(1);
    const late = followStep({ targetT: 10, currentT: 10.4, desiredRate: 1, leadPlaying: true });
    expect(late.rate).toBeLessThan(1);
  });

  it('keeps pace by place: the lead rate times the lead speed over the follower speed', () => {
    expect(placeRate(1, 2, 1)).toBe(2);
    expect(placeRate(2, 1, 1)).toBe(2);
    // the lead stands still: hold
    expect(placeRate(1, 0, 1)).toBe(0);
  });

  it('runs the lead clock on between its time updates', () => {
    const c = { walk: 'a', t: 10, atMs: 1000, playing: true, rate: 2 };
    expect(leadTimeAt(c, 1500)).toBe(11);
    expect(leadTimeAt({ ...c, playing: false }, 1500)).toBe(10);
  });

  it('clamps the rate', () => {
    expect(followStep({ targetT: 5, currentT: 5, desiredRate: 40, leadPlaying: true }).rate).toBe(
      4,
    );
  });

  it('seeks once when the drift is too large to catch up', () => {
    const s = followStep({ targetT: 30, currentT: 10, desiredRate: 1, leadPlaying: true });
    expect(s.seekTo).toBe(30);
    expect(s.play).toBe(true);
  });

  it('holds still while the lead stands still', () => {
    const s = followStep({ targetT: 10, currentT: 10.1, desiredRate: 0, leadPlaying: true });
    expect(s.play).toBe(false);
    expect(s.seekTo).toBeNull();
  });

  it('pauses with the lead, on the paired frame', () => {
    expect(followStep({ targetT: 12, currentT: 10, desiredRate: 1, leadPlaying: false })).toEqual({
      play: false,
      rate: null,
      seekTo: 12,
    });
    expect(
      followStep({ targetT: 12, currentT: 12.01, desiredRate: 1, leadPlaying: false }).seekTo,
    ).toBeNull();
  });
});

describe('link look', () => {
  it('turns each pane by its own walk heading to look at one bearing', () => {
    // the driver heads 90 (east) and looks 30 to its right: bearing 120
    const look = lookBearingDeg(90, 30);
    expect(look).toBe(120);
    // the other walk heads 200: it turns 280 (that is, 80 to its left) to look at 120
    expect(linkedYawDeg(look, 200)).toBe(280);
    expect(lookBearingDeg(200, linkedYawDeg(look, 200))).toBe(120);
    expect(lookBearingDeg(350, 20)).toBe(10);
  });
});

describe('the compare store', () => {
  const fakeWorkspace = () =>
    createStore<{ project: { id: string } | null }>()(() => ({ project: { id: 'p1' } }));

  it('swaps the lead, and the new lead steers the look', () => {
    const s = createWalkCompareStore(fakeWorkspace());
    s.getState().begin('a', 'b');
    s.getState().swapLead();
    expect(s.getState()).toMatchObject({ left: 'a', right: 'b', lead: 'right', driver: 'right' });
    s.getState().swapLead();
    expect(s.getState().lead).toBe('left');
  });

  it('starts with link look on, following by place', () => {
    const s = createWalkCompareStore(fakeWorkspace());
    expect(s.getState()).toMatchObject({ linkLook: true, mode: 'place', active: false });
  });

  it('shows both walks of a running compare, and none when it ends', () => {
    const s = createWalkCompareStore(fakeWorkspace());
    expect(comparedWalks(s.getState())).toEqual([]);
    s.getState().begin('a', 'b');
    expect(comparedWalks(s.getState())).toEqual(['a', 'b']);
    s.getState().end();
    expect(comparedWalks(s.getState())).toEqual([]);
  });

  it('remembers the compare per project for the session', () => {
    const ws = fakeWorkspace();
    const s = createWalkCompareStore(ws);
    s.getState().begin('a', 'b');
    s.setState({ mode: 'time', linkLook: false });
    ws.setState({ project: { id: 'p2' } });
    expect(s.getState()).toMatchObject({ active: false, mode: 'place', linkLook: true });
    ws.setState({ project: { id: 'p1' } });
    expect(s.getState()).toMatchObject({
      active: true,
      left: 'a',
      right: 'b',
      mode: 'time',
      linkLook: false,
    });
  });

  it('a walk seeked into its detour plays on its own until the lead plays', () => {
    const s = createWalkCompareStore(fakeWorkspace());
    s.getState().begin('a', 'b');
    s.getState().goSolo('right');
    expect(s.getState().solo).toBe('right');
    s.getState().leadPlays();
    expect(s.getState().solo).toBeNull();
  });

  it('a solo follower that rejoins while playing takes the lead (no jump back)', () => {
    const s = createWalkCompareStore(fakeWorkspace());
    s.getState().begin('a', 'b');
    s.getState().goSolo('right');
    s.getState().rejoin('right', true);
    expect(s.getState()).toMatchObject({ solo: null, lead: 'right' });
    s.getState().goSolo('right');
    s.getState().rejoin('right', false);
    expect(s.getState()).toMatchObject({ solo: null, lead: 'right' });
  });
});
