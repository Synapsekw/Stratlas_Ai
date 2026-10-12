import type { Layer, PanoRef, Vec3 } from '@aio/schema';
import type { CaptureIndex } from '@aio/workspace';

/**
 * Panoramas of two survey dates side by side (timeline T3): the panoramas of a date, the one of
 * another date nearest on the ground, stepping on the leading side. Pure; the pane is PanoPane.tsx.
 */
export interface PanoAt {
  layer: string;
  pano: PanoRef;
}
/** Farthest two panoramas may stand apart and still count as the same spot, metres. */
export const PAIR_MAX_M = 25;
export const panoKey = (a: PanoAt): string => `${a.layer}/${a.pano.id}`;

export function panosOf(
  layers: readonly Layer[],
  index: CaptureIndex | null,
  capture: string | undefined,
): PanoAt[] {
  const out: PanoAt[] = [];
  for (const l of layers) {
    if (l.kind !== 'panoramas') continue;
    const of = index?.of[l.id];
    if (capture !== undefined && of !== undefined && of !== capture) continue;
    for (const pano of l.items) out.push({ layer: l.id, pano });
  }
  return out;
}

export function findPano(list: readonly PanoAt[], key: string | undefined): PanoAt | undefined {
  return key === undefined ? undefined : list.find((a) => panoKey(a) === key);
}

export function groundDistance(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[2] - b[2]);
}

export interface PanoPair {
  at: PanoAt;
  distanceM: number;
  within: boolean;
}

export function pairPano(
  from: PanoRef,
  candidates: readonly PanoAt[],
  maxM = PAIR_MAX_M,
): PanoPair | null {
  let best: PanoPair | null = null;
  for (const at of candidates) {
    const d = groundDistance(from.pos, at.pano.pos);
    if (!best || d < best.distanceM) best = { at, distanceM: d, within: d <= maxM };
  }
  return best;
}

export function stepPano(
  list: readonly PanoAt[],
  key: string | undefined,
  dir: 1 | -1,
): PanoAt | undefined {
  const n = list.length;
  if (n === 0) return undefined;
  const i = list.findIndex((a) => panoKey(a) === key);
  if (i < 0) return list[0];
  return list[(((i + dir) % n) + n) % n];
}

export function followPano(prev: PanoRef | undefined, next: readonly PanoAt[]): PanoAt | undefined {
  if (!prev) return next[0];
  return pairPano(prev, next, Infinity)?.at;
}
