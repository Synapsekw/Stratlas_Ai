/**
 * The AI cut and fill breakdown (M11 G12, SAI-2, decision 4): the whole-site comparison's draft
 * regions stay rule-based (`draftRegions`, cells that changed by more than the deadband); the
 * local model only snaps a region's boundary to the edge seen in the ortho. A snapped boundary is
 * taken only when it agrees with the region it came from (their overlap over their union is at
 * least `MIN_AGREEMENT`), otherwise the rule-based boundary stays. Everything is still a draft.
 *
 * Plain geometry, no model: the caller passes `outline`, which asks the model.
 */
import type { CropWindow } from './orthoCrop';

export type Ring = readonly (readonly [number, number])[];

/** A snapped boundary replaces the region's own only when they overlap at least this much. */
export const MIN_AGREEMENT = 0.5;
/** The crop is this many times the region's larger side, between the limits, metres. */
const CROP_FACTOR = 2;
const CROP_MIN_M = 20;
const CROP_MAX_M = 480;

export function ringBounds(ring: Ring): [number, number, number, number] {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of ring) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return [x0, y0, x1, y1];
}

/** Even-odd point in polygon. */
export function inRing(ring: Ring, x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (!a || !b) continue;
    if (a[1] > y !== b[1] > y && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0])
      inside = !inside;
  }
  return inside;
}

/**
 * A point well inside a ring: of an `n` x `n` grid over its bounds, the inside cell centre
 * farthest from the boundary (a click there tells the model which object is meant). Null for a
 * ring with no inside cell.
 */
export function interiorPoint(ring: Ring, n = 24): [number, number] | null {
  const [x0, y0, x1, y1] = ringBounds(ring);
  if (!(x1 > x0 && y1 > y0)) return null;
  let best: [number, number] | null = null;
  let bestD = -1;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = x0 + ((i + 0.5) / n) * (x1 - x0);
      const y = y0 + ((j + 0.5) / n) * (y1 - y0);
      if (!inRing(ring, x, y)) continue;
      let d = Infinity;
      for (let k = 0; k < ring.length; k++) {
        const a = ring[k];
        const b = ring[(k + 1) % ring.length];
        if (!a || !b) continue;
        const dx = b[0] - a[0];
        const dy = b[1] - a[1];
        const len2 = dx * dx + dy * dy;
        const t = len2 ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / len2)) : 0;
        d = Math.min(d, Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy));
      }
      if (d > bestD) {
        bestD = d;
        best = [x, y];
      }
    }
  }
  return best;
}

/** Overlap over union of two rings, sampled on an `n` x `n` grid over both. */
export function ringIou(a: Ring, b: Ring, n = 96): number {
  const ba = ringBounds(a);
  const bb = ringBounds(b);
  const x0 = Math.min(ba[0], bb[0]);
  const y0 = Math.min(ba[1], bb[1]);
  const x1 = Math.max(ba[2], bb[2]);
  const y1 = Math.max(ba[3], bb[3]);
  let both = 0;
  let either = 0;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = x0 + ((i + 0.5) / n) * (x1 - x0);
      const y = y0 + ((j + 0.5) / n) * (y1 - y0);
      const p = inRing(a, x, y);
      const q = inRing(b, x, y);
      if (p && q) both++;
      if (p || q) either++;
    }
  }
  return either ? both / either : 0;
}

/** The crop for a region: square, centred on its bounds, twice its larger side. */
export function regionWindow(ring: Ring, size = 1024): CropWindow {
  const [x0, y0, x1, y1] = ringBounds(ring);
  const side = Math.min(CROP_MAX_M, Math.max(CROP_MIN_M, CROP_FACTOR * Math.max(x1 - x0, y1 - y0)));
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  return { x0: cx - side / 2, y1: cy + side / 2, res: side / size, size };
}

export interface SnapOutcome {
  ring: [number, number][];
  snapped: boolean;
  /** Why the region kept its own boundary. */
  reason?: string;
  /** Overlap over union of the model's outline and the region, when there was an outline. */
  agreement?: number;
}

/** Asks the model for the outline at `click` within `window`: the ring, or why there is none. */
export type Outline = (
  click: [number, number],
  window: CropWindow,
) => Promise<
  { ok: true; ring: [number, number][]; touchesEdge: boolean } | { ok: false; error: string }
>;

/** One region's boundary snapped to the ortho, or kept with the reason. */
export async function snapRegion(ring: Ring, outline: Outline): Promise<SnapOutcome> {
  const own = ring.map(([x, y]) => [x, y] as [number, number]);
  const click = interiorPoint(ring);
  if (!click) return { ring: own, snapped: false, reason: 'The region is too thin to snap.' };
  const r = await outline(click, regionWindow(ring));
  if (!r.ok) return { ring: own, snapped: false, reason: r.error };
  if (r.touchesEdge) {
    return { ring: own, snapped: false, reason: 'The ortho shows no edge around this region.' };
  }
  const agreement = ringIou(ring, r.ring);
  if (agreement < MIN_AGREEMENT) {
    return {
      ring: own,
      snapped: false,
      agreement,
      reason: 'The edge in the ortho does not match this region.',
    };
  }
  return { ring: r.ring, snapped: true, agreement };
}
