// @vitest-environment jsdom
import type { ChangePairContext } from '@aio/change';
import type { Layer, ProjectManifest, SitePoint, SurveyMeasurement } from '@aio/schema';
import { emptyMeasurements } from '@aio/schema';
import { actionsFor, makeActionCtx, type MenuTarget } from '@aio/ui';
import { captureIndex, workspace, type CaptureIndex } from '@aio/workspace';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoreApi } from 'zustand/vanilla';

interface Tl {
  index: CaptureIndex | null;
  focus: string | null;
}

vi.mock('../../shell', () => ({
  bridge: { call: () => Promise.resolve({ ok: false, error: 'Not configured' }) },
  shell: { getState: () => ({ screen: 'scene', go: vi.fn() }) },
}));

const tl = vi.hoisted(() => ({
  store: null as unknown as StoreApi<Tl>,
}));
vi.mock('../../workspace/timeline', async () => {
  const { createStore: make } = await import('zustand/vanilla');
  tl.store = make<Tl>(() => ({
    index: null,
    focus: null,
  }));
  return { timeline: tl.store };
});

const orthos = vi.hoisted(() => ({ on: true }));
vi.mock('../../change/producers/register', () => ({
  pairContext: (projectId: string, from: string, to: string): ChangePairContext => {
    const o = (id: string) =>
      ({ kind: 'raster', id, role: 'ortho', format: 'cog', src: { path: id } }) as Layer;
    return {
      projectId,
      manifest: {} as ProjectManifest,
      from,
      to,
      layersFrom: orthos.on ? [o(`o-${from}`)] : [],
      layersTo: orthos.on ? [o(`o-${to}`)] : [],
    };
  },
}));

const { registerAreaActions } = await import('./areaActions');
const { areaCompare } = await import('../../change/area/areaCompareStore');
const { measureStore } = await import('../../survey/measureStore');

const E0 = 500000;
const N0 = 3200000;

const capture = (id: string, date: string) => ({ id, label: id, date });
const twoDates = {
  captures: [capture('c1', '2026-09-01'), capture('c2', '2026-10-01')],
  layers: [],
  crs: { kind: 'epsg', epsg: 32639 },
  origin: { e: 0, n: 0, z: 0 },
} as unknown as ProjectManifest;
const oneDate = { ...twoDates, captures: [capture('c1', '2026-09-01')] } as ProjectManifest;

const m = (
  id: string,
  pts: [number, number][],
  over: Partial<SurveyMeasurement> = {},
): SurveyMeasurement => ({
  id,
  family: 'polygon',
  tool: 'area',
  label: id,
  scope: { kind: 'site' },
  items: [],
  results: [],
  points: pts.map(([e, n]): SitePoint => [E0 + e, N0 + n, 0]),
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

const square: [number, number][] = [
  [0, 0],
  [10, 0],
  [10, 10],
  [0, 10],
];
const bowTie: [number, number][] = [
  [0, 0],
  [10, 10],
  [10, 0],
  [0, 10],
];

const one = (id: string): MenuTarget => ({ kind: 'measurements', ids: [id], clicked: id });
const item = (
  target: MenuTarget,
  o: { pkg?: boolean; canEdit?: boolean; manifest?: ProjectManifest } = {},
) =>
  actionsFor(
    target,
    makeActionCtx({
      manifest: o.manifest ?? twoDates,
      pkg: o.pkg ?? false,
      canEdit: o.canEdit ?? true,
    }),
  ).find((i) => i.id === 'change.areaCompare');

function open(manifest: ProjectManifest) {
  workspace.getState().openProject({ id: 'p1', root: '/p1', manifest });
  tl.store.setState({ index: captureIndex(manifest), focus: null });
}

let off: () => void;
beforeEach(() => {
  off = registerAreaActions();
  orthos.on = true;
  open(twoDates);
  const file = {
    ...emptyMeasurements(),
    measurements: [
      m('pad', square),
      m('tie', bowTie),
      m('line', square.slice(0, 2), { family: 'line', tool: 'distance' }),
      m('pt', square.slice(0, 1), { family: 'point', tool: 'elevation' }),
    ],
  };
  measureStore.setState({
    file,
    savedText: JSON.stringify(file),
    projectId: 'p1',
    status: 'ready',
    readOnly: false,
  });
  areaCompare.getState().close();
});
afterEach(() => {
  off();
  workspace.getState().closeProject();
});

describe('compare with previous survey', () => {
  it('is offered for one polygon and enabled with two dated orthos', () => {
    const it0 = item(one('pad'));
    expect(it0?.label).toBe('Compare with previous survey');
    expect(it0?.section).toBe('compare');
    expect(it0?.disabled).toBe(false);
  });

  it('is not offered for a line, a point or several marked items', () => {
    expect(item(one('line'))).toBeUndefined();
    expect(item(one('pt'))).toBeUndefined();
    expect(item({ kind: 'measurements', ids: ['pad', 'tie'], clicked: 'pad' })).toBeUndefined();
  });

  it('is disabled with no earlier survey', () => {
    open(oneDate);
    expect(item(one('pad'), { manifest: oneDate })?.disabled).toBe('No earlier survey');
  });

  it('is disabled for a polygon that crosses itself', () => {
    expect(item(one('tie'))?.disabled).toBe('The polygon crosses itself.');
  });

  it('is disabled in a package', () => {
    expect(item(one('pad'), { pkg: true })?.disabled).toBe(
      'This is a package: its files stay inside it.',
    );
  });

  it('is disabled for a reviewer who may only look', () => {
    expect(item(one('pad'), { canEdit: false })?.disabled).toBe('This project can only be viewed.');
  });

  it('is disabled with its reason in a CRS this computer cannot convert, the menu intact', () => {
    const swiss = { ...twoDates, crs: { epsg: 2056 } } as ProjectManifest;
    open(swiss);
    const menu = actionsFor(one('pad'), makeActionCtx({ manifest: swiss }));
    expect(menu.length).toBeGreaterThan(0);
    expect(menu.find((i) => i.id === 'change.areaCompare')?.disabled).toBe(
      'EPSG:2056 cannot be converted on this computer, so the polygon cannot be placed on the map.',
    );
  });

  it('is disabled without an ortho on each date', () => {
    orthos.on = false;
    expect(item(one('pad'))?.disabled).toBe('Imagery change needs an ortho on each date.');
  });

  it('asks the confirm box for the previous pair', () => {
    item(one('pad'))?.run();
    expect(areaCompare.getState().request).toEqual({ measurementId: 'pad', from: 'c1', to: 'c2' });
  });
});
