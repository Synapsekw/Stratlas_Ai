import { describe, expect, it } from 'vitest';
import { createProcessingStore, LOOKED_KEY, seenAtOf } from './store';

/** The little of `localStorage` the store reads and writes: a map. */
function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => {
      data.set(k, v);
    },
  };
}

function make(
  root: string | null = 'D:\\Sites\\A',
  storage: ReturnType<typeof fakeStorage> | null = null,
) {
  let t = Date.parse('2026-10-11T08:00:00.000Z');
  const where = { root, blocked: false };
  const store = createProcessingStore({
    now: () => new Date((t += 60_000)),
    root: () => where.root,
    blocked: () => where.blocked,
    storage,
  });
  return { store, where };
}

describe('the processing drawer state', () => {
  it('starts closed and remembers when the session started', () => {
    const { store } = make();
    expect(store.getState().open).toBe(false);
    expect(store.getState().start).toBe('2026-10-11T08:01:00.000Z');
    expect(seenAtOf(store.getState(), 'D:\\Sites\\A')).toBeNull();
  });

  it('notes the look when the drawer opens, and again when it closes', () => {
    const { store } = make();
    store.getState().openDrawer();
    expect(store.getState().open).toBe(true);
    expect(seenAtOf(store.getState(), 'd:/sites/a')).toBe('2026-10-11T08:02:00.000Z');
    store.getState().closeDrawer();
    expect(store.getState().open).toBe(false);
    expect(seenAtOf(store.getState(), 'D:\\Sites\\A')).toBe('2026-10-11T08:03:00.000Z');
  });

  it('keeps the look per project', () => {
    const { store, where } = make();
    store.getState().openDrawer();
    where.root = 'D:\\Sites\\B';
    expect(seenAtOf(store.getState(), where.root)).toBeNull();
  });

  it('does not open under a panel that covers the screen, and notes no look', () => {
    const { store, where } = make();
    where.blocked = true;
    store.getState().openDrawer('job-7');
    expect(store.getState().open).toBe(false);
    expect(store.getState().picked).toBeNull();
    expect(store.getState().seen).toEqual({});
  });

  it('keeps the look of a project when another project is looked at', () => {
    const { store, where } = make();
    store.getState().openDrawer();
    where.root = 'D:\\Sites\\B';
    store.getState().closeDrawer();
    expect(seenAtOf(store.getState(), 'D:\\Sites\\A')).toBe('2026-10-11T08:02:00.000Z');
    expect(seenAtOf(store.getState(), 'D:\\Sites\\B')).toBe('2026-10-11T08:03:00.000Z');
  });

  it('forgets the picked job when the drawer closes', () => {
    const { store } = make();
    store.getState().openDrawer('job-7');
    store.getState().closeDrawer();
    expect(store.getState().picked).toBeNull();
  });

  it('opens on a job when asked, and goes back to the list', () => {
    const { store } = make();
    store.getState().openDrawer('job-7');
    expect(store.getState().picked).toBe('job-7');
    store.getState().pick(null);
    expect(store.getState().picked).toBeNull();
    expect(store.getState().open).toBe(true);
  });

  it('opens without a project and notes nothing', () => {
    const { store } = make(null);
    store.getState().openDrawer();
    expect(store.getState().open).toBe(true);
    expect(store.getState().seen).toEqual({});
  });

  it('holds one start dialog at a time', () => {
    const { store } = make();
    const req = { pipeline: 'road.build' as const, project: 'D:\\Sites\\A', values: {} };
    store.getState().openDialog(req);
    expect(store.getState().dialog).toEqual(req);
    store.getState().closeDialog();
    expect(store.getState().dialog).toBeNull();
  });
});

describe('the looks, kept on this computer', () => {
  it('survive a new store built on the same storage', () => {
    const storage = fakeStorage();
    const first = make('D:\\Sites\\A', storage);
    first.store.getState().openDrawer();
    const second = make('D:\\Sites\\A', storage);
    expect(seenAtOf(second.store.getState(), 'D:\\Sites\\A')).toBe('2026-10-11T08:02:00.000Z');
    expect(JSON.parse(storage.data.get(LOOKED_KEY) ?? 'null')).toEqual({
      'd:/sites/a': '2026-10-11T08:02:00.000Z',
    });
  });

  it('are written when the drawer closes too, and not when no project is open', () => {
    const storage = fakeStorage();
    const { store } = make('D:\\Sites\\A', storage);
    store.getState().openDrawer();
    store.getState().closeDrawer();
    expect(JSON.parse(storage.data.get(LOOKED_KEY) ?? 'null')).toEqual({
      'd:/sites/a': '2026-10-11T08:03:00.000Z',
    });
    const bare = fakeStorage();
    make(null, bare).store.getState().openDrawer();
    expect(bare.data.size).toBe(0);
  });

  it('are ignored when the storage holds garbage', () => {
    for (const garbage of ['not json', '[1,2]', '"text"', 'null', '{"d:/sites/a": 7}']) {
      const { store } = make('D:\\Sites\\A', fakeStorage({ [LOOKED_KEY]: garbage }));
      expect(store.getState().seen).toEqual({});
    }
  });

  it('keeps the readable entries of a half broken map', () => {
    const stored = JSON.stringify({ 'd:/sites/a': '2026-10-10T08:00:00.000Z', 'd:/sites/b': 3 });
    const { store } = make('D:\\Sites\\A', fakeStorage({ [LOOKED_KEY]: stored }));
    expect(store.getState().seen).toEqual({ 'd:/sites/a': '2026-10-10T08:00:00.000Z' });
  });

  it('do not throw when the storage does', () => {
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    let t = Date.parse('2026-10-11T08:00:00.000Z');
    const store = createProcessingStore({
      now: () => new Date((t += 60_000)),
      root: () => 'D:\\Sites\\A',
      storage: broken,
    });
    expect(() => {
      store.getState().openDrawer();
      store.getState().closeDrawer();
    }).not.toThrow();
    expect(seenAtOf(store.getState(), 'D:\\Sites\\A')).toBe('2026-10-11T08:03:00.000Z');
  });
});
