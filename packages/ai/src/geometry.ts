import { PoseSample, type Vec3 } from '@aio/schema';
import { z } from 'zod';

/** A flight pose file (docs/architecture/data-conventions.md section 3). */
const FlightFile = z.object({
  startUtcMs: z.number(),
  samples: z.array(PoseSample).min(1),
});
export type FlightFile = z.infer<typeof FlightFile>;

export function parseFlight(json: unknown): FlightFile | null {
  const r = FlightFile.safeParse(json);
  return r.success ? r.data : null;
}

export interface Pass {
  minDistanceM: number;
  /** Project UTC time of the closest approach. */
  closestAtUtcMs: number;
  /** Project UTC [from, to] spans where the drone is within the radius, by sample. */
  ranges: [number, number][];
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * Where a flight passes within `radiusM` of `p`. `startUtcMs` is the project time of pose t = 0
 * (the video layer's flight.startUtcMs). Null when it never comes that close.
 */
export function passNear(
  flight: FlightFile,
  startUtcMs: number,
  p: Vec3,
  radiusM: number,
): Pass | null {
  const s = flight.samples;
  let best = Infinity;
  let bestT = 0;
  const first = s[0];
  if (!first) return null;
  if (s.length === 1) {
    best = Math.sqrt(dot(sub(first.pos, p), sub(first.pos, p)));
    bestT = first.t;
  }
  for (let i = 1; i < s.length; i++) {
    const a = s[i - 1];
    const b = s[i];
    if (!a || !b) continue;
    const ab = sub(b.pos, a.pos);
    const len2 = dot(ab, ab);
    const k = len2 > 0 ? Math.min(1, Math.max(0, dot(sub(p, a.pos), ab) / len2)) : 0;
    const c: Vec3 = [a.pos[0] + ab[0] * k, a.pos[1] + ab[1] * k, a.pos[2] + ab[2] * k];
    const d = Math.sqrt(dot(sub(c, p), sub(c, p)));
    if (d < best) {
      best = d;
      bestT = a.t + (b.t - a.t) * k;
    }
  }
  if (best > radiusM) return null;

  const ranges: [number, number][] = [];
  let open: number | null = null;
  let last = 0;
  for (const sample of s) {
    const inside = Math.sqrt(dot(sub(sample.pos, p), sub(sample.pos, p))) <= radiusM;
    if (inside && open === null) open = sample.t;
    if (!inside && open !== null) {
      ranges.push([startUtcMs + open, startUtcMs + last]);
      open = null;
    }
    last = sample.t;
  }
  if (open !== null) ranges.push([startUtcMs + open, startUtcMs + last]);
  // A pass between two samples that are both outside still counts: report the closest moment.
  if (ranges.length === 0) {
    const t = startUtcMs + Math.round(bestT);
    ranges.push([t, t]);
  }
  return { minDistanceM: best, closestAtUtcMs: startUtcMs + Math.round(bestT), ranges };
}
