/** Chunk selection by camera distance under a global point budget. Pure; no three.js. */

type V3 = readonly [number, number, number];

export interface LodCandidate {
  /** Unique across all clouds in the scene. */
  key: string;
  points: number;
  bounds: { min: V3; max: V3 };
  /** 0 = overview, always loaded. */
  lod: number;
  loaded: boolean;
}

export interface SelectOptions {
  /** Global point budget across every cloud. */
  budget: number;
  /** Chunks whose radius / distance is below this are not worth loading. */
  minScreenRatio?: number;
  /** Loaded chunks stay while the total stays within budget * hysteresis. */
  hysteresis?: number;
}

export interface Selection {
  /** Not yet loaded, wanted, highest priority first. */
  load: string[];
  /** Loaded and no longer wanted. */
  unload: string[];
}

export const DEFAULT_MIN_SCREEN_RATIO = 0.02;
export const DEFAULT_HYSTERESIS = 1.1;

/** Distance from `p` to the box; zero inside. */
export function boxDistance(b: { min: V3; max: V3 }, p: V3): number {
  let s = 0;
  for (let a = 0; a < 3; a++) {
    const lo = b.min[a] ?? 0;
    const hi = b.max[a] ?? 0;
    const v = p[a] ?? 0;
    const d = v < lo ? lo - v : v > hi ? v - hi : 0;
    s += d * d;
  }
  return Math.sqrt(s);
}

/** Roughly the angular size of the chunk: half-diagonal over distance. Lod 0 is Infinity. */
export function chunkPriority(c: LodCandidate, eye: V3): number {
  if (c.lod === 0) return Infinity;
  let diag = 0;
  for (let a = 0; a < 3; a++) {
    const e = (c.bounds.max[a] ?? 0) - (c.bounds.min[a] ?? 0);
    diag += e * e;
  }
  const radius = Math.max(0.5 * Math.sqrt(diag), 1e-3);
  return radius / Math.max(boxDistance(c.bounds, eye), radius * 0.05);
}

/**
 * Greedy selection: highest priority first while the running total stays within the budget.
 * Lod 0 chunks are always wanted. Loaded chunks outside the selection are kept (no churn) while the
 * total stays under budget * hysteresis and they are not tiny; the rest are unloaded.
 */
export function selectChunks(
  candidates: readonly LodCandidate[],
  eye: V3,
  opts: SelectOptions,
): Selection {
  const minRatio = opts.minScreenRatio ?? DEFAULT_MIN_SCREEN_RATIO;
  const hyst = opts.hysteresis ?? DEFAULT_HYSTERESIS;
  const ranked = candidates.map((c) => ({ c, p: chunkPriority(c, eye) })).sort((a, b) => b.p - a.p);
  const wanted = new Set<string>();
  let total = 0;
  for (const { c, p } of ranked) {
    if (c.lod === 0) {
      wanted.add(c.key);
      total += c.points;
    } else if (p >= minRatio && total + c.points <= opts.budget) {
      wanted.add(c.key);
      total += c.points;
    }
  }
  const load: string[] = [];
  const unload: string[] = [];
  for (const { c, p } of ranked) {
    if (wanted.has(c.key)) {
      if (!c.loaded) load.push(c.key);
    } else if (c.loaded) {
      if (p >= minRatio * 0.5 && total + c.points <= opts.budget * hyst) total += c.points;
      else unload.push(c.key);
    }
  }
  return { load, unload };
}
