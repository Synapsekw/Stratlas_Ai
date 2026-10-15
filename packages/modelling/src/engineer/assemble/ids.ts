/**
 * Stable assembly ids: `<role>-<index>`, index 1-based in a deterministic order (compass azimuth
 * clockwise from north, then height). On regeneration the new items are matched to the previous
 * ones of the role, which keep their ids; items that match none get the next ids after every
 * previous one, so a raised count adds ids at the end and never renumbers what was there.
 */

/** A thing to number: its compass azimuth round its host (degrees) and its height. */
export interface IdItem {
  azimuthDeg?: number | undefined;
  y?: number | undefined;
}

/** Compass bearing in degrees of the plan offset `(x, z)`: 0 north (-z), 90 east (+x). */
export function azimuthDeg(x: number, z: number): number {
  const d = (Math.atan2(x, -z) * 180) / Math.PI;
  const a = ((d % 360) + 360) % 360;
  return a >= 360 - 1e-9 ? 0 : a + 0; // + 0 turns -0 into 0
}

/** Unsigned angle between two bearings, 0 to 180. */
export function angleBetween(a: number, b: number): number {
  const d = Math.abs((((a - b) % 360) + 360) % 360);
  return Math.min(d, 360 - d);
}

const EPS = 1e-6;

function compare(a: IdItem, b: IdItem): number {
  const da = (a.azimuthDeg ?? 0) - (b.azimuthDeg ?? 0);
  if (Math.abs(da) > EPS) return da;
  const dy = (a.y ?? 0) - (b.y ?? 0);
  return Math.abs(dy) > EPS ? dy : 0;
}

/** The index of `id` when it is `<role>-<n>`, else undefined. */
export function indexInRole(role: string, id: string): number | undefined {
  if (!id.startsWith(`${role}-`)) return undefined;
  const rest = id.slice(role.length + 1);
  return /^[1-9][0-9]*$/.test(rest) ? Number(rest) : undefined;
}

/**
 * Ids for `items` (in their input order). Without `previous`, `<role>-1..n` in azimuth then height
 * order. With it, each item is paired with the nearest previous one of the role (by azimuth when
 * both have one, within half the spacing of the denser set; else by height) and keeps its id; the
 * rest are numbered after the highest previous index, in azimuth then height order.
 */
export function assignIds(
  role: string,
  items: readonly IdItem[],
  previous: readonly (IdItem & { id: string })[] = [],
): string[] {
  const order = items
    .map((_, i) => i)
    .sort((a, b) => {
      const ia = items[a];
      const ib = items[b];
      return ia && ib ? compare(ia, ib) || a - b : 0;
    });
  const prev = previous.flatMap((p) => {
    const n = indexInRole(role, p.id);
    return n === undefined ? [] : [{ ...p, n }];
  });
  const out: (string | undefined)[] = items.map(() => undefined);
  if (prev.length) {
    const tol = 180 / Math.max(items.length, prev.length) + EPS;
    const pairs: { i: number; j: number; d: number }[] = [];
    items.forEach((it, i) => {
      prev.forEach((p, j) => {
        if (it.azimuthDeg !== undefined && p.azimuthDeg !== undefined) {
          const d = angleBetween(it.azimuthDeg, p.azimuthDeg);
          if (d <= tol) pairs.push({ i, j, d });
        } else pairs.push({ i, j, d: Math.abs((it.y ?? 0) - (p.y ?? 0)) });
      });
    });
    pairs.sort((a, b) => a.d - b.d || a.j - b.j || a.i - b.i);
    const usedJ = new Set<number>();
    for (const { i, j } of pairs) {
      const p = prev[j];
      if (!p || out[i] !== undefined || usedJ.has(j)) continue;
      usedJ.add(j);
      out[i] = `${role}-${String(p.n)}`;
    }
  }
  let next = prev.reduce((m, p) => Math.max(m, p.n), 0);
  for (const i of order) out[i] ??= `${role}-${String(++next)}`;
  return out.map((id) => id ?? role);
}
