import { describe, expect, it } from 'vitest';
import { createPinDisplay } from './pinDisplay';

function memory() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => {
      m.set(k, v);
    },
  };
}

describe('pin display settings', () => {
  it('starts with every pin and no heat map', () => {
    expect(createPinDisplay(null).getState()).toMatchObject({ filter: 'all', heat: false });
  });

  it('remembers the filter and the heat map across sessions', () => {
    const store = memory();
    const a = createPinDisplay(store);
    a.getState().setFilter(2);
    a.getState().setHeat(true);
    expect(createPinDisplay(store).getState()).toMatchObject({ filter: 2, heat: true });
    a.getState().setFilter('off');
    expect(createPinDisplay(store).getState().filter).toBe('off');
  });

  it('survives storage that throws', () => {
    const bad = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    const d = createPinDisplay(bad);
    d.getState().setHeat(true);
    expect(d.getState().heat).toBe(true);
  });
});
