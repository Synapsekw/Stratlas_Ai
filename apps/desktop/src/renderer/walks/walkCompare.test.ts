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
  followerSeek,
  followStep,
  inBand,
  leadClock,
  moveLeadTo,
  leadClockOf,
  leadTimeAt,
  placeRate,
  linkedYawDeg,
  lookBearingDeg,
  nearestOnTrack,
  pairFollower,
  relookDeg,
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

  it('lies between two samples: the spot projected onto the nearest stretch of the track', () => {
    // samples every 0.25 m: a spot 0.1 m past one pairs 0.1 s later, not on the sample
    const track = line([0, 0], [100, 0], 0, 100);
    const n = nearestOnTrack(track, 40.1, 3, {});
    expect(n?.t).toBeCloseTo(40.1, 6);
    expect(n?.dist).toBeCloseTo(3, 9);
    // past either end the end itself
    expect(nearestOnTrack(track, -4, 0, {})?.t).toBe(0);
    expect(nearestOnTrack(track, 104, 0, {})?.t).toBe(100);
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

describe('scrubbing the follower', () => {
  // the lead walks east along z 0; the follower walks the same way 1 m north, twice as slow
  const lead = line([0, 0], [40, 0], 0, 40);
  const follow = line([0, -1], [40, -1], 0, 80);
  const base = { leadTrack: lead, followTrack: follow, mode: 'place' as const, leadT: 5 };

  it('outside a detour the lead moves to the place nearest the follower’s new spot', () => {
    // the follower dragged to 50 s (25 m along): the lead goes to its 25 m, 25 s
    const r = followerSeek({ ...base, followT: 50, bands: [], solo: false, playing: false });
    expect(r.kind).toBe('lead');
    if (r.kind !== 'lead') throw new Error('kind');
    expect(r.leadT).toBeCloseTo(25, 6);
  });

  it('by time the lead goes to the same second', () => {
    const r = followerSeek({
      ...base,
      mode: 'time',
      followT: 12,
      bands: [],
      solo: false,
      playing: false,
    });
    expect(r).toEqual({ kind: 'lead', leadT: 12 });
  });

  it('inside a detour band the follower plays on its own; the lead stays', () => {
    const bands = [{ fromT: 40, toT: 60 }];
    expect(followerSeek({ ...base, followT: 50, bands, solo: false, playing: false })).toEqual({
      kind: 'solo',
    });
  });

  it('a solo walk dragged out of its detour while playing takes the lead, else moves it', () => {
    const bands = [{ fromT: 40, toT: 60 }];
    expect(followerSeek({ ...base, followT: 70, bands, solo: true, playing: true })).toEqual({
      kind: 'rejoin',
    });
    expect(followerSeek({ ...base, followT: 70, bands, solo: true, playing: false }).kind).toBe(
      'lead',
    );
  });

  it('walks not placed: the lead takes the same second', () => {
    const r = followerSeek({
      ...base,
      leadTrack: [],
      followTrack: [],
      followT: 7,
      bands: [],
      solo: false,
      playing: false,
    });
    expect(r).toEqual({ kind: 'lead', leadT: 7 });
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

  it('runs the lead clock on half a second at most: a lead that stalls is not run past', () => {
    const c = { walk: 'a', t: 10, atMs: 1000, playing: true, rate: 2 };
    expect(leadTimeAt(c, 4000)).toBe(11);
  });

  it("reads the lead's clock off its video: waiting for data or seeking, it does not play", () => {
    const v = { currentTime: 4, paused: false, ended: false, seeking: false, playbackRate: 1.5 };
    expect(leadClockOf(v, 'a', 100, false)).toEqual({
      walk: 'a',
      t: 4,
      atMs: 100,
      playing: true,
      rate: 1.5,
    });
    expect(leadClockOf(v, 'a', 100, true).playing).toBe(false);
    expect(leadClockOf({ ...v, seeking: true }, 'a', 100, false).playing).toBe(false);
    expect(leadClockOf({ ...v, paused: true }, 'a', 100, false).playing).toBe(false);
    expect(leadClockOf({ ...v, ended: true }, 'a', 100, false).playing).toBe(false);
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

  it('holding still, it still goes to its frame when it is off by more than a quarter second', () => {
    expect(followStep({ targetT: 10, currentT: 10.6, desiredRate: 0, leadPlaying: true })).toEqual({
      play: false,
      rate: null,
      seekTo: 10,
    });
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

  // a date lined up by a 30 degree turn draws every direction 30 degrees anticlockwise
  const turned = {
    eastM: 0,
    northM: 0,
    turn: { rotationDeg: 30, scale: 1, pivotE: 0, pivotN: 0, pivotX: 0, pivotZ: 0 },
  };

  it("looks at the world bearing each date's line-up turn draws", () => {
    // heading 90 looking 30 right is 120 in the walk's own frame, 90 once its date turns 30
    expect(lookBearingDeg(90, 30, turned)).toBe(90);
    // to look at world 120 on the turned date, it looks at 150 in its own frame
    expect(linkedYawDeg(120, 90, turned)).toBe(60);
    expect(lookBearingDeg(90, linkedYawDeg(120, 90, turned), turned)).toBe(120);
    expect(linkedYawDeg(120, 90, null)).toBe(30);
  });

  it("carries a pane's look into the other date's frame", () => {
    // the turned driver looks at 150 in its own frame: world 120; the plain walk looks at 120
    expect(relookDeg(150, turned, null)).toBe(120);
    expect(relookDeg(120, null, turned)).toBe(150);
    expect(relookDeg(45, turned, turned)).toBe(45);
    expect(relookDeg(45, null, null)).toBe(45);
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

  it('a seek asked of the lead is new each time, and runs the lead clock there at once', () => {
    const s = createWalkCompareStore(fakeWorkspace());
    s.getState().begin('a', 'b');
    s.getState().requestLeadSeek(4);
    const first = s.getState().leadSeek;
    expect(first?.t).toBe(4);
    s.getState().requestLeadSeek(4);
    expect(s.getState().leadSeek?.seq).toBe((first?.seq ?? 0) + 1);
    leadClock.setState({ now: { walk: 'a', t: 1, atMs: 0, playing: false, rate: 1 } });
    moveLeadTo(s, 9, 500);
    // the follower's next tick pairs with where the lead is going, not where it was
    expect(leadClock.getState().now).toMatchObject({ walk: 'a', t: 9, atMs: 500 });
    expect(s.getState().leadSeek?.t).toBe(9);
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
