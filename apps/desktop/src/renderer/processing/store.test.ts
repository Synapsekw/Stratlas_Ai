import { describe, expect, it } from 'vitest';
import { createProcessingStore, seenAtOf } from './store';

function make(root: string | null = 'D:\\Sites\\A') {
  let t = Date.parse('2026-10-11T08:00:00.000Z');
  const where = { root, blocked: false };
  const store = createProcessingStore({
    now: () => new Date((t += 60_000)),
    root: () => where.root,
    blocked: () => where.blocked,
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
