import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanPref, createEnvPrefs, parsePrefs } from './envPrefs';

function memoryStorage(seed: Record<string, string> = {}): Storage {
  const m = new Map(Object.entries(seed));
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

describe('environment preferences', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps choices per project and survives a restart', () => {
    const storage = memoryStorage();
    const a = createEnvPrefs(storage);
    a.getState().set('alzour', { timeMs: 1676970000000 });
    a.getState().set('alzour', { mode: 'studio', water: false });
    a.getState().set('hcl', { mode: 'sky' });
    vi.runAllTimers();
    const b = createEnvPrefs(storage);
    expect(b.getState().byProject).toEqual({
      alzour: { timeMs: 1676970000000, mode: 'studio', water: false },
      hcl: { mode: 'sky' },
    });
  });

  it('writes once the slider settles, not on every change', () => {
    const storage = memoryStorage();
    const spy = vi.spyOn(storage, 'setItem');
    const s = createEnvPrefs(storage);
    for (let i = 0; i < 50; i++) s.getState().set('alzour', { timeMs: i * 60000 });
    expect(spy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('forgets a project on reset', () => {
    const storage = memoryStorage();
    const s = createEnvPrefs(storage);
    s.getState().set('alzour', { water: false });
    s.getState().reset('alzour');
    vi.runAllTimers();
    expect(createEnvPrefs(storage).getState().byProject).toEqual({});
  });

  it('drops malformed stored values', () => {
    expect(
      parsePrefs(
        JSON.stringify({
          a: { mode: 'night', timeMs: 'noon', water: 1, waterLevel: -6.5 },
          b: { waterLevel: null },
          c: 4,
        }),
      ),
    ).toEqual({ a: { waterLevel: -6.5 }, b: { waterLevel: null } });
    expect(parsePrefs('{not json')).toEqual({});
    expect(cleanPref({ timeMs: Number.NaN })).toEqual({});
  });

  it('starts empty when storage is blocked', () => {
    const blocked = memoryStorage();
    blocked.getItem = () => {
      throw new Error('blocked');
    };
    expect(createEnvPrefs(blocked).getState().byProject).toEqual({});
  });
});
