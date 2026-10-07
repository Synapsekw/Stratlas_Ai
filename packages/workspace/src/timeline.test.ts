import type { Layer, ProjectManifest } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { captureIndex } from './captures';
import { createWorkspace } from './index';
import {
  clipStartMs,
  clockInClip,
  extrasOf,
  followLayer,
  initialFocus,
  layerDate,
  openChange,
  snapshotPref,
  stepCapture,
  swapChange,
  visibleIn,
} from './timeline';

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
const ortho = (id: string, capture?: string): Layer => ({
  kind: 'raster',
  id,
  name: id,
  visible: true,
  capture,
  role: 'ortho',
  format: 'kit-pyramid',
  src: { path: `rasters/${id}/tiles.json` },
});

const manifest: ProjectManifest = {
  schema: 'aio.project/1',
  id: 'p',
  name: 'P',
  crs: { epsg: 32640 },
  origin: [0, 0, 0],
  captures: [
    { id: 'sep', label: 'Survey 4 Sep', date: '2024-09-04' },
    { id: 'oct', label: 'Survey 2 Oct', date: '2024-10-02' },
    { id: 'nov', label: 'Survey 6 Nov', date: '2024-11-06' },
  ],
  layers: [
    mesh('model-sep', 'sep'),
    ortho('ortho-sep', 'sep'),
    mesh('model-oct', 'oct'),
    ortho('ortho-oct', 'oct'),
    mesh('model-nov', 'nov'),
    ortho('ortho-nov', 'nov'),
    ortho('design'),
  ],
} as ProjectManifest;
const index = captureIndex(manifest);
const none: Record<string, true> = {};

describe('initialFocus', () => {
  it('keeps a saved focus that still exists', () => {
    expect(initialFocus(index, 'oct')).toBe('oct');
  });
  it('falls back to the latest date for unknown or missing saved focus', () => {
    expect(initialFocus(index, 'gone')).toBe('nov');
    expect(initialFocus(index, undefined)).toBe('nov');
  });
  it('is null without captures', () => {
    expect(initialFocus(captureIndex({ captures: [], layers: [] }), undefined)).toBeNull();
  });
});

describe('openChange', () => {
  it('first open: focused date and Every date on, other dates off', () => {
    const c = openChange(index, none, 'nov', {});
    expect(c.show.sort()).toEqual(['model-nov', 'ortho-nov']);
    expect(c.hide.sort()).toEqual(['model-oct', 'model-sep', 'ortho-oct', 'ortho-sep']);
  });
  it('first open honours layers already hidden in the focused date', () => {
    const c = openChange(index, { 'ortho-nov': true }, 'nov', {});
    expect(c.hide).toContain('ortho-nov');
  });
  it('saved pref: remembered hides and extras', () => {
    const c = openChange(index, none, 'nov', {
      remembered: { nov: ['ortho-nov'] },
      extras: ['ortho-sep', 'gone'],
    });
    expect(c.show.sort()).toEqual(['model-nov', 'ortho-sep']);
    expect(c.hide).toContain('ortho-nov');
    expect(c.hide).not.toContain('design');
  });
});

describe('swapChange', () => {
  it('hides the old date, shows the new one, keeps extras', () => {
    const hidden = { 'model-sep': true, 'model-oct': true, 'ortho-oct': true } as const;
    // focus nov, extra ortho-sep visible
    const { change, remembered } = swapChange(index, hidden, 'nov', 'oct', {});
    expect(change.hide.sort()).toEqual(['model-nov', 'ortho-nov']);
    expect(change.show.sort()).toEqual(['model-oct', 'ortho-oct']);
    expect(change.hide).not.toContain('ortho-sep');
    expect(remembered.nov).toEqual([]);
  });
  it('remembers hides of the date being left and restores them on return', () => {
    const hidden = {
      'ortho-nov': true,
      'model-oct': true,
      'ortho-oct': true,
      'model-sep': true,
      'ortho-sep': true,
    } as const;
    const out = swapChange(index, hidden, 'nov', 'oct', {});
    expect(out.remembered.nov).toEqual(['ortho-nov']);
    const back = swapChange(
      index,
      { 'ortho-nov': true, 'model-nov': true },
      'oct',
      'nov',
      out.remembered,
    );
    expect(back.change.show).toEqual(['model-nov']);
  });
  it('an extra of the new date stays visible (promoted into focus)', () => {
    const hidden = { 'model-oct': true } as const; // ortho-oct visible as an extra
    const { change } = swapChange(index, hidden, 'nov', 'oct', { oct: ['ortho-oct'] });
    expect(change.hide).not.toContain('ortho-oct');
  });
  it('same date is a no-op', () => {
    expect(swapChange(index, none, 'nov', 'nov', {}).change).toEqual({ show: [], hide: [] });
  });
  it('never touches Every date layers', () => {
    const { change } = swapChange(index, none, 'nov', 'oct', {});
    expect([...change.show, ...change.hide]).not.toContain('design');
  });
});

describe('extrasOf, visibleIn, snapshotPref', () => {
  const hidden = { 'model-sep': true, 'model-oct': true, 'ortho-oct': true } as const;
  it('extras are visible layers of non-focused dates', () => {
    expect(extrasOf(index, hidden, 'nov')).toEqual(['ortho-sep']);
  });
  it('counts visible layers per date', () => {
    expect(visibleIn(index, hidden, 'sep')).toBe(1);
    expect(visibleIn(index, hidden, 'oct')).toBe(0);
  });
  it('snapshot records the focused date hides and drops unknown dates', () => {
    const p = snapshotPref(index, { ...hidden, 'ortho-nov': true }, 'nov', {
      gone: ['x'],
      oct: ['ortho-oct'],
    });
    expect(p).toEqual({
      focus: 'nov',
      remembered: { oct: ['ortho-oct'], nov: ['ortho-nov'] },
      extras: ['ortho-sep'],
    });
  });
});

describe('stepCapture', () => {
  it('steps in date order and stops at the ends', () => {
    expect(stepCapture(index, 'oct', -1)).toBe('sep');
    expect(stepCapture(index, 'oct', 1)).toBe('nov');
    expect(stepCapture(index, 'nov', 1)).toBeNull();
    expect(stepCapture(index, 'sep', -1)).toBeNull();
  });
  it('without focus starts from the latest date', () => {
    expect(stepCapture(index, null, -1)).toBe('nov');
  });
});

describe('followLayer', () => {
  it('maps to the counterpart on the next date', () => {
    expect(followLayer(index, manifest.layers, 'ortho-nov', 'oct')).toBe('ortho-oct');
  });
  it('keeps undated layers', () => {
    expect(followLayer(index, manifest.layers, 'design', 'oct')).toBe('design');
  });
  it('falls back to the first layer of the same kind', () => {
    const m = { ...manifest, layers: [...manifest.layers, mesh('extra-scan-nov', 'nov')] };
    const ix = captureIndex(m);
    expect(followLayer(ix, m.layers, 'extra-scan-nov', 'sep')).toBe('model-sep');
  });
  it('is undefined when the next date has no layer of that kind', () => {
    const m = { ...manifest, layers: manifest.layers.filter((l) => l.id !== 'model-sep') };
    expect(followLayer(captureIndex(m), m.layers, 'model-nov', 'sep')).toBeUndefined();
  });
});

describe('layerDate', () => {
  it('returns the ISO date of the layer survey', () => {
    expect(layerDate(manifest, 'ortho-oct')).toBe('2024-10-02');
    expect(layerDate(manifest, 'design')).toBeUndefined();
  });
});

describe('applyVisibility', () => {
  it('shows and hides in one update', () => {
    const ws = createWorkspace();
    ws.getState().openProject({ id: 'p', root: '/p', manifest });
    let updates = 0;
    ws.subscribe(() => (updates += 1));
    ws.getState().applyVisibility(['model-nov'], ['ortho-nov', 'design']);
    expect(updates).toBe(1);
    expect(ws.getState().hidden).toEqual({ 'ortho-nov': true, design: true });
  });
  it('does nothing for an empty change', () => {
    const ws = createWorkspace();
    let updates = 0;
    ws.subscribe(() => (updates += 1));
    ws.getState().applyVisibility([], []);
    expect(updates).toBe(0);
  });
});

describe('clipStartMs, clockInClip', () => {
  const clip = (startUtcMs: number, offsetMs = 0) => ({ flight: { startUtcMs }, offsetMs });

  it('starts a clip at its flight start plus the calibration offset', () => {
    expect(clipStartMs(clip(10_000, -500))).toBe(9_500);
  });

  it('keeps the playhead offset from the old clip in the new one', () => {
    expect(clockInClip(clip(10_000), clip(50_000), 14_000)).toBe(54_000);
  });

  it('clamps the offset into the new clip when its length is known', () => {
    expect(clockInClip(clip(10_000), clip(50_000), 14_000, 3_000)).toBe(53_000);
    expect(clockInClip(clip(10_000), clip(50_000), 14_000, undefined)).toBe(54_000);
  });

  it('starts the new clip at its start without an old clip or before the old start', () => {
    expect(clockInClip(undefined, clip(50_000, 200), 14_000)).toBe(50_200);
    expect(clockInClip(clip(10_000), clip(50_000), 2_000)).toBe(50_000);
  });
});
