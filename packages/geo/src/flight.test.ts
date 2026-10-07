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
