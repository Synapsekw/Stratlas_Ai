/** Undo history of one layer's cleanup recipe: whole snapshots, 50 steps back (spec section 2). */
import type { PointcloudCleanup } from '@aio/schema';

export const HISTORY_CAP = 50;
export type Recipe = PointcloudCleanup | null;
export interface History {
  past: Recipe[];
  present: Recipe;
  future: Recipe[];
}

const same = (a: Recipe, b: Recipe) => JSON.stringify(a) === JSON.stringify(b);

export const initial = (present: Recipe): History => ({ past: [], present, future: [] });

export function push(h: History, next: Recipe): History {
  if (same(h.present, next)) return h;
  return { past: [...h.past, h.present].slice(-HISTORY_CAP), present: next, future: [] };
}

export function undo(h: History): History | null {
  if (h.past.length === 0) return null;
  const prev = h.past[h.past.length - 1] ?? null;
  return { past: h.past.slice(0, -1), present: prev, future: [h.present, ...h.future] };
}

export function redo(h: History): History | null {
  if (h.future.length === 0) return null;
  const [next = null, ...rest] = h.future;
  return { past: [...h.past, h.present].slice(-HISTORY_CAP), present: next, future: rest };
}

/** Noise working copies any step names: main must not trash them (`pointcloud:writeCleanup` keep). */
export function referencedCopies(h: History): string[] {
  const out = new Set<string>();
  for (const r of [...h.past, h.present, ...h.future]) if (r?.noise) out.add(r.noise.path);
  return [...out];
}
