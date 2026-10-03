import { describe, expect, it } from 'vitest';
import { BUDGETS, DEFAULT_BUDGET, createPointcloudSettings } from './settings';

function memory(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => {
      m.clear();
    },
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => m.delete(k),
    setItem: (k, v) => m.set(k, v),
  };
}

describe('pointcloud settings', () => {
  it('defaults to a 6 M budget, rgb colour, size 1 and EDL on', () => {
    const s = createPointcloudSettings(null).getState();
    expect(DEFAULT_BUDGET).toBe(6_000_000);
    expect(s.budget).toBe(6_000_000);
    expect(s.colourMode).toBe('rgb');
    expect(s.sizeScale).toBe(1);
    expect(s.edl).toBe(true);
  });

  it('clamps point size and snaps the budget to a preset', () => {
    const store = createPointcloudSettings(null);
    store.getState().setSizeScale(99);
    expect(store.getState().sizeScale).toBe(4);
    store.getState().setBudget(4_100_000);
    expect(BUDGETS).toContain(store.getState().budget);
    expect(store.getState().budget).toBe(4_000_000);
  });

  it('remembers choices in storage and restores them', () => {
    const storage = memory();
    const a = createPointcloudSettings(storage);
    a.getState().setColourMode('height');
    a.getState().setEdl(false);
    const b = createPointcloudSettings(storage).getState();
    expect(b.colourMode).toBe('height');
    expect(b.edl).toBe(false);
  });

  it('ignores corrupt storage', () => {
    const storage = memory();
    storage.setItem('stratlas.pointcloud.settings', '{not json');
    expect(createPointcloudSettings(storage).getState().budget).toBe(DEFAULT_BUDGET);
  });
});
