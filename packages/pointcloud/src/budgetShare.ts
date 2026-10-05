/**
 * The point budget (Settings, graphics tier) is for the whole app. When two 3D views draw clouds
 * at once (two survey dates side by side), each gets a share so the total stays within it.
 */

interface Renderable {
  requestRender(): void;
}

const shares = new WeakMap<object, number>();

/** This scene's share of the point budget, 0 to 1 (default 1: the only view). */
export function budgetShareOf(handle: object): number {
  return shares.get(handle) ?? 1;
}

/** Give a scene a share of the point budget (1 again when it is the only view left). */
export function setBudgetShare(handle: Renderable, share: number): void {
  const s = Number.isFinite(share) ? Math.min(1, Math.max(0, share)) : 1;
  if (shares.get(handle) === s) return;
  if (s === 1) shares.delete(handle);
  else shares.set(handle, s);
  handle.requestRender();
}

/**
 * Split `total` points between views in proportion to their weights (drawn pixels), each view
 * getting at least `min` of an equal share; the parts never add up to more than `total`.
 */
export function splitBudget(total: number, weights: readonly number[], min = 0.5): number[] {
  const n = weights.length;
  if (n === 0) return [];
  const w = weights.map((x) => (Number.isFinite(x) && x > 0 ? x : 0));
  const sum = w.reduce((a, b) => a + b, 0);
  const floor = (min / n) * total;
  if (sum <= 0) return w.map(() => Math.floor(total / n));
  // proportional parts, then lift the small ones to the floor and take it from the large ones
  let parts = w.map((x) => (x / sum) * total);
  const low = parts.map((p) => p < floor);
  if (low.some(Boolean)) {
    const lifted = low.filter(Boolean).length * floor;
    const restW = w.reduce((a, x, i) => (low[i] ? a : a + x), 0);
    parts = parts.map((p, i) =>
      low[i] ? floor : restW > 0 ? ((w[i] ?? 0) / restW) * (total - lifted) : p,
    );
  }
  return parts.map((p) => Math.floor(p));
}
