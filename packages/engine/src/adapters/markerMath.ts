/** Screen-space grouping of scene markers (photos, panoramas): one icon per place. */

/** A marker site on screen: `i` is the caller's site index, `n` its member count. */
export interface ScreenSite {
  i: number;
  x: number;
  y: number;
  n: number;
}

export interface SiteCluster {
  /** Caller site indices. */
  sites: number[];
  /** Members over all its sites. */
  count: number;
  /** Screen position: the seed site (the one with most members), so the icon stays put. */
  x: number;
  y: number;
}

/**
 * Greedy radius clustering in screen space: the free site with the most members seeds a cluster
 * and takes every free site within `radius` pixels. A spatial hash keeps it near linear.
 */
export function clusterSites(sites: readonly ScreenSite[], radius: number): SiteCluster[] {
  const cell = Math.max(1, radius);
  const grid = new Map<number, number[]>();
  const key = (cx: number, cy: number) => cx * 73856093 + cy * 19349663;
  sites.forEach((s, k) => {
    const id = key(Math.floor(s.x / cell), Math.floor(s.y / cell));
    const b = grid.get(id);
    if (b) b.push(k);
    else grid.set(id, [k]);
  });
  const order = sites
    .map((_, k) => k)
    .sort((a, b) => (sites[b]?.n ?? 0) - (sites[a]?.n ?? 0) || a - b);
  const taken = new Uint8Array(sites.length);
  const r2 = radius * radius;
  const out: SiteCluster[] = [];
  for (const k of order) {
    const seed = sites[k];
    if (!seed || taken[k]) continue;
    taken[k] = 1;
    const c: SiteCluster = { sites: [seed.i], count: seed.n, x: seed.x, y: seed.y };
    const cx = Math.floor(seed.x / cell);
    const cy = Math.floor(seed.y / cell);
    for (let gx = cx - 1; gx <= cx + 1; gx++)
      for (let gy = cy - 1; gy <= cy + 1; gy++)
        for (const j of grid.get(key(gx, gy)) ?? []) {
          const q = sites[j];
          if (!q || taken[j]) continue;
          const dx = q.x - seed.x;
          const dy = q.y - seed.y;
          if (dx * dx + dy * dy > r2) continue;
          taken[j] = 1;
          c.sites.push(q.i);
          c.count += q.n;
        }
    out.push(c);
  }
  return out;
}

/** The cluster under a pointer: nearest centre within `hitRadius` pixels, or -1. */
export function hitCluster(
  clusters: readonly SiteCluster[],
  x: number,
  y: number,
  hitRadius: number,
): number {
  let best = -1;
  let bestD = hitRadius * hitRadius;
  clusters.forEach((c, k) => {
    const d = (c.x - x) ** 2 + (c.y - y) ** 2;
    if (d <= bestD) {
      bestD = d;
      best = k;
    }
  });
  return best;
}

/**
 * The time span of photos taken at a place, from their `takenAt` (ISO 8601, written in the
 * camera's own zone): `10:30:48` for one time, `[from, to]` times of day when they share a date,
 * else dates with hours and minutes. Null without times.
 */
export function timeSpan(times: readonly (string | undefined)[]): [string, string] | string | null {
  const ok = times
    .filter((t): t is string => typeof t === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(t))
    .sort();
  const first = ok[0];
  const last = ok[ok.length - 1];
  if (!first || !last) return null;
  const tod = (t: string) => t.slice(11, 19);
  if (first.slice(0, 19) === last.slice(0, 19)) return tod(first);
  if (first.slice(0, 10) === last.slice(0, 10)) return [tod(first), tod(last)];
  const dt = (t: string) => `${t.slice(0, 10)} ${t.slice(11, 16)}`;
  return [dt(first), dt(last)];
}
