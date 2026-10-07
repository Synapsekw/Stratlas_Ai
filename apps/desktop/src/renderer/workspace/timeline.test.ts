import type { Issue, ProjectManifest } from '@aio/schema';
import { captureIndex, createWorkspace, type DatePref } from '@aio/workspace';
import { describe, expect, it } from 'vitest';
import { threeDates } from './__fixtures__/threeDates';
import { TIMELINE_KEY, createTimelineStore } from './timeline';

const manifest = threeDates;

class MemoryStorage {
  data = new Map<string, string>();
  getItem(k: string) {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.data.set(k, v);
  }
  removeItem(k: string) {
    this.data.delete(k);
  }
  clear() {
    this.data.clear();
  }
  key() {
    return null;
  }
  get length() {
    return this.data.size;
  }
}

function setup(
  saved?: unknown,
  m: ProjectManifest = manifest,
  durations: Record<string, number> = {},
) {
  const ws = createWorkspace();
  const storage = new MemoryStorage();
  if (saved) storage.setItem(TIMELINE_KEY, JSON.stringify(saved));
  ws.getState().openProject({ id: 'p', root: '/p', manifest: m });
  const tl = createTimelineStore(ws, storage, (id) => durations[id]);
  const index = captureIndex(m);
  return { ws, tl, storage, index };
}

/** The three-date fixture with each date's clip flown on its own day. */
const START = { sep: 1_000_000, oct: 2_000_000, nov: 3_000_000 } as const;
const timed = {
  ...manifest,
  layers: manifest.layers.map((l) =>
    l.kind === 'video' && l.capture
      ? { ...l, flight: { ...l.flight, startUtcMs: START[l.capture as keyof typeof START] } }
      : l,
  ),
} as ProjectManifest;

describe('timeline store', () => {
  it('attach focuses the latest date and hides other dates', () => {
    const { ws, tl, index } = setup();
    tl.getState().attach('p', index);
    expect(tl.getState().focus).toBe('nov');
    expect(Object.keys(ws.getState().hidden).sort()).toEqual([
      'clip-oct',
      'clip-sep',
      'model-oct',
      'model-sep',
    ]);
  });

  it('attach restores a saved focus and extras', () => {
    const { ws, tl, index } = setup({ p: { focus: 'oct', remembered: {}, extras: ['model-sep'] } });
    tl.getState().attach('p', index);
    expect(tl.getState().focus).toBe('oct');
    expect(ws.getState().hidden['model-sep']).toBeUndefined();
    expect(ws.getState().hidden['model-nov']).toBe(true);
  });

  it('attach for the same project with a new index keeps focus and visibility', () => {
    const { ws, tl, index } = setup();
    tl.getState().attach('p', index);
    tl.getState().focusSurvey('oct');
    ws.getState().setLayerVisible('model-sep', true);
    const before = ws.getState().hidden;
    tl.getState().attach('p', captureIndex({ ...manifest }));
    expect(tl.getState().focus).toBe('oct');
    expect(ws.getState().hidden).toEqual(before);
  });

  it('focusSurvey swaps dates and keeps a hand-picked extra', () => {
    const { ws, tl, index } = setup();
    tl.getState().attach('p', index);
    ws.getState().setLayerVisible('model-sep', true); // extra
    tl.getState().focusSurvey('oct');
    const h = ws.getState().hidden;
    expect(h['model-nov']).toBe(true);
    expect(h['model-oct']).toBeUndefined();
    expect(h['model-sep']).toBeUndefined();
  });

  it('focusSurvey moves the active clip of the old date to the new date', () => {
    const { ws, tl, index } = setup();
    tl.getState().attach('p', index);
    ws.getState().setActiveClip('clip-nov');
    tl.getState().focusSurvey('oct');
    expect(ws.getState().activeClip).toBe('clip-oct');
  });

  it('focusSurvey leaves an active clip from a third date alone', () => {
    const { ws, tl, index } = setup();
    tl.getState().attach('p', index);
    ws.getState().setActiveClip('clip-sep');
    tl.getState().focusSurvey('oct');
    expect(ws.getState().activeClip).toBe('clip-sep');
  });

  it('step walks dates and stops at the ends', () => {
    const { tl, index } = setup();
    tl.getState().attach('p', index);
    tl.getState().step(1);
    expect(tl.getState().focus).toBe('nov');
    tl.getState().step(-1);
    tl.getState().step(-1);
    tl.getState().step(-1);
    expect(tl.getState().focus).toBe('sep');
  });

  it('persists focus, remembered and extras per project', () => {
    const { ws, tl, storage, index } = setup();
    tl.getState().attach('p', index);
    ws.getState().setLayerVisible('model-sep', true);
    tl.getState().focusSurvey('oct');
    const saved = JSON.parse(storage.getItem(TIMELINE_KEY) ?? '{}') as Record<string, DatePref>;

    expect(saved.p?.focus).toBe('oct');
    expect(saved.p?.extras).toContain('model-sep');
  });

  it('ignores unknown dates and projects without dates', () => {
    const { tl, index } = setup();
    tl.getState().attach('p', index);
    tl.getState().focusSurvey('gone');
    expect(tl.getState().focus).toBe('nov');
    tl.getState().attach('q', captureIndex({ captures: [], layers: [] }));
    expect(tl.getState().focus).toBeNull();
  });

  it('does not overwrite a project pref when another project opens or the project closes', () => {
    const { ws, tl, storage, index } = setup();
    tl.getState().attach('p', index);
    tl.getState().focusSurvey('oct');
    const saved = storage.getItem(TIMELINE_KEY);

    ws.getState().openProject({ id: 'other', root: '/o', manifest: { ...manifest, id: 'other' } });
    expect(storage.getItem(TIMELINE_KEY)).toBe(saved);
    ws.getState().closeProject();
    expect(storage.getItem(TIMELINE_KEY)).toBe(saved);
    tl.getState().attach(null, null); // what useTimelineSync does after a close

    ws.getState().openProject({ id: 'p', root: '/p', manifest });
    tl.getState().attach('p', captureIndex(manifest));
    expect(tl.getState().focus).toBe('oct');
    expect(ws.getState().hidden['model-nov']).toBe(true);
    expect(ws.getState().hidden['model-oct']).toBeUndefined();
  });

  it('writes the new project pref, not the old one, when attach switches projects', () => {
    const { ws, tl, storage, index } = setup();
    tl.getState().attach('p', index);
    ws.getState().openProject({ id: 'q', root: '/q', manifest: { ...manifest, id: 'q' } });
    tl.getState().attach('q', captureIndex({ ...manifest }));
    const saved = JSON.parse(storage.getItem(TIMELINE_KEY) ?? '{}') as Record<string, DatePref>;
    expect(saved.q?.focus).toBe('nov');
    expect(saved.p?.focus).toBe('nov');
    expect(saved.p?.extras ?? []).toEqual([]);
  });

  it('reopening the same project re-applies its saved pref and keeps it unchanged', () => {
    const { ws, tl, storage, index } = setup();
    tl.getState().attach('p', index);
    tl.getState().focusSurvey('oct');
    const saved = storage.getItem(TIMELINE_KEY);

    // Projects screen: the same project is opened again with a freshly read manifest and the
    // workspace screen never re-rendered with a null project in between.
    const fresh = { ...manifest } as ProjectManifest;
    ws.getState().openProject({ id: 'p', root: '/p', manifest: fresh });
    expect(Object.keys(ws.getState().hidden)).toEqual([]);
    expect(storage.getItem(TIMELINE_KEY)).toBe(saved);
    tl.getState().attach('p', captureIndex(fresh));

    expect(tl.getState().focus).toBe('oct');
    expect(ws.getState().hidden['model-nov']).toBe(true);
    expect(ws.getState().hidden['model-sep']).toBe(true);
    expect(ws.getState().hidden['model-oct']).toBeUndefined();
    expect(storage.getItem(TIMELINE_KEY)).toBe(saved);
  });

  it('replaceManifest while open keeps focus and visibility untouched', () => {
    const { ws, tl, storage, index } = setup();
    tl.getState().attach('p', index);
    tl.getState().focusSurvey('oct');
    ws.getState().setLayerVisible('model-sep', true);
    const hidden = ws.getState().hidden;
    const saved = storage.getItem(TIMELINE_KEY);

    const next = { ...manifest } as ProjectManifest;
    ws.getState().replaceManifest(next);
    tl.getState().attach('p', captureIndex(next));

    expect(tl.getState().focus).toBe('oct');
    expect(ws.getState().hidden).toEqual(hidden);
    expect(storage.getItem(TIMELINE_KEY)).toBe(saved);
  });

  it('an issue edit before replaceManifest does not make the next attach a fresh open', () => {
    const { ws, tl, storage, index } = setup();
    tl.getState().attach('p', index);
    tl.getState().focusSurvey('oct');
    ws.getState().setLayerVisible('model-sep', true);
    const hidden = ws.getState().hidden;
    const saved = storage.getItem(TIMELINE_KEY);

    ws.getState().upsertIssue({ id: 'i1' } as unknown as Issue);
    const next = { ...manifest } as ProjectManifest;
    ws.getState().replaceManifest(next);
    tl.getState().attach('p', captureIndex(next));

    expect(tl.getState().focus).toBe('oct');
    expect(ws.getState().hidden).toEqual(hidden);
    expect(storage.getItem(TIMELINE_KEY)).toBe(saved);
  });

  it('a fresh attach moves the video off a hidden date onto the focused one, at its start', () => {
    const { ws, tl, index } = setup(undefined, timed);
    // openProject picks the manifest's first clip, the oldest date
    expect(ws.getState().activeClip).toBe('clip-sep');
    tl.getState().attach('p', index);
    expect(ws.getState().activeClip).toBe('clip-nov');
    expect(ws.getState().nowMs).toBe(START.nov);
  });

  it('a fresh attach on a saved focus plays that date', () => {
    const { ws, tl, index } = setup({ p: { focus: 'oct' } }, timed);
    tl.getState().attach('p', index);
    expect(ws.getState().activeClip).toBe('clip-oct');
    expect(ws.getState().nowMs).toBe(START.oct);
  });

  it('a fresh attach leaves the video alone when the focused date has none', () => {
    const noNovClip = {
      ...timed,
      layers: timed.layers.filter((l) => l.id !== 'clip-nov'),
    } as ProjectManifest;
    const { ws, tl, index } = setup(undefined, noNovClip);
    tl.getState().attach('p', index);
    expect(ws.getState().activeClip).toBe('clip-sep');
    expect(ws.getState().nowMs).toBe(START.sep);
  });

  it('focusSurvey moves the clock into the new clip at the same offset', () => {
    const { ws, tl, index } = setup(undefined, timed);
    tl.getState().attach('p', index);
    ws.getState().setTime(START.nov + 5_000);
    tl.getState().focusSurvey('oct');
    expect(ws.getState().activeClip).toBe('clip-oct');
    expect(ws.getState().nowMs).toBe(START.oct + 5_000);
  });

  it('focusSurvey clamps the offset into a shorter clip', () => {
    const { ws, tl, index } = setup(undefined, timed, { 'clip-oct': 3_000 });
    tl.getState().attach('p', index);
    ws.getState().setTime(START.nov + 5_000);
    tl.getState().focusSurvey('oct');
    expect(ws.getState().activeClip).toBe('clip-oct');
    expect(ws.getState().nowMs).toBe(START.oct + 3_000);
  });

  it('focusSurvey does nothing while the workspace shows another project', () => {
    const { ws, tl, storage, index } = setup();
    tl.getState().attach('p', index);
    const saved = storage.getItem(TIMELINE_KEY);
    // another project opened, the timeline not yet re-attached
    ws.getState().openProject({ id: 'q', root: '/q', manifest: { ...manifest, id: 'q' } });
    const hidden = ws.getState().hidden;
    tl.getState().focusSurvey('oct');
    expect(tl.getState().focus).toBe('nov');
    expect(ws.getState().hidden).toBe(hidden);
    expect(storage.getItem(TIMELINE_KEY)).toBe(saved);
  });

  it('reads a corrupted saved entry without throwing and keeps the good fields', () => {
    const { ws, tl, index } = setup({
      p: { focus: 7, remembered: { oct: 'model-oct', nov: 5, sep: ['model-sep', 3] }, extras: 'x' },
      q: 'nonsense',
    });
    expect(() => {
      tl.getState().attach('p', index);
    }).not.toThrow();
    expect(tl.getState().focus).toBe('nov');
    expect(tl.getState().byProject.q).toBeUndefined();
    tl.getState().focusSurvey('oct');
    tl.getState().focusSurvey('nov');
    // the malformed remembered entry for oct was dropped: oct's model shows when focused
    tl.getState().focusSurvey('oct');
    expect(ws.getState().hidden['model-oct']).toBeUndefined();
  });

  it('keeps a well-formed saved entry as it is', () => {
    const pref = { focus: 'oct', remembered: { oct: ['model-oct'] }, extras: ['model-sep'] };
    const { tl } = setup({ p: pref });
    expect(tl.getState().byProject.p).toEqual(pref);
  });
});
