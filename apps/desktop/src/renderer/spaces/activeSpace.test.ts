import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createActiveSpaceStore, useActiveSpace } from './activeSpace';

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const m = new Map(Object.entries(initial));
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => {
      m.set(k, v);
    },
    removeItem: (k) => {
      m.delete(k);
    },
    clear: () => {
      m.clear();
    },
    key: () => null,
    get length() {
      return m.size;
    },
  };
}

describe('active space store', () => {
  it('the active space is kept per project', () => {
    const storage = memoryStorage();
    const a = createActiveSpaceStore(storage);
    a.getState().set('p1', 's-a');
    a.getState().set('p2', 's-b');
    const b = createActiveSpaceStore(storage);
    expect(b.getState().byProject).toEqual({ p1: 's-a', p2: 's-b' });
  });

  it('a throwing getItem or setItem leaves the store working', () => {
    const ok = memoryStorage();
    const storage: Storage = {
      clear: () => {
        ok.clear();
      },
      key: () => null,
      removeItem: () => undefined,
      length: 0,
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    const store = createActiveSpaceStore(storage);
    expect(store.getState().byProject).toEqual({});
    store.getState().set('p1', 's-a');
    expect(store.getState().byProject).toEqual({ p1: 's-a' });
  });

  it('importing the module reads no storage, and the hook defaults with no project', () => {
    function Probe() {
      const a = useActiveSpace();
      return createElement('i', null, `${a.spaceId}|${String(a.mapAvailable)}|${a.spaces.length}`);
    }
    expect(renderToString(createElement(Probe))).toContain('main|true|0');
  });

  it('a broken stored value reads as none', () => {
    const broken = memoryStorage({ 'stratlas.activeSpace': '{oops' });
    expect(createActiveSpaceStore(broken).getState().byProject).toEqual({});
    const wrong = memoryStorage({ 'stratlas.activeSpace': '{"p":7}' });
    expect(createActiveSpaceStore(wrong).getState().byProject).toEqual({});
  });
});
