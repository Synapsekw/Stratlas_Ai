import { describe, expect, it } from 'vitest';
import { createDatePromptPref } from './datePromptPref';

function memory() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => {
      m.set(k, v);
    },
  };
}

describe('date prompt pref', () => {
  it('remembers a finished project', () => {
    const storage = memory();
    const store = createDatePromptPref(storage);
    store.getState().finish('p1');
    expect(store.getState().done).toEqual({ p1: true });
    expect(createDatePromptPref(storage).getState().done).toEqual({ p1: true });
  });

  it('reads a malformed stored value as empty', () => {
    const storage = memory();
    storage.setItem('stratlas.datePrompt', 'not json');
    expect(createDatePromptPref(storage).getState().done).toEqual({});
    storage.setItem('stratlas.datePrompt', '{"a":true,"b":"yes"}');
    expect(createDatePromptPref(storage).getState().done).toEqual({ a: true });
  });

  it('ignores storage that throws', () => {
    const bad = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    const store = createDatePromptPref(bad);
    expect(store.getState().done).toEqual({});
    expect(() => {
      store.getState().finish('p1');
    }).not.toThrow();
    expect(store.getState().done).toEqual({ p1: true });
  });
});
