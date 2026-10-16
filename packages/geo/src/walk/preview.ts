// packages/geo/src/walk/preview.ts
import type { WalkRawPath } from '@aio/schema';
import { levelStills, type XZ } from './horizontal';
import { applySim2, sim2Between } from './similarity2';

/*
 * The walk's shape while it is being placed (design "Walk placing by start and end"): pure
 * helpers over the levelled raw path. Before the start click a ghost of the whole shape follows
 * the cursor; between the clicks the shape is laid between the start and the cursor by the same
 * two point similarity the fit uses. The saved placement is always `fitWalk`.
 */

/** Metres per step the ghost is drawn at before the start is set. */
export const GHOST_M_PER_STEP = 0.7;
/** The ghost's length when the raw path counts no steps, metres. */
export const GHOST_FALLBACK_M = 30;

/** One reconstruction of the levelled raw path, registered stills only, sorted by time. */
export interface WalkOutline {
  t: number[];
  xz: XZ[];
  steps: number[];
}

/**
 * The shape to preview: the registered stills of the reconstruction with the most of them,
 * inside the walking part when the raw path names one (all of them when fewer than two lie
 * inside). Null without a raw path, for a pins-only one, or with fewer than two stills.
 */
export function walkOutline(raw: WalkRawPath | null): WalkOutline | null {
  if (!raw || raw.source === 'pins-only') return null;
  const stills = levelStills(raw).flatMap((s) =>
    s.xz ? [{ t: s.t, xz: s.xz, steps: s.steps, segment: s.segment ?? 0 }] : [],
  );
  const count = new Map<number, number>();
  for (const s of stills) count.set(s.segment, (count.get(s.segment) ?? 0) + 1);
  let best = 0;
  let most = 0;
  for (const [segment, n] of count)
    if (n > most) {
      best = segment;
      most = n;
    }
  const own = stills.filter((s) => s.segment === best);
  const from = raw.walking?.startT ?? -Infinity;
  const to = raw.walking?.endT ?? Infinity;
  const inside = own.filter((s) => s.t >= from && s.t <= to);
  const kept = inside.length >= 2 ? inside : own;
  if (kept.length < 2) return null;
  return { t: kept.map((s) => s.t), xz: kept.map((s) => s.xz), steps: kept.map((s) => s.steps) };
}

/** The outline at time t, interpolated, clamped to its first and last still. */
export function outlineAt(o: WalkOutline, t: number): XZ {
  const first = o.xz[0] ?? [0, 0];
  const last = o.xz.at(-1) ?? first;
  if (!(t > (o.t[0] ?? 0))) return first;
  if (t >= (o.t.at(-1) ?? 0)) return last;
  let i = 0;
  while (i + 1 < o.t.length && (o.t[i + 1] ?? Infinity) <= t) i++;
  const a = o.xz[i] ?? first;
  const b = o.xz[i + 1] ?? a;
  const ta = o.t[i] ?? 0;
  const tb = o.t[i + 1] ?? ta;
  const f = tb > ta ? (t - ta) / (tb - ta) : 0;
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
}

/**
 * The shape laid between `start` (where the outline is at `startT`) and `cursor` (where it is at
 * `endT`): rotated, scaled and moved, every point. Null when the outline's two anchors coincide.
 */
export function previewPath(
  o: WalkOutline,
  startT: number,
  endT: number,
  start: XZ,
  cursor: XZ,
): XZ[] | null {
  const m = sim2Between(outlineAt(o, startT), outlineAt(o, endT), start, cursor);
  return m ? o.xz.map((p) => applySim2(m, p)) : null;
}

/** The ghost's length: the steps walked times `metresPerStep`, or a fixed length without steps. */
export function ghostLengthM(o: WalkOutline, metresPerStep = GHOST_M_PER_STEP): number {
  const steps = (o.steps.at(-1) ?? 0) - (o.steps[0] ?? 0);
  return steps > 0 ? steps * metresPerStep : GHOST_FALLBACK_M;
}

/**
 * The shape as the raw path heads, its first point at `cursor`, scaled so it runs `lengthM`
 * along itself. Null when the length or the outline's own length is not positive.
 */
export function ghostPath(o: WalkOutline, cursor: XZ, lengthM: number): XZ[] | null {
  let own = 0;
  for (let i = 1; i < o.xz.length; i++) {
    const a = o.xz[i - 1];
    const b = o.xz[i];
    if (a && b) own += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  if (!(own > 1e-9) || !(lengthM > 0) || !Number.isFinite(lengthM)) return null;
  const s = lengthM / own;
  const [x0, z0] = o.xz[0] ?? [0, 0];
  return o.xz.map(([x, z]) => [cursor[0] + (x - x0) * s, cursor[1] + (z - z0) * s]);
}
