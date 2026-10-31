// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  clampVideoRect,
  VIDEO_MARGIN,
  defaultVideoRect,
  VIDEO_CHROME,
  VIDEO_MIN_W,
  VIDEO_TOP,
  videoHeight,
} from '../videoWindow';
import { followHidden, shellFlags } from './videoDockBridge';
import { createVideoDockStore, dockClipOf, dockMode, VIDEO_DOCK_KEY } from './videoDockStore';

function memoryStorage(): Pick<Storage, 'getItem' | 'setItem'> {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => {
      m.set(k, v);
    },
  };
}

describe('video dock store', () => {
  it('no video means closed and no tile', () => {
    expect(dockMode(undefined, false)).toBe('closed');
    expect(dockMode('floating', false)).toBe('closed');
    // with video, docked unless the user chose otherwise
    expect(dockMode(undefined, true)).toBe('docked');
    expect(dockMode('floating', true)).toBe('floating');
  });

  it('pop out then pop in returns to docked', () => {
    const s = createVideoDockStore(memoryStorage());
    s.getState().popOut('p');
    expect(dockMode(s.getState().byProject.p, true)).toBe('floating');
    s.getState().popIn('p');
    expect(dockMode(s.getState().byProject.p, true)).toBe('docked');
    // another project keeps its own mode
    expect(s.getState().byProject.q).toBeUndefined();
  });

  it('floating rect is clamped to 320 x 180 up to 80 % of the stage', () => {
    const stage = { width: 1000, height: 700 };
    const small = clampVideoRect({ left: 40, bottom: 40, width: 10 }, stage);
    expect(small.width).toBe(VIDEO_MIN_W);
    expect(videoHeight(small.width) - VIDEO_CHROME).toBe(180);
    const big = clampVideoRect({ left: 0, bottom: 0, width: 5000 }, stage);
    expect(big.width).toBeLessThanOrEqual(stage.width * 0.8);
    expect(videoHeight(big.width)).toBeLessThanOrEqual(stage.height * 0.8);
    // a wide, low stage: the height share wins
    const wide = { width: 2400, height: 600 };
    const w = clampVideoRect({ left: 0, bottom: 0, width: 5000 }, wide);
    expect(videoHeight(w.width)).toBeLessThanOrEqual(wide.height * 0.8);
  });

  it('first places the window top left, under the island', () => {
    const stage = { width: 900, height: 560 };
    const r = clampVideoRect(defaultVideoRect(stage), stage);
    expect(r.left).toBe(12);
    // its top edge, in pixels from the stage top, is clear of the island's rows
    expect(stage.height - r.bottom - videoHeight(r.width)).toBe(VIDEO_TOP);
  });

  it('keeps below an opened island that reaches lower than its usual room', () => {
    const stage = { width: 900, height: 560, top: 180 };
    const r = clampVideoRect({ left: 12, bottom: 5000, width: 400 }, stage);
    expect(stage.height - r.bottom - videoHeight(r.width)).toBe(180);
  });

  it('a stage smaller than 320 x 180 caps the window to its room, never under the island', () => {
    const stage = { width: 600, height: 250 };
    const r = clampVideoRect({ left: 12, bottom: 12, width: 400 }, stage);
    expect(r.width).toBeLessThan(VIDEO_MIN_W);
    expect(r.width).toBeGreaterThan(0);
    // its top edge, from the stage top, stays clear of the island's rows
    expect(stage.height - r.bottom - videoHeight(r.width)).toBeGreaterThanOrEqual(VIDEO_TOP);
    expect(r.bottom).toBeGreaterThanOrEqual(VIDEO_MARGIN - 1);
    // no room at all: the top edge still keeps clear
    const none = { width: 600, height: 100 };
    const n = clampVideoRect({ left: 12, bottom: 12, width: 400 }, none);
    expect(none.height - n.bottom - videoHeight(n.width)).toBeGreaterThanOrEqual(VIDEO_TOP);
  });

  it('the clip shown is the active one, else the first video, else none', () => {
    const layers = [
      { id: 'm', kind: 'mesh' },
      { id: 'a', kind: 'video' },
      { id: 'b', kind: 'video' },
    ];
    expect(dockClipOf({ project: { manifest: { layers } }, activeClip: null })).toBe('a');
    expect(dockClipOf({ project: { manifest: { layers } }, activeClip: 'b' })).toBe('b');
    expect(dockClipOf({ project: { manifest: { layers } }, activeClip: 'm' })).toBe('a');
    expect(
      dockClipOf({ project: { manifest: { layers: layers.slice(0, 1) } }, activeClip: null }),
    ).toBeNull();
    expect(dockClipOf({ project: null, activeClip: null })).toBeNull();
  });

  it('says where focus goes after Pop out, Pop in and Close, once', () => {
    const s = createVideoDockStore(memoryStorage());
    s.getState().popOut('p');
    expect(s.getState().takeFocus()).toBe('header');
    expect(s.getState().takeFocus()).toBeNull();
    s.getState().popIn('p');
    expect(s.getState().takeFocus()).toBe('popout');
    s.getState().close('p');
    expect(s.getState().takeFocus()).toBe('show');
  });

  it('a closed tile stays closed on reopen of the project until the user reopens it', () => {
    const storage = memoryStorage();
    const a = createVideoDockStore(storage);
    a.getState().close('p');
    a.getState().setRect({ left: 30, bottom: 40, width: 400 });
    const b = createVideoDockStore(storage);
    expect(dockMode(b.getState().byProject.p, true)).toBe('closed');
    expect(b.getState().rect).toEqual({ left: 30, bottom: 40, width: 400 });
    b.getState().reopen('p');
    expect(dockMode(createVideoDockStore(storage).getState().byProject.p, true)).toBe('docked');
  });

  it('ignores broken storage', () => {
    const storage = memoryStorage();
    storage.setItem(VIDEO_DOCK_KEY, '{not json');
    expect(createVideoDockStore(storage).getState()).toMatchObject({ byProject: {}, rect: null });
    storage.setItem(VIDEO_DOCK_KEY, JSON.stringify({ byProject: { p: 'big' }, rect: 'x' }));
    expect(createVideoDockStore(storage).getState()).toMatchObject({ byProject: {}, rect: null });
    expect(createVideoDockStore(null).getState().byProject).toEqual({});
  });
});

describe('video dock and the shell flags', () => {
  it('closed is hidden, only floating is undocked', () => {
    expect(shellFlags(undefined)).toEqual({ videoHidden: false, videoDocked: true });
    expect(shellFlags('floating')).toEqual({ videoHidden: false, videoDocked: false });
    expect(shellFlags('closed')).toEqual({ videoHidden: true, videoDocked: true });
  });

  it('the W key or the island hiding the video closes it, showing it restores the mode', () => {
    const s = createVideoDockStore(memoryStorage());
    followHidden(s, 'p', true);
    expect(s.getState().byProject.p).toBe('closed');
    followHidden(s, 'p', false);
    expect(s.getState().byProject.p).toBe('docked');
    // hidden while popped out and shown again: popped out again, not docked
    s.getState().popOut('p');
    followHidden(s, 'p', true);
    expect(s.getState().byProject.p).toBe('closed');
    followHidden(s, 'p', false);
    expect(s.getState().byProject.p).toBe('floating');
    // shown while not closed: nothing changes
    followHidden(s, 'p', false);
    expect(s.getState().byProject.p).toBe('floating');
  });
});
