import { TILES_BUDGETS, tilesBudget, type TilesBudget, type TilesetHandle } from '@aio/tiles';
import { afterEach, describe, expect, it } from 'vitest';
import { scaledBudget, tilesDebug, trackTileset, untrackTileset } from './siteTiles';

function fakeHandle() {
  let budget: TilesBudget | null = null;
  const h = {
    setBudget: (b: TilesBudget) => {
      budget = b;
    },
    stats: () => ({
      cachedBytes: 7,
      maxBytes: budget?.maxBytes ?? -1,
      errorTarget: budget?.errorTarget ?? -1,
      loadProgress: 1,
    }),
  } as unknown as TilesetHandle;
  return { h, budget: () => budget };
}

describe('the tile budget scale (performance tests)', () => {
  const made: TilesetHandle[] = [];
  afterEach(() => {
    tilesDebug().setBudgetScale(1);
    for (const h of made.splice(0)) untrackTileset(h);
  });

  it('is 1 by default: the budget is the tier budget', () => {
    expect(tilesDebug().budgetScale()).toBe(1);
    expect(scaledBudget('medium')).toEqual(tilesBudget('medium'));
  });

  it('scales the tile cache of the live tilesets, and 1 gives the tier budget back exactly', () => {
    const a = fakeHandle();
    made.push(a.h);
    trackTileset(a.h, 'medium');
    expect(a.budget()).toEqual(tilesBudget('medium'));
    tilesDebug().setBudgetScale(0.01);
    expect(a.budget()).toEqual({
      ...tilesBudget('medium'),
      maxBytes: Math.round(TILES_BUDGETS.medium.maxBytes * 0.01),
    });
    expect(tilesDebug().stats()).toEqual([
      {
        cachedBytes: 7,
        maxBytes: Math.round(TILES_BUDGETS.medium.maxBytes * 0.01),
        errorTarget: TILES_BUDGETS.medium.errorTarget,
        loadProgress: 1,
      },
    ]);
    // a tier change and a new tileset keep the scale
    trackTileset(a.h, 'low');
    expect(a.budget()?.maxBytes).toBe(Math.round(TILES_BUDGETS.low.maxBytes * 0.01));
    const b = fakeHandle();
    made.push(b.h);
    trackTileset(b.h, 'high');
    expect(b.budget()?.maxBytes).toBe(Math.round(TILES_BUDGETS.high.maxBytes * 0.01));
    tilesDebug().setBudgetScale(1);
    expect(a.budget()).toEqual(tilesBudget('low'));
    expect(b.budget()).toEqual(tilesBudget('high'));
  });

  it('keeps the scale within (0, 1] and drops disposed tilesets', () => {
    tilesDebug().setBudgetScale(5);
    expect(tilesDebug().budgetScale()).toBe(1);
    tilesDebug().setBudgetScale(0);
    expect(tilesDebug().budgetScale()).toBeGreaterThan(0);
    expect(scaledBudget('medium').maxBytes).toBeGreaterThanOrEqual(1);
    const a = fakeHandle();
    trackTileset(a.h, 'medium');
    untrackTileset(a.h);
    expect(tilesDebug().stats()).toEqual([]);
  });
});
