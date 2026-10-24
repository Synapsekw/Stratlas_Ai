import { describe, expect, it } from 'vitest';
import { createLinkedHoverStore, type HoverLine } from './linkedHover';

const line = (key: string): HoverLine => ({
  key,
  polyline: [
    [0, 0],
    [10, 0],
  ],
  series: [],
});

describe('linked hover store', () => {
  it('registers a line and unregisters it', () => {
    const store = createLinkedHoverStore();
    const off = store.getState().register(line('measure:a'));
    expect(store.getState().lines.get('measure:a')?.key).toBe('measure:a');
    off();
    expect(store.getState().lines.has('measure:a')).toBe(false);
  });

  it('a stale unregister does not remove a line registered again under the same key', () => {
    const store = createLinkedHoverStore();
    const offOld = store.getState().register(line('section'));
    const fresh = line('section');
    store.getState().register(fresh);
    offOld();
    expect(store.getState().lines.get('section')).toBe(fresh);
  });

  it('unregistering a line drops its hover and pin', () => {
    const store = createLinkedHoverStore();
    const off = store.getState().register(line('pile:p'));
    store.getState().setHover({ key: 'pile:p', chainageM: 2, source: 'chart' });
    store.getState().setPin({ key: 'pile:p', chainageM: 3, source: '3d' });
    off();
    expect(store.getState().hover).toBeNull();
    expect(store.getState().pin).toBeNull();
  });

  it('a pin survives setHover(null) and setPin(null) clears it', () => {
    const store = createLinkedHoverStore();
    store.getState().setHover({ key: 'section', chainageM: 4, source: 'map' });
    store.getState().setPin({ key: 'section', chainageM: 4, source: 'map' });
    store.getState().setHover(null);
    expect(store.getState().hover).toBeNull();
    expect(store.getState().pin).toEqual({ key: 'section', chainageM: 4, source: 'map' });
    store.getState().setPin(null);
    expect(store.getState().pin).toBeNull();
  });

  it('flyTo bumps the nonce every time, even to the same point', () => {
    const store = createLinkedHoverStore();
    expect(store.getState().fly).toBeNull();
    store.getState().flyTo('section', 5);
    const first = store.getState().fly;
    store.getState().flyTo('section', 5);
    const second = store.getState().fly;
    expect(first).toMatchObject({ key: 'section', chainageM: 5 });
    expect(second?.nonce).toBeGreaterThan(first?.nonce ?? Infinity);
  });
});
