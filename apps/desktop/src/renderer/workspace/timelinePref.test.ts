import type { Layer } from '@aio/schema';
import { createWorkspace } from '@aio/workspace';
import { describe, expect, it } from 'vitest';
import { createTimelineStore, TIMELINE_KEY } from './timeline';
import {
  createTimelinePref,
  TIMELINE_SHOWN_KEY,
  timelineByDefault,
  timelineShown,
  toggleTimeline,
} from './timelinePref';

const kinds = (...k: Layer['kind'][]) => k.map((kind) => ({ kind }));

function memory() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => {
      m.set(k, v);
    },
  };
}

describe('timeline visibility', () => {
  it('shows by default only for projects with video clips', () => {
    // HCl, Al-Zour: clips (with photos, clouds)
    expect(timelineByDefault(kinds('mesh', 'video', 'video', 'photos'))).toBe(true);
    // DAMAC: a model and timed photos, no video
    expect(timelineByDefault(kinds('mesh', 'photos', 'photos', 'raster'))).toBe(false);
    // Masafi: two surveys, nothing to play
    expect(timelineByDefault(kinds('mesh', 'mesh', 'raster', 'legacy'))).toBe(false);
  });

  it("follows the user's choice over the default", () => {
    expect(timelineShown(undefined, kinds('mesh'))).toBe(false);
    expect(timelineShown(true, kinds('mesh'))).toBe(true);
    expect(timelineShown(false, kinds('video'))).toBe(false);
  });

  it('toggles per project and remembers the choice', () => {
    const storage = memory();
    const store = createTimelinePref(storage);
    const damac = { id: 'damac', manifest: { layers: kinds('mesh', 'photos') } };
    const hcl = { id: 'hcl', manifest: { layers: kinds('mesh', 'video') } };
    toggleTimeline(damac, store);
    expect(store.getState().byProject).toEqual({ damac: true });
    toggleTimeline(hcl, store);
    expect(store.getState().byProject).toEqual({ damac: true, hcl: false });
    toggleTimeline(damac, store);
    expect(createTimelinePref(storage).getState().byProject).toEqual({
      damac: false,
      hcl: false,
    });
    toggleTimeline(null, store);
    expect(Object.keys(store.getState().byProject)).toHaveLength(2);
  });

  it('ignores bad stored values', () => {
    const storage = memory();
    storage.setItem(TIMELINE_SHOWN_KEY, '{"a":true,"b":"yes"}');
    expect(createTimelinePref(storage).getState().byProject).toEqual({ a: true });
    storage.setItem(TIMELINE_SHOWN_KEY, 'not json');
    expect(createTimelinePref(storage).getState().byProject).toEqual({});
  });

  it('saves under its own key and leaves the date prefs alone', () => {
    const storage = memory();
    storage.setItem('stratlas.timeline', JSON.stringify({ p: { focus: 's1' } }));
    const store = createTimelinePref(storage);
    toggleTimeline({ id: 'p', manifest: { layers: kinds('mesh') } }, store);
    expect(JSON.parse(storage.getItem(TIMELINE_SHOWN_KEY) ?? '{}')).toEqual({ p: true });
    expect(JSON.parse(storage.getItem('stratlas.timeline') ?? '{}')).toEqual({
      p: { focus: 's1' },
    });
  });

  it('takes the choices saved under the old key once', () => {
    const storage = memory();
    storage.setItem('stratlas.timeline', JSON.stringify({ a: true, b: { focus: 's1' } }));
    expect(createTimelinePref(storage).getState().byProject).toEqual({ a: true });
    storage.setItem(TIMELINE_SHOWN_KEY, JSON.stringify({ c: false }));
    expect(createTimelinePref(storage).getState().byProject).toEqual({ c: false });
  });

  it('moves the choices from the old key at once, so the date prefs can overwrite it', () => {
    const storage = memory();
    storage.setItem('stratlas.timeline', JSON.stringify({ a: true, b: { focus: 's1' } }));
    createTimelinePref(storage);
    expect(JSON.parse(storage.getItem(TIMELINE_SHOWN_KEY) ?? '{}')).toEqual({ a: true });
    // the date store's next save rewrites the old key with dates only
    storage.setItem('stratlas.timeline', JSON.stringify({ b: { focus: 's2' } }));
    expect(createTimelinePref(storage).getState().byProject).toEqual({ a: true });
  });

  it('does not wipe the date prefs when both stores share one storage', () => {
    const m = new Map<string, string>();
    const storage = {
      ...memory(),
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => {
        m.set(k, v);
      },
      removeItem: (k: string) => {
        m.delete(k);
      },
      clear: () => {
        m.clear();
      },
      key: () => null,
      length: 0,
    } as Storage;
    storage.setItem(TIMELINE_KEY, JSON.stringify({ p: { focus: 's1' } }));
    const pref = createTimelinePref(storage);
    toggleTimeline({ id: 'p', manifest: { layers: kinds('mesh') } }, pref);
    const again = createTimelineStore(createWorkspace(), storage, () => undefined);
    expect(again.getState().byProject.p?.focus).toBe('s1');
  });
});
