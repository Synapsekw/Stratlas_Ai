import { describe, expect, it } from 'vitest';
import {
  createFlightPathStore,
  defaultPathPref,
  flightPathShown,
  hiddenPathClips,
  toggleFlightPath,
  togglePaths,
  type FlightRef,
} from './flightPaths';

const flights: FlightRef[] = [
  { id: 'a', clips: ['a1', 'a2'] },
  { id: 'b', clips: ['b1'] },
  { id: 'c', clips: ['c1', 'c2', 'c3'] },
];

function memoryStorage(): Storage {
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
    removeItem: (k) => {
      m.delete(k);
    },
    setItem: (k, v) => {
      m.set(k, v);
    },
  };
}

describe('flight path preferences', () => {
  it('defaults to the active clip only for projects with many clips', () => {
    expect(defaultPathPref(25).mode).toBe('active');
    expect(defaultPathPref(3).mode).toBe('all');
  });

  it('P toggles the paths off and back to the last mode that showed them', () => {
    const p = { mode: 'active' as const, lastOn: 'active' as const, hiddenFlights: [] };
    const off = togglePaths(p);
    expect(off.mode).toBe('off');
    expect(togglePaths(off).mode).toBe('active');
    expect(togglePaths({ ...off, lastOn: 'all' }).mode).toBe('all');
  });

  it('a flight path shows by mode, active flight and the per-flight hide', () => {
    const all = { mode: 'all' as const, lastOn: 'all' as const, hiddenFlights: ['b'] };
    expect(flightPathShown(all, 'a', null)).toBe(true);
    expect(flightPathShown(all, 'b', null)).toBe(false);
    const active = { ...all, mode: 'active' as const, hiddenFlights: [] };
    expect(flightPathShown(active, 'a', 'a')).toBe(true);
    expect(flightPathShown(active, 'c', 'a')).toBe(false);
    expect(flightPathShown({ ...all, mode: 'off' }, 'a', 'a')).toBe(false);
  });

  it('hidden flights become the clip ids the rig hides paths for', () => {
    const p = { mode: 'all' as const, lastOn: 'all' as const, hiddenFlights: ['a', 'c'] };
    expect([...hiddenPathClips(p, flights)].sort()).toEqual(['a1', 'a2', 'c1', 'c2', 'c3']);
  });

  it('the flight eye hides a shown path, and shows a hidden one without showing others', () => {
    const all = { mode: 'all' as const, lastOn: 'all' as const, hiddenFlights: [] };
    const hidden = toggleFlightPath(all, 'b', flights, null);
    expect(hidden.hiddenFlights).toEqual(['b']);
    expect(toggleFlightPath(hidden, 'b', flights, null).hiddenFlights).toEqual([]);

    // Active only, flight a active: turning c on draws a and c, and nothing else.
    const active = { mode: 'active' as const, lastOn: 'active' as const, hiddenFlights: [] };
    const next = toggleFlightPath(active, 'c', flights, 'a');
    expect(next.mode).toBe('all');
    for (const f of flights)
      expect(flightPathShown(next, f.id, 'a'), f.id).toBe(f.id === 'a' || f.id === 'c');

    // Paths off: turning one flight on draws just that flight.
    const off = { mode: 'off' as const, lastOn: 'active' as const, hiddenFlights: [] };
    const one = toggleFlightPath(off, 'b', flights, 'a');
    for (const f of flights) expect(flightPathShown(one, f.id, 'a'), f.id).toBe(f.id === 'b');
  });

  it('remembers the choice per project', () => {
    const storage = memoryStorage();
    const s1 = createFlightPathStore(storage);
    expect(s1.getState().pref('alzour', 25).mode).toBe('active');
    s1.getState().set('alzour', { mode: 'off', lastOn: 'active', hiddenFlights: ['a'] });
    expect(s1.getState().pref('hcl', 76).mode).toBe('active');
    const s2 = createFlightPathStore(storage);
    expect(s2.getState().pref('alzour', 25)).toEqual({
      mode: 'off',
      lastOn: 'active',
      hiddenFlights: ['a'],
    });
  });
});
