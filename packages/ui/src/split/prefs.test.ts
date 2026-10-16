import { describe, expect, it } from 'vitest';
import { SPLIT_PREFS_KEY, createSplitPrefs } from './prefs';

function memory(initial?: string) {
  const data = new Map<string, string>();
  if (initial !== undefined) data.set(SPLIT_PREFS_KEY, initial);
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => {
      data.set(k, v);
    },
  };
}

describe('split prefs', () => {
  it('starts empty', () => {
    expect(createSplitPrefs(memory()).getState().byId).toEqual({});
    expect(createSplitPrefs(null).getState().byId).toEqual({});
  });

  it('saves under quadrion.splits', () => {
    const storage = memory();
    const store = createSplitPrefs(storage);
    store.getState().save('media.viewer', { size: 0.6 });
    expect(SPLIT_PREFS_KEY).toBe('quadrion.splits');
    expect(storage.data.get('quadrion.splits')).toBe('{"media.viewer":{"size":0.6}}');
    expect(store.getState().byId).toEqual({ 'media.viewer': { size: 0.6 } });
  });

  it('reads back what it saved', () => {
    const storage = memory();
    createSplitPrefs(storage).getState().save('shell.left', { size: 252, collapsed: true });
    expect(createSplitPrefs(storage).getState().byId).toEqual({
      'shell.left': { size: 252, collapsed: true },
    });
  });

  it('falls back to defaults on corrupt or blocked storage', () => {
    expect(createSplitPrefs(memory('x')).getState().byId).toEqual({});
    expect(createSplitPrefs(memory('{"media.viewer":{"size":"wide"}}')).getState().byId).toEqual(
      {},
    );
    expect(createSplitPrefs(memory('[1]')).getState().byId).toEqual({});
    const throwing = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => undefined,
    };
    expect(createSplitPrefs(throwing).getState().byId).toEqual({});
  });

  it('keeps a value in memory when writing fails', () => {
    const store = createSplitPrefs({
      getItem: () => null,
      setItem: () => {
        throw new Error('quota');
      },
    });
    store.getState().save('media.viewer', { size: 0.6 });
    expect(store.getState().byId).toEqual({ 'media.viewer': { size: 0.6 } });
  });
});
