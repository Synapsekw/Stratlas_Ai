import type { PoseSample, Quat, Vec3 } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { cameraQuatFromGimbal } from './camera';
import { estimateHeadings, looksEstimated, normaliseFlight, smoothHeldPositions } from './flight';

const FRAME = 1000 / 60;
const FIX = 200;

/** A 60 Hz log of `truth` whose position only updates every 200 ms (consumer DJI SRT). */
function stairs(truth: (tMs: number) => Vec3, durationMs: number): { t: number[]; pos: Vec3[] } {
  const t: number[] = [];
  const pos: Vec3[] = [];
  for (let i = 0; i * FRAME <= durationMs; i++) {
    const ti = Math.round(i * FRAME);
    t.push(ti);
    pos.push(truth(Math.floor(ti / FIX) * FIX));
  }
  return { t, pos };
}

/** Heading of a camera quaternion, degrees clockwise from north. */
function heading([x, y, z, w]: Quat): number {
  // forward = q * (0, 0, -1)
  const fx = -2 * (x * z + w * y);
  const fz = -(1 - 2 * (x * x + y * y));
  return ((Math.atan2(fx, -fz) * 180) / Math.PI + 360) % 360;
}

/** The first importer's heading: north until the aircraft moved, then the raw 1 s track. */
function legacyHeadings(pos: readonly Vec3[], t: readonly number[]): number[] {
  const out: number[] = [];
  let last = 0;
  let lo = 0;
  let hi = 0;
  for (let i = 0; i < pos.length; i++) {
    const ti = t[i] ?? 0;
    while ((t[lo] ?? 0) < ti - 1000) lo++;
    while (hi + 1 < pos.length && (t[hi + 1] ?? 0) <= ti + 1000) hi++;
    const a = pos[lo] ?? [0, 0, 0];
    const b = pos[hi] ?? [0, 0, 0];
    if (Math.hypot(b[0] - a[0], b[2] - a[2]) > 0.3)
      last = (Math.atan2(b[0] - a[0], -(b[2] - a[2])) * 180) / Math.PI;
    out.push(last);
  }
  return out;
}

/** Angle between two headings, degrees. */
const gap = (a: number, b: number) => Math.abs(((((a - b) % 360) + 540) % 360) - 180);

/** East at 5 m/s, 40 m up, after hovering for `hoverMs`. */
const eastAfter =
  (hoverMs: number) =>
  (tMs: number): Vec3 => [Math.max(0, tMs - hoverMs) * 0.005, 40, 0];

describe('smoothHeldPositions', () => {
  it('turns a stair-stepped track into a smooth one through the fixes', () => {
    const truth = eastAfter(0);
    const { t, pos } = stairs(truth, 6000);
    const out = smoothHeldPositions(t, pos);
    expect(out).not.toBeNull();
    let maxErr = 0;
    out?.forEach((p, i) => {
      maxErr = Math.max(maxErr, Math.abs(p[0] - truth(t[i] ?? 0)[0]));
      if (i > 0) expect(p[0]).toBeGreaterThanOrEqual((out[i - 1]?.[0] ?? 0) - 1e-9);
    });
    // the raw log is up to one fix (1 m) behind; the curve stays within centimetres
    expect(maxErr).toBeLessThan(0.05);
    // through the fixes
    const at = t.indexOf(2000);
    expect(out?.[at]?.[0]).toBeCloseTo(10, 6);
  });

  it('holds a hover until one fix before the aircraft moves on', () => {
    const { t, pos } = stairs(eastAfter(3000), 6000);
    const out = smoothHeldPositions(t, pos) ?? [];
    t.forEach((ti, i) => {
      if (ti <= 3000 - FIX) expect(out[i]?.[0]).toBe(0);
    });
    expect(out[t.findIndex((ti) => ti >= 3500)]?.[0]).toBeGreaterThan(1);
  });

  it('leaves high-rate telemetry alone', () => {
    const t = Array.from({ length: 300 }, (_, i) => Math.round(i * FRAME));
    const pos = t.map((ti): Vec3 => [ti * 0.005, 40, 0]);
    expect(smoothHeldPositions(t, pos)).toBeNull();
  });
});

describe('estimateHeadings', () => {
  it('backfills the samples before the first movement with the first heading', () => {
    const { t, pos } = stairs(eastAfter(2000), 6000);
    const h = estimateHeadings(t, smoothHeldPositions(t, pos) ?? pos) ?? [];
    expect(h[0]).toBeCloseTo(90, 3);
    expect(h.at(-1)).toBeCloseTo(90, 3);
  });

  it('turns smoothly through a sharp corner', () => {
    // east for 4 s, then north
    const truth = (tMs: number): Vec3 =>
      tMs < 4000 ? [tMs * 0.005, 40, 0] : [20, 40, -(tMs - 4000) * 0.005];
    const { t, pos } = stairs(truth, 8000);
    const h = estimateHeadings(t, smoothHeldPositions(t, pos) ?? pos) ?? [];
    let maxStep = 0;
    for (let i = 1; i < h.length; i++) maxStep = Math.max(maxStep, gap(h[i] ?? 0, h[i - 1] ?? 0));
    expect(maxStep).toBeLessThan(2.5);
    expect(h[0]).toBeCloseTo(90, 1);
    expect(gap(h.at(-1) ?? 0, 0)).toBeLessThan(0.1);
  });

  it('gives no heading when the aircraft never moves', () => {
    const t = [0, 100, 200, 300];
    const pos: Vec3[] = t.map(() => [0, 40, 0]);
    expect(estimateHeadings(t, pos)).toBeNull();
  });
});

describe('normaliseFlight', () => {
  /** A file the first SRT importer wrote: held positions, raw track heading, pitch -30. */
  function legacyFile(): PoseSample[] {
    const { t, pos } = stairs(eastAfter(1500), 5000);
    const h = legacyHeadings(pos, t);
    return t.map((ti, i) => ({
      t: ti,
      pos: pos[i] ?? [0, 0, 0],
      q: cameraQuatFromGimbal(h[i] ?? 0, -30, 0),
    }));
  }

  it('smooths an estimated file: no north start, smooth positions, the pitch kept', () => {
    const file = legacyFile();
    expect(heading(file[0]?.q ?? [0, 0, 0, 1])).toBeCloseTo(0, 3);
    expect(looksEstimated(file)).toBe(true);
    const n = normaliseFlight(file);
    expect(n.positions).toBe(true);
    expect(n.heading).toBe(true);
    expect(n.samples).toHaveLength(file.length);
    expect(heading(n.samples[0]?.q ?? [0, 0, 0, 1])).toBeCloseTo(90, 1);
    expect(looksEstimated(n.samples)).toBe(true);
    // same times, the file object untouched
    expect(n.samples.map((s) => s.t)).toEqual(file.map((s) => s.t));
    expect(file[0]?.q).toEqual(cameraQuatFromGimbal(0, -30, 0));
  });

  it('is idempotent: a cleaned log comes back unchanged', () => {
    const once = normaliseFlight(legacyFile()).samples;
    const twice = normaliseFlight(once);
    expect(twice.heading).toBe(false);
    twice.samples.forEach((s, i) => {
      expect(s.q).toEqual(once[i]?.q);
      s.pos.forEach((v, k) => {
        expect(v).toBeCloseTo(once[i]?.pos[k] ?? 0, 3);
      });
    });
  });

  it('keeps gimbal orientations and smooths only their positions', () => {
    const { t, pos } = stairs(eastAfter(0), 3000);
    const q = cameraQuatFromGimbal(37, -45, 0);
    const file = t.map((ti, i) => ({
      t: ti,
      pos: pos[i] ?? ([0, 0, 0] as Vec3),
      q,
      gimbal: { yaw: 37, pitch: -45, roll: 0 },
    }));
    const n = normaliseFlight(file);
    expect(n.heading).toBe(false);
    expect(n.positions).toBe(true);
    for (const s of n.samples) expect(s.q).toBe(q);
  });

  it('keeps measured orientations (roll, changing pitch) without gimbal angles', () => {
    const { t, pos } = stairs(eastAfter(0), 3000);
    const file = t.map((ti, i) => ({
      t: ti,
      pos: pos[i] ?? ([0, 0, 0] as Vec3),
      q: cameraQuatFromGimbal(10, -40 + i * 0.1, 3),
    }));
    expect(looksEstimated(file)).toBe(false);
    const n = normaliseFlight(file);
    expect(n.heading).toBe(false);
    n.samples.forEach((s, i) => {
      expect(s.q).toBe(file[i]?.q);
    });
  });

  /**
   * A drone flying a straight 40 degree course at 2.5 m/s, its SRT position rounded to five
   * decimals of a degree (1.11 m north, 0.97 m east): latitude and longitude step at different
   * moments, so the log is a staircase, not a line.
   */
  const COURSE = 40;
  const SPEED = 2.5;
  function gridStairs(durationMs: number): { t: number[]; pos: Vec3[] } {
    const s = Math.sin((COURSE * Math.PI) / 180);
    const c = Math.cos((COURSE * Math.PI) / 180);
    const t: number[] = [];
    const pos: Vec3[] = [];
    for (let i = 0; i * FRAME <= durationMs; i++) {
      const ti = Math.round(i * FRAME);
      const d = (Math.floor(ti / 100) * 100 * SPEED) / 1000;
      t.push(ti);
      pos.push([
        Math.round((d * s + 0.3) / 0.97) * 0.97,
        50,
        -Math.round((d * c + 0.2) / 1.11) * 1.11,
      ]);
    }
    return { t, pos };
  }

  /** Direction of travel over 200 ms spans, from 3 s in to 3 s before the end. */
  function shortDirections(samples: readonly PoseSample[]): number[] {
    const out: number[] = [];
    const end = samples.at(-1)?.t ?? 0;
    for (let i = 0; i < samples.length; i += 3) {
      const a = samples[i];
      const b = samples.find((x) => x.t >= (a?.t ?? 0) + 200);
      if (!a || !b || a.t < 3000 || b.t > end - 3000) continue;
      out.push(
        ((Math.atan2(b.pos[0] - a.pos[0], -(b.pos[2] - a.pos[2])) * 180) / Math.PI + 360) % 360,
      );
    }
    return out;
  }

  /** What the second importer wrote: positions splined through every fix, the 1 s track heading. */
  function splinedFile(): PoseSample[] {
    const { t, pos } = gridStairs(20000);
    const p = smoothHeldPositions(t, pos) ?? pos;
    const h = estimateHeadings(t, p, { windowMs: 1000, smoothMs: 1500 }) ?? [];
    return t.map((ti, i) => ({
      t: ti,
      pos: p[i] ?? [0, 0, 0],
      q: cameraQuatFromGimbal(h[i] ?? 0, -30, 0),
    }));
  }

  it('straightens a grid-rounded staircase into the course flown', () => {
    const { t, pos } = gridStairs(20000);
    const file = t.map((ti, i) => ({
      t: ti,
      pos: pos[i] ?? ([0, 0, 0] as Vec3),
      q: cameraQuatFromGimbal(COURSE, -30, 0),
    }));
    const n = normaliseFlight(file);
    const dirs = shortDirections(n.samples);
    expect(dirs.length).toBeGreaterThan(50);
    for (const d of dirs) expect(gap(d, COURSE)).toBeLessThan(15);
  });

  it('re-estimates the heading of an already splined file and straightens its path', () => {
    const file = splinedFile();
    // the stored estimate wobbles with the staircase
    const before = file
      .filter((s) => s.t > 3000 && s.t < 17000)
      .map((s) => gap(heading(s.q), COURSE));
    expect(Math.max(...before)).toBeGreaterThan(3);
    const n = normaliseFlight(file);
    expect(n.heading).toBe(true);
    expect(n.positions).toBe(true);
    // what is left is a slow drift where the course beats against the grid, no back and forth
    const mid = n.samples.filter((s) => s.t > 3000 && s.t < 17000);
    for (const s of mid) expect(gap(heading(s.q), COURSE)).toBeLessThan(3);
    for (let i = 30; i < mid.length; i++)
      expect(
        gap(heading(mid[i]?.q ?? [0, 0, 0, 1]), heading(mid[i - 30]?.q ?? [0, 0, 0, 1])),
      ).toBeLessThan(0.6);
    for (const d of shortDirections(n.samples)) expect(gap(d, COURSE)).toBeLessThan(15);
    // and a second pass leaves it alone
    const twice = normaliseFlight(n.samples);
    expect(twice.heading).toBe(false);
    expect(twice.positions).toBe(false);
  });

  it('keeps a hover still when straightening a staircase', () => {
    const { t, pos } = gridStairs(12000);
    // hover 3 s at the start, then fly the staircase
    const shift = Math.round(3000 / FRAME);
    const tt = [...t.slice(0, shift), ...t.map((v) => v + (t[shift] ?? 0))];
    const pp = [...t.slice(0, shift).map(() => pos[0] ?? ([0, 0, 0] as Vec3)), ...pos];
    const file = tt.map((ti, i) => ({
      t: ti,
      pos: pp[i] ?? ([0, 0, 0] as Vec3),
      q: cameraQuatFromGimbal(COURSE, -30, 0),
    }));
    const n = normaliseFlight(file);
    n.samples.forEach((s) => {
      if (s.t <= 2500)
        s.pos.forEach((v, k) => {
          expect(v).toBeCloseTo(pp[0]?.[k] ?? 0, 6);
        });
    });
  });

  it('returns the very same samples for high-rate measured logs', () => {
    const file = Array.from({ length: 200 }, (_, i) => ({
      t: i * 100,
      pos: [i, 30, -i] as Vec3,
      q: cameraQuatFromGimbal(i, -50, 2),
    }));
    const n = normaliseFlight(file);
    expect(n.samples).toBe(file);
    expect(n.positions || n.heading).toBe(false);
  });
});
