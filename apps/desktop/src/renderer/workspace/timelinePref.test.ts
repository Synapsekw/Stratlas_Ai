import type { Layer } from '@aio/schema';
import { createWorkspace } from '@aio/workspace';
import { describe, expect, it } from 'vitest';
import { createTimelineStore, TIMELINE_KEY } from './timeline';
import {
  BOTTOM_PREF_KEY,
  bottomSlot,
  createProjectChoice,
  createTimelinePref,
  DATES_COLLAPSED_KEY,
  datedCount,
  isBottomPref,
  offersSwitch,
  TIMELINE_SHOWN_KEY,
  timelineAvailable,
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
    // a plant inspection: clips (with photos, clouds)
    expect(timelineByDefault(kinds('mesh', 'video', 'video', 'photos'))).toBe(true);
    // a facade survey: a model and timed photos, no video
    expect(timelineByDefault(kinds('mesh', 'photos', 'photos', 'raster'))).toBe(false);
    // a quarry: two surveys, nothing to play
    expect(timelineByDefault(kinds('mesh', 'mesh', 'raster', 'legacy'))).toBe(false);
  });

  it("follows the user's choice over the default", () => {
    const two = [{ date: '2020-12-31' }, { date: '2021-01-10' }];
    expect(timelineShown(undefined, kinds('video'))).toBe(true);
    expect(timelineShown(false, kinds('video'))).toBe(false);
    expect(timelineShown(false, kinds('mesh'), two)).toBe(false);
    expect(timelineShown(true, kinds('mesh'), two)).toBe(true);
    // nothing to show: no choice opens it
    expect(timelineShown(true, kinds('mesh'))).toBe(false);
  });

  it('toggles per project and remembers the choice', () => {
    const storage = memory();
    const store = createTimelinePref(storage);
    const captures = [{ date: '2020-12-31' }, { date: '2021-01-10' }];
    const dates = { id: 'dates', manifest: { layers: kinds('mesh', 'photos'), captures } };
    const clips = { id: 'clips', manifest: { layers: kinds('mesh', 'video') } };
    toggleTimeline(dates, store);
    expect(store.getState().byProject).toEqual({ dates: false });
    toggleTimeline(clips, store);
    expect(store.getState().byProject).toEqual({ dates: false, clips: false });
    toggleTimeline(dates, store);
    expect(createTimelinePref(storage).getState().byProject).toEqual({
      dates: true,
      clips: false,
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
    toggleTimeline({ id: 'p', manifest: { layers: kinds('video') } }, store);
    expect(JSON.parse(storage.getItem(TIMELINE_SHOWN_KEY) ?? '{}')).toEqual({ p: false });
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
    toggleTimeline({ id: 'p', manifest: { layers: kinds('video') } }, pref);
    const again = createTimelineStore(createWorkspace(), storage, () => undefined);
    expect(again.getState().byProject.p?.focus).toBe('s1');
  });

  it('shows by default with two or more dated surveys, never counting an undated one', () => {
    const two = [{ date: '2020-12-31' }, { date: '2021-01-10' }];
    expect(timelineByDefault(kinds('mesh', 'raster'), two)).toBe(true);
    expect(timelineByDefault(kinds('mesh'), [{ date: '2020-12-31' }, { date: '' }])).toBe(false);
    expect(datedCount([{ date: '2020-12-31' }, {}, { date: 'not a date' }])).toBe(1);
    const p = { id: 'p', manifest: { layers: kinds('mesh'), captures: two } };
    const store = createTimelinePref(memory());
    toggleTimeline(p, store);
    expect(store.getState().byProject).toEqual({ p: false });
  });
});

describe('a timeline to show', () => {
  it('needs video or a second dated survey', () => {
    expect(timelineAvailable(kinds('mesh', 'video'))).toBe(true);
    expect(timelineAvailable(kinds('mesh'), [{ date: '2020-12-31' }, { date: '2021-01-10' }])).toBe(
      true,
    );
    expect(timelineAvailable(kinds('mesh', 'photos'), [{ date: '2020-12-31' }])).toBe(false);
    expect(timelineAvailable(kinds('mesh'), [{ date: '2020-12-31' }, { date: 'soon' }])).toBe(
      false,
    );
    expect(timelineAvailable(kinds('mesh'))).toBe(false);
  });

  it('closes a timeline left open, and the toggle does nothing, without one', () => {
    const store = createTimelinePref(memory());
    const one = {
      id: 'p',
      manifest: { layers: kinds('mesh'), captures: [{ date: '2020-12-31' }] },
    };
    store.getState().set('p', true);
    expect(
      timelineShown(store.getState().byProject.p, one.manifest.layers, one.manifest.captures),
    ).toBe(false);
    toggleTimeline(one, store);
    expect(store.getState().byProject).toEqual({ p: true });
  });
});

describe('the bottom slot', () => {
  const base = { hasVideo: false, datedCaptures: 2, hasVolumes: true, pref: null, shown: true };
  it.each([
    ['no video and two dates: the dates strip', base, 'dates'],
    [
      'no video and one date: nothing by default',
      { ...base, datedCaptures: 1, shown: false },
      'none',
    ],
    ['no video and one date, even shown: nothing', { ...base, datedCaptures: 1 }, 'none'],
    ['no video and no dates, even shown: nothing', { ...base, datedCaptures: 0 }, 'none'],
    ['hidden: nothing', { ...base, shown: false }, 'none'],
    ['video and one date: footage', { ...base, hasVideo: true, datedCaptures: 1 }, 'footage'],
    ['video, two dates, volumes: dates by default', { ...base, hasVideo: true }, 'dates'],
    [
      'video, two dates, no volumes: footage by default',
      { ...base, hasVideo: true, hasVolumes: false },
      'footage',
    ],
    [
      'video, two dates, the choice wins',
      { ...base, hasVideo: true, pref: 'footage' as const },
      'footage',
    ],
    [
      'video, two dates, Dates chosen',
      { ...base, hasVideo: true, hasVolumes: false, pref: 'dates' as const },
      'dates',
    ],
  ])('%s', (_name, x, want) => {
    expect(bottomSlot(x)).toBe(want);
  });

  it('offers the switch only with video and two or more dates', () => {
    expect(offersSwitch({ hasVideo: true, datedCaptures: 2 })).toBe(true);
    expect(offersSwitch({ hasVideo: true, datedCaptures: 1 })).toBe(false);
    expect(offersSwitch({ hasVideo: false, datedCaptures: 3 })).toBe(false);
  });

  it('remembers the switch and the collapsed strip per project, dropping bad entries', () => {
    const storage = memory();
    const pref = createProjectChoice(BOTTOM_PREF_KEY, isBottomPref, storage);
    pref.getState().set('a', 'footage');
    expect(
      createProjectChoice(BOTTOM_PREF_KEY, isBottomPref, storage).getState().byProject,
    ).toEqual({ a: 'footage' });
    storage.setItem(BOTTOM_PREF_KEY, '{"a":"dates","b":"video"}');
    expect(
      createProjectChoice(BOTTOM_PREF_KEY, isBottomPref, storage).getState().byProject,
    ).toEqual({ a: 'dates' });
    const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
    const folded = createProjectChoice(DATES_COLLAPSED_KEY, isBool, storage);
    folded.getState().set('a', true);
    expect(JSON.parse(storage.getItem(DATES_COLLAPSED_KEY) ?? '{}')).toEqual({ a: true });
    expect(createProjectChoice(DATES_COLLAPSED_KEY, isBool, storage).getState().byProject.a).toBe(
      true,
    );
  });
});
