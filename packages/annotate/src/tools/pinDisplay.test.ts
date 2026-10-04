import { describe, expect, it } from 'vitest';
import { createPinDisplay, togglePinFilter } from './pinDisplay';

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

  it('turns the pins off and back on to the last filter in one step', () => {
    expect(togglePinFilter('all', 'all')).toBe('off');
    expect(togglePinFilter('off', 2)).toBe(2);
    const store = memory();
    const d = createPinDisplay(store);
    d.getState().setFilter(2);
    d.getState().togglePins();
    expect(d.getState().filter).toBe('off');
    d.getState().togglePins();
    expect(d.getState().filter).toBe(2);
    // the popover and the toggle share one setting: Off in the popover, then the toggle
    d.getState().setFilter('all');
    d.getState().setFilter('off');
    d.getState().togglePins();
    expect(d.getState().filter).toBe('all');
    // the filter to return to is remembered with the pins off
    d.getState().setFilter(3);
    d.getState().togglePins();
    const again = createPinDisplay(store);
    expect(again.getState()).toMatchObject({ filter: 'off', lastOn: 3 });
    again.getState().togglePins();
    expect(again.getState().filter).toBe(3);
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
