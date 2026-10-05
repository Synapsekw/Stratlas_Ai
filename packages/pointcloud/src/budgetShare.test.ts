import { describe, expect, it, vi } from 'vitest';
import { budgetShareOf, setBudgetShare, splitBudget } from './budgetShare';

describe('point budget split between two 3D views', () => {
  it('halves the budget for two views of the same size', () => {
    expect(splitBudget(8_000_000, [1000 * 800, 1000 * 800])).toEqual([4_000_000, 4_000_000]);
  });

  it('follows the drawn pixels and never exceeds the total', () => {
    const [a = 0, b = 0] = splitBudget(6_000_000, [3, 1]);
    expect(a).toBe(4_500_000);
    expect(b).toBe(1_500_000);
    for (const w of [
      [1, 1],
      [5, 1],
      [1, 0],
      [0.2, 7],
      [1, 2, 3],
    ]) {
      const parts = splitBudget(16_000_000, w);
      expect(parts.reduce((x, y) => x + y, 0)).toBeLessThanOrEqual(16_000_000);
    }
  });

  it('keeps a floor for a small view (a quarter of the total for two views)', () => {
    const [big = 0, small = 0] = splitBudget(4_000_000, [99, 1]);
    expect(small).toBe(1_000_000);
    expect(big).toBe(3_000_000);
    expect(splitBudget(2_000_000, [0, 0])).toEqual([1_000_000, 1_000_000]);
    expect(splitBudget(2_000_000, [])).toEqual([]);
  });

  it('keeps each scene share and asks for a redraw when it changes', () => {
    const a = { requestRender: vi.fn() };
    expect(budgetShareOf(a)).toBe(1);
    setBudgetShare(a, 0.5);
    expect(budgetShareOf(a)).toBe(0.5);
    setBudgetShare(a, 0.5);
    expect(a.requestRender).toHaveBeenCalledTimes(1);
    setBudgetShare(a, 7);
    expect(budgetShareOf(a)).toBe(1);
    setBudgetShare(a, Number.NaN);
    expect(budgetShareOf(a)).toBe(1);
  });
});
