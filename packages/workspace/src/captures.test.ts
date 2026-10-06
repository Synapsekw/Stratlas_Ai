import type { Layer, ProjectManifest } from '@aio/schema';
import { describe, expect, it, vi } from 'vitest';
import {
  canCompare,
  captureHidden,
  captureIndex,
  captureSelection,
  counterpart,
  dateSpellings,
  knownCapture,
  scopedStore,
  type StoreScope,
} from './captures';
import { createWorkspace } from './index';

const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

const mesh = (id: string, name: string, nodes: string[] = []): Layer => ({
  kind: 'mesh',
  id,
  name,
  visible: true,
  src: { path: `models/${id}.glb` },
  transform: I,
  tags: nodes.map((n) => ({ node: n, tag: n })),
});
const ortho = (id: string, name: string): Layer => ({
  kind: 'raster',
  id,
  name,
  visible: true,
  role: 'ortho',
  format: 'kit-pyramid',
  src: { path: `rasters/${id}/tiles.json` },
});

/** Masafi as imported: two surveys, a terrain and an ortho each, plus the legacy viewer. */
const masafi: ProjectManifest = {
  schema: 'aio.project/1',
  id: 'masafi',
  name: 'Masafi',
  crs: { epsg: 32640 },
  origin: [0, 0, 0],
  captures: [
    { id: 'survey-2021-01-10', label: 'Drone survey 10 Jan 2021', date: '2021-01-10' },
    { id: 'survey-2020-12-31', label: 'Drone survey 31 Dec 2020', date: '2020-12-31' },
  ],
  layers: [
    mesh('terrain-2021-01-10', 'Terrain 10 Jan 2021', ['P01_e2', 'P02_e2']),
    mesh('terrain-2020-12-31', 'Terrain 31 Dec 2020', ['P01_e1', 'P02_e1']),
    ortho('ortho-2021-01-10', 'Ortho 10 Jan 2021'),
    ortho('ortho-2020-12-31', 'Ortho 31 Dec 2020'),
    {
      kind: 'legacy',
      id: 'volumetric-review',
      name: 'Stockpile review',
      visible: true,
      viewer: 'volumetric',
      entry: { path: 'legacy/x.html' },
    },
  ],
  severityModels: [],
  classCatalogues: [],
};

/** Al-Zour has one survey; the synthetic second date is a copy of its ortho named by date. */
const alzour: ProjectManifest = {
  ...masafi,
  id: 'alzour',
  captures: [{ id: 'survey-2023-02-21', label: 'Drone survey', date: '2023-02-21' }],
  layers: [
    mesh('plant', 'Plant model (as-built plot plans)'),
    ortho('ortho', 'Drone orthomosaic, 21 Feb 2023'),
    ortho('plot-plan', 'Overall plot plan'),
  ],
};
const alzour2: ProjectManifest = {
  ...alzour,
  captures: [
    ...alzour.captures,
    { id: 'survey-2023-08-30', label: 'Synthetic resurvey', date: '2023-08-30' },
  ],
  layers: [...alzour.layers, ortho('ortho-20230830', 'Drone orthomosaic, 30 Aug 2023')],
};

describe('which layers show which capture', () => {
  it('spells a date the ways layer names write it', () => {
    const s = dateSpellings('2020-12-31');
    for (const x of ['2020-12-31', '20201231', '31 dec 2020', '31 december 2020', 'dec 31, 2020'])
      expect(s).toContain(x);
    expect(dateSpellings('2021-01-10')).toContain('10 jan 2021');
  });

  it('dates the Masafi terrains and orthos and orders the captures oldest first', () => {
    const ix = captureIndex(masafi);
    expect(ix.captures.map((c) => c.date)).toEqual(['2020-12-31', '2021-01-10']);
    expect(ix.layers['survey-2020-12-31']).toEqual(['terrain-2020-12-31', 'ortho-2020-12-31']);
    expect(ix.layers['survey-2021-01-10']).toEqual(['terrain-2021-01-10', 'ortho-2021-01-10']);
    expect(ix.of['volumetric-review']).toBeUndefined();
    // the survey keys come from the pile nodes
    expect(ix.epochs).toEqual({ 'survey-2020-12-31': 'e1', 'survey-2021-01-10': 'e2' });
    expect(ix.slot['terrain-2020-12-31']).toBe(ix.slot['terrain-2021-01-10']);
    expect(ix.slot['ortho-2020-12-31']).toBe(ix.slot['ortho-2021-01-10']);
    expect(ix.slot['ortho-2020-12-31']).not.toBe(ix.slot['terrain-2020-12-31']);
    expect(canCompare(ix)).toBe(true);
  });

  it('takes explicit layer lists and survey keys first (volumes.json)', () => {
    const ix = captureIndex(masafi, {
      layers: { 'survey-2020-12-31': ['ortho-2021-01-10'] },
      epochs: { 'survey-2020-12-31': 'a', 'survey-2021-01-10': 'b' },
    });
    expect(ix.of['ortho-2021-01-10']).toBe('survey-2020-12-31');
    expect(ix.epochs['survey-2020-12-31']).toBe('a');
  });

  it('offers nothing to compare with one capture, and a synthetic second one makes it so', () => {
    const one = captureIndex(alzour);
    expect(one.of).toEqual({});
    expect(canCompare(one)).toBe(false);
    const two = captureIndex(alzour2);
    expect(two.of).toEqual({ ortho: 'survey-2023-02-21', 'ortho-20230830': 'survey-2023-08-30' });
    expect(two.of.plant).toBeUndefined();
    expect(canCompare(two)).toBe(true);
    expect(counterpart(two, 'ortho', 'survey-2023-08-30')).toBe('ortho-20230830');
    expect(counterpart(two, 'plant', 'survey-2023-08-30')).toBe('plant');
  });

  it('never dates a layer that names two captures, or text glued to other digits', () => {
    const m: ProjectManifest = {
      ...alzour2,
      layers: [
        ortho('diff', 'Change 21 Feb 2023 to 30 Aug 2023'),
        ortho('x', 'Tile 120230830x'),
        ...alzour2.layers,
      ],
    };
    const ix = captureIndex(m);
    expect(ix.of.diff).toBeUndefined();
    expect(ix.of.x).toBeUndefined();
  });

  it('falls back to the first or last date', () => {
    const ix = captureIndex(masafi);
    expect(knownCapture(ix, undefined, 'first')).toBe('survey-2020-12-31');
    expect(knownCapture(ix, 'gone', 'last')).toBe('survey-2021-01-10');
    expect(knownCapture(ix, 'survey-2021-01-10', 'first')).toBe('survey-2021-01-10');
  });
});

describe('a view of one capture', () => {
  const ix = captureIndex(masafi);
  const e1 = 'survey-2020-12-31';
  const e2 = 'survey-2021-01-10';

  it('hides the other date and shows its own while any date of the slot is shown', () => {
    // the volumetric workspace shows 10 Jan: the 31 Dec layers are switched off
    const hidden = { 'terrain-2020-12-31': true, 'ortho-2020-12-31': true } as const;
    expect(captureHidden(ix, e1, masafi.layers, hidden)).toEqual({
      'terrain-2021-01-10': true,
      'ortho-2021-01-10': true,
    });
    expect(captureHidden(ix, e2, masafi.layers, hidden)).toEqual(hidden);
    // the ortho switched off for every date stays off in both views
    const noOrtho = { ...hidden, 'ortho-2021-01-10': true } as const;
    expect(captureHidden(ix, e1, masafi.layers, noOrtho)['ortho-2020-12-31']).toBe(true);
    // common layers follow the layer tree
    expect(captureHidden(ix, e1, masafi.layers, { 'volumetric-review': true })).toMatchObject({
      'volumetric-review': true,
    });
  });

  it('maps a pile picked on one date to the same pile on the other', () => {
    const sel = { kind: 'asset' as const, id: 'P01_e2', layer: 'terrain-2021-01-10' };
    expect(captureSelection(ix, e1, sel)).toEqual({
      kind: 'asset',
      id: 'P01_e1',
      layer: 'terrain-2020-12-31',
    });
    expect(captureSelection(ix, e2, sel)).toBe(sel);
    const issue = { kind: 'issue' as const, id: 'i1' };
    expect(captureSelection(ix, e1, issue)).toBe(issue);
  });
});

describe('scoped store', () => {
  const ix = captureIndex(masafi);
  const scope = (capture: string, mode: StoreScope['mode'], camera = true): StoreScope => ({
    capture,
    index: ix,
    mode,
    camera,
  });

  it('is the workspace itself without a scope', () => {
    const ws = createWorkspace();
    ws.getState().openProject({ id: 'masafi', root: 'r', manifest: masafi });
    const s = scopedStore(ws);
    expect(s.getState()).toBe(ws.getState());
  });

  it('drops other dates in a second view and keeps identities across clock ticks', () => {
    const ws = createWorkspace();
    ws.getState().openProject({ id: 'masafi', root: 'r', manifest: masafi });
    const s = scopedStore(ws, scope('survey-2020-12-31', 'drop'));
    const a = s.getState();
    expect(a.project?.manifest.layers.map((l) => l.id)).toEqual([
      'terrain-2020-12-31',
      'ortho-2020-12-31',
      'volumetric-review',
    ]);
    const seen = vi.fn();
    const off = s.subscribe(seen);
    ws.getState().setTime(1000);
    const b = s.getState();
    expect(b.nowMs).toBe(1000);
    expect(b.project).toBe(a.project);
    expect(b.hidden).toBe(a.hidden);
    expect(seen).toHaveBeenCalledTimes(1);
    const [next, prev] = seen.mock.calls[0] as [typeof b, typeof a];
    expect(next.project).toBe(prev.project);
    off();
  });

  it('keeps every layer in a hide view and switches the date on a scope change', () => {
    const ws = createWorkspace();
    ws.getState().openProject({ id: 'masafi', root: 'r', manifest: masafi });
    const s = scopedStore(ws, scope('survey-2020-12-31', 'hide'));
    expect(s.getState().project).toBe(ws.getState().project);
    expect(s.getState().hidden['terrain-2021-01-10']).toBe(true);
    expect(s.getState().hidden['terrain-2020-12-31']).toBeUndefined();
    const seen = vi.fn();
    s.subscribe(seen);
    s.setScope(scope('survey-2021-01-10', 'hide'));
    expect(seen).toHaveBeenCalledTimes(1);
    expect(s.getState().hidden['terrain-2020-12-31']).toBe(true);
    s.setScope(null);
    expect(s.getState()).toBe(ws.getState());
  });

  it('writes through to the workspace and holds back camera requests when linked', () => {
    const ws = createWorkspace();
    ws.getState().openProject({ id: 'masafi', root: 'r', manifest: masafi });
    const s = scopedStore(ws, scope('survey-2020-12-31', 'drop', false));
    s.getState().select({ kind: 'asset', id: 'P02_e1', layer: 'terrain-2020-12-31' });
    expect(ws.getState().selection?.id).toBe('P02_e1');
    ws.getState().select({ kind: 'asset', id: 'P02_e2', layer: 'terrain-2021-01-10' });
    expect(s.getState().selection).toEqual({
      kind: 'asset',
      id: 'P02_e1',
      layer: 'terrain-2020-12-31',
    });
    ws.getState().flyTo({ kind: 'home' });
    expect(ws.getState().camera).not.toBeNull();
    expect(s.getState().camera).toBeNull();
  });
});

describe('explicit layer dates (M8, Layer.capture)', () => {
  /** A synthetic two-date site: the names say nothing, or the wrong thing, about the date. */
  const site: ProjectManifest = {
    ...masafi,
    id: 'synthetic-site',
    captures: [
      { id: 'd1', label: 'First survey', date: '2026-03-01' },
      { id: 'd2', label: 'Second survey', date: '2026-09-01' },
    ],
    layers: [
      { ...ortho('ortho-a', 'Site ortho'), capture: 'd1' },
      { ...ortho('ortho-b', 'Site ortho'), capture: 'd2' },
      // the name says the first date, the explicit capture says the second
      { ...mesh('model-x', 'Model 1 Mar 2026'), capture: 'd2' },
      mesh('model-y', 'Model 1 Mar 2026'),
      ortho('plan', 'Plot plan'),
    ],
  };

  it('puts a layer on its explicit capture whatever its name says', () => {
    const ix = captureIndex(site);
    expect(ix.of['ortho-a']).toBe('d1');
    expect(ix.of['ortho-b']).toBe('d2');
    expect(ix.of['model-x']).toBe('d2');
    // names still date the layers without an explicit capture
    expect(ix.of['model-y']).toBe('d1');
    expect(ix.of.plan).toBeUndefined();
    expect(canCompare(ix)).toBe(true);
    // same name on both dates: counterparts
    expect(counterpart(ix, 'ortho-a', 'd2')).toBe('ortho-b');
  });

  it('wins over the explicit lists of volumes.json, and ignores an unknown capture', () => {
    const ix = captureIndex(
      {
        ...site,
        layers: [...site.layers, { ...ortho('stray', 'Stray ortho'), capture: 'gone' }],
      },
      { layers: { d1: ['ortho-b'] } },
    );
    expect(ix.of['ortho-b']).toBe('d2');
    expect(ix.layers.d1).not.toContain('ortho-b');
    // an id the manifest does not list falls back to the naming rules (common here)
    expect(ix.of.stray).toBeUndefined();
  });

  it('dates a layer explicitly even with one capture', () => {
    const first = site.captures[0];
    if (!first) throw new Error('fixture');
    const ix = captureIndex({ ...site, captures: [first] });
    expect(ix.of['ortho-a']).toBe('d1');
  });
});
