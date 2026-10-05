import type { PoseSample, Quat } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import {
  distanceAt,
  formatClipTime,
  formatDistance,
  placeLabels,
  pointAtDistance,
  tickDistances,
  tickStep,
  traceProfile,
  traceReadout,
} from './traceMath';

/** Camera looking north (-Z), pitched down by `deg`. */
function lookNorthDown(deg: number): Quat {
  const a = (-deg * Math.PI) / 360;
  return [Math.sin(a), 0, 0, Math.cos(a)];
}

/** A flight east along x at 5 m/s, 40 m up, 10 Hz, for 20 s. */
const east: PoseSample[] = Array.from({ length: 201 }, (_, i) => ({
  t: i * 100,
  pos: [i * 0.5, 40, 0],
  q: lookNorthDown(30),
}));

describe('traceProfile', () => {
  it('measures the distance flown along the clip, with interpolated ends', () => {
    const p = traceProfile(east, 2050, 12_050);
    expect(p.t[0]).toBe(2050);
    expect(p.t[p.n - 1]).toBe(12_050);
    expect(p.length).toBeCloseTo(50, 6);
    expect(distanceAt(p, 2050)).toBeCloseTo(0, 6);
    expect(distanceAt(p, 7050)).toBeCloseTo(25, 6);
    expect(distanceAt(p, 99_999)).toBeCloseTo(50, 6);
  });

  it('adds the calibration offset to the drawn positions', () => {
    const p = traceProfile(east, 0, 1000, [1, 2, 3]);
    expect([p.pos[0], p.pos[1], p.pos[2]]).toEqual([1, 42, 3]);
  });

  it('does not count hover jitter as distance flown', () => {
    const hover: PoseSample[] = Array.from({ length: 101 }, (_, i) => ({
      t: i * 100,
      pos: [(i % 2) * 0.2, 30, ((i >> 1) % 2) * 0.2],
      q: [0, 0, 0, 1],
    }));
    const raw = 100 * 0.2;
    expect(traceProfile(hover, 0, 10_000).length).toBeLessThan(raw * 0.3);
  });

  it('finds the point and the travel direction at a distance', () => {
    const p = traceProfile(east, 0, 20_000);
    const at = pointAtDistance(p, 30);
    expect(at.pos[0]).toBeCloseTo(30, 6);
    expect(at.pos[1]).toBe(40);
    expect(at.dir[0]).toBeCloseTo(1, 6);
    expect(at.dir[1]).toBeCloseTo(0, 6);
  });
});

describe('distance ticks', () => {
  it('chooses 10, 25, 50 or 100 m with the zoom', () => {
    expect(tickStep(0.15, 2000)).toBe(10);
    expect(tickStep(0.4, 2000)).toBe(25);
    expect(tickStep(0.8, 2000)).toBe(50);
    expect(tickStep(1.5, 2000)).toBe(100);
    // indoors, close up: metres
    expect(tickStep(0.01, 48)).toBe(1);
  });

  it('never puts more than MAX_TICKS ticks on a long clip', () => {
    expect(tickStep(0.01, 7000)).toBe(25);
  });

  it('places ticks every step up to the distance flown', () => {
    expect(tickDistances(25, 110)).toEqual([25, 50, 75, 100]);
    expect(tickDistances(10, 9)).toEqual([]);
  });

  it('labels distances in metres and kilometres', () => {
    expect(formatDistance(250)).toBe('250 m');
    expect(formatDistance(3.4)).toBe('3.4 m');
    expect(formatDistance(1250)).toBe('1.25 km');
    expect(formatDistance(2000)).toBe('2 km');
    expect(formatClipTime(83.9)).toBe('01:23');
    expect(formatClipTime(3725)).toBe('1:02:05');
  });
});

describe('traceReadout', () => {
  const p = traceProfile(east, 2000, 18_000);
  const base = {
    samples: east,
    flightMs: 10_000,
    clipStartMs: 2000,
    profile: p,
    groundY: 4,
    originH: 100,
  };

  it('reads distance, heights, speed, heading, gimbal and clip time from the pose', () => {
    const r = traceReadout(base);
    expect(r.distanceM).toBeCloseTo(40, 6);
    expect(r.aglM).toBeCloseTo(36, 6);
    expect(r.elevationM).toBeCloseTo(140, 6);
    expect(r.groundSpeedMps).toBeCloseTo(5, 6);
    expect(r.headingDeg).toBeCloseTo(0, 4);
    expect(r.gimbalDeg).toBeCloseTo(-30, 4);
    expect(r.clipS).toBeCloseTo(8, 6);
  });

  it('uses the A1 calibration: position offset and orientation bias', () => {
    const r = traceReadout({
      ...base,
      offset: [0, 10, 0],
      orientation: { yawDeg: -90, pitchDeg: 0, rollDeg: 0 },
    });
    expect(r.elevationM).toBeCloseTo(150, 6);
    expect(r.aglM).toBeCloseTo(46, 6);
    // a negative yaw bias turns the view right: from north to east
    expect(r.headingDeg).toBeCloseTo(90, 3);
  });

  it('leaves the height above ground unknown without a ground', () => {
    expect(traceReadout({ ...base, groundY: null }).aglM).toBeNull();
  });

  it('grows the distance as the playhead moves', () => {
    const a = traceReadout({ ...base, flightMs: 5000 }).distanceM;
    const b = traceReadout({ ...base, flightMs: 6000 }).distanceM;
    expect(b - a).toBeCloseTo(5, 6);
  });
});

describe('placeLabels', () => {
  const bounds = { x: 0, y: 0, w: 500, h: 500 };
  it('keeps higher priority labels and drops overlapping and blocked ones', () => {
    const placed = placeLabels(
      [
        { id: 'a', x: 10, y: 10, w: 40, h: 12, priority: 1 },
        { id: 'b', x: 30, y: 12, w: 40, h: 12, priority: 2 },
        { id: 'c', x: 200, y: 200, w: 40, h: 12, priority: 0 },
        { id: 'd', x: 490, y: 10, w: 40, h: 12, priority: 5 },
      ],
      [{ x: 190, y: 190, w: 30, h: 30 }],
      bounds,
    );
    expect([...placed]).toEqual(['b']);
  });
});
