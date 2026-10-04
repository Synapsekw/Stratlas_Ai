import type { Layer } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import {
  createTimelinePref,
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
    storage.setItem('stratlas.timeline', '{"a":true,"b":"yes"}');
    expect(createTimelinePref(storage).getState().byProject).toEqual({ a: true });
    storage.setItem('stratlas.timeline', 'not json');
    expect(createTimelinePref(storage).getState().byProject).toEqual({});
  });
});
