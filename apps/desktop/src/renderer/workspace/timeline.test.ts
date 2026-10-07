import type { Layer, ProjectManifest } from '@aio/schema';
import { captureIndex, createWorkspace, type DatePref } from '@aio/workspace';
import { describe, expect, it } from 'vitest';
import { TIMELINE_KEY, createTimelineStore } from './timeline';

const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const mesh = (id: string, capture?: string): Layer => ({
  kind: 'mesh',
  id,
  name: id,
  visible: true,
  capture,
  src: { path: `models/${id}.glb` },
  transform: I,
});
const video = (id: string, capture: string): Layer =>
  ({
    kind: 'video',
    id,
    name: id,
    visible: true,
    capture,
    src: { path: `video/${id}.mp4` },
    flight: { startUtcMs: 0 },
    offsetMs: 0,
  }) as unknown as Layer;

const manifest = {
  schema: 'aio.project/1',
  id: 'p',
  name: 'P',
  crs: { epsg: 32640 },
  origin: [0, 0, 0],
  captures: [
    { id: 'sep', label: 'Sep', date: '2024-09-04' },
    { id: 'oct', label: 'Oct', date: '2024-10-02' },
    { id: 'nov', label: 'Nov', date: '2024-11-06' },
  ],
  layers: [
    mesh('model-sep', 'sep'),
    mesh('model-oct', 'oct'),
    mesh('model-nov', 'nov'),
    video('clip-sep', 'sep'),
    video('clip-oct', 'oct'),
    video('clip-nov', 'nov'),
    mesh('site'),
  ],
} as unknown as ProjectManifest;

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

function setup(saved?: unknown) {
  const ws = createWorkspace();
  const storage = new MemoryStorage();
  if (saved) storage.setItem(TIMELINE_KEY, JSON.stringify(saved));
  ws.getState().openProject({ id: 'p', root: '/p', manifest });
  const tl = createTimelineStore(ws, storage);
  const index = captureIndex(manifest);
  return { ws, tl, storage, index };
}

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
});
