import { describe, expect, it } from 'vitest';
import {
  inEditable,
  isSpikeToggle,
  LAYOUT_SPIKE_KEY,
  layoutSpikeOn,
  toggleLayoutSpike,
} from './flag';

function memory(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> & {
  map: Map<string, string>;
} {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, v);
    },
    removeItem: (k) => {
      map.delete(k);
    },
  };
}

const key = (
  over: Partial<Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>> & {
    altGraph?: boolean;
    target?: EventTarget | null;
  } = {},
) => ({
  code: 'KeyL',
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  target: null,
  ...over,
  getModifierState: (k: string) => k === 'AltGraph' && over.altGraph === true,
});

/** A stand-in element: `closest` answers for the selectors a field matches. */
const element = (field: boolean, editable = false) =>
  ({
    isContentEditable: editable,
    closest: () => (field ? {} : null),
  }) as unknown as EventTarget;

describe('layout spike flag', () => {
  it('is off by default, on with the key', () => {
    const s = memory();
    expect(layoutSpikeOn(s)).toBe(false);
    s.setItem(LAYOUT_SPIKE_KEY, '1');
    expect(layoutSpikeOn(s)).toBe(true);
    s.setItem(LAYOUT_SPIKE_KEY, 'yes');
    expect(layoutSpikeOn(s)).toBe(false);
    expect(layoutSpikeOn(null)).toBe(false);
  });

  it('toggles on and off again, leaving no key behind', () => {
    const s = memory();
    expect(toggleLayoutSpike(s)).toBe(true);
    expect(s.map.get(LAYOUT_SPIKE_KEY)).toBe('1');
    expect(toggleLayoutSpike(s)).toBe(false);
    expect(s.map.has(LAYOUT_SPIKE_KEY)).toBe(false);
  });

  it('reads a storage that throws as off', () => {
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    expect(layoutSpikeOn(broken)).toBe(false);
    expect(toggleLayoutSpike(broken)).toBe(false);
  });

  it('toggles on Ctrl+Alt+L only, by the physical key', () => {
    expect(isSpikeToggle(key({ ctrlKey: true, altKey: true }))).toBe(true);
    expect(isSpikeToggle(key({ metaKey: true, altKey: true }))).toBe(true);
    expect(isSpikeToggle(key({ ctrlKey: true }))).toBe(false);
    expect(isSpikeToggle(key({ altKey: true }))).toBe(false);
    expect(isSpikeToggle(key({ ctrlKey: true, altKey: true, shiftKey: true }))).toBe(false);
    expect(isSpikeToggle(key({ ctrlKey: true, altKey: true, code: 'KeyK' }))).toBe(false);
  });

  it('never toggles on AltGr', () => {
    expect(isSpikeToggle(key({ ctrlKey: true, altKey: true, altGraph: true }))).toBe(false);
  });

  it('never toggles while typing in a field', () => {
    const typed = (target: EventTarget) => key({ ctrlKey: true, altKey: true, target });
    expect(isSpikeToggle(typed(element(true)))).toBe(false);
    expect(isSpikeToggle(typed(element(false, true)))).toBe(false);
    expect(isSpikeToggle(typed(element(false)))).toBe(true);
    expect(inEditable(element(true))).toBe(true);
    expect(inEditable(null)).toBe(false);
  });
});
