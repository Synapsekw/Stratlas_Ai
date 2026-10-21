// @vitest-environment jsdom
import type { ProjectManifest, SurveyMeasurement } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const look = vi.hoisted(() => ({ only: false }));
vi.mock('@aio/annotate', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useAnnotateReadOnly: () => look.only,
}));

const history = vi.hoisted(() => ({
  rows: [] as { capture: string; label: string; date: string; z: number | null }[],
  asked: [] as [number, number][],
  fail: false,
  /** Reading a prepared surface's tiles for the terrain rows fails. */
  tilesFail: false,
  /** The places the prepared surface's tiles were asked for. */
  tilesAsked: [] as [number, number][],
  /** Heights of a surface at the point, by its tile id. */
  heights: new Map<string, number>(),
}));
vi.mock('./card/pointHistory', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  pointHistory: (_dated: unknown, e: number, n: number) => {
    history.asked.push([e, n]);
    return history.fail
      ? Promise.reject(new Error('tile read failed'))
      : Promise.resolve(history.rows);
  },
  heightAt: (s: { id: string }) => Promise.resolve(history.heights.get(s.id) ?? null),
  // a prepared surface's tiles under a card's terrain rows: a read that fails, or flat at 7 m
  tilesSampler: () => (es: Float64Array, ns: Float64Array) => {
    es.forEach((e, i) => history.tilesAsked.push([e, ns[i] ?? Number.NaN]));
    return history.tilesFail
      ? Promise.reject(new Error('tile read failed'))
      : Promise.resolve(new Float64Array(es.length).fill(7));
  },
}));

const run = vi.hoisted(() => ({
  copy: vi.fn(() => Promise.resolve({ ok: true, moved: 1, seq: null })),
}));
vi.mock('./measureMoveRun', () => ({ copyMeasurementToDate: run.copy }));

import type { HeightTiles } from '@aio/schema';
import { MeasurementPanel } from './MeasurementPanel';
import { measureStore } from './measureStore';
import { qaStore } from './qaStore';
import { cardViews, chooseVs } from './card/slots';

const tiles = (id: string, capture: string) =>
  ({
    schema: 'aio.height-tiles/1',
    id,
    name: id,
    source: { kind: 'dsm', layer: 'dsm' },
    capture,
    crs: { epsg: 32640 },
    cellM: 1,
    tileSize: 256,
    originE: 0,
    originN: 0,
    cols: 1,
    rows: 1,
    levels: 1,
    bounds: [0, 0, 0, 256, 256, 10],
    tiles: [],
    fingerprint: id,
    preparedAt: '2026-10-20T00:00:00Z',
  }) as HeightTiles;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The second date is lined up 2 m east and 1 m south. */
const manifest: ProjectManifest = {
  schema: 'aio.project/1',
  id: 'two-dates',
  name: 'Two dates',
  crs: { epsg: 32640 },
  origin: [0, 0, 0],
  captures: [
    { id: 'jan', label: 'January', date: '2026-01-01' },
    {
      id: 'jun',
      label: 'June',
      date: '2026-06-01',
      lineUp: { eastM: 2, northM: -1, with: 'jan', at: '2026-10-16T08:00:00Z' },
    },
  ],
  layers: [{ id: 'ortho-jun', name: 'June ortho', kind: 'raster' } as never],
  severityModels: [],
  classCatalogues: [],
};

const spot: SurveyMeasurement = {
  id: 'spot',
  family: 'point',
  tool: 'elevation-difference',
  label: 'Spot',
  scope: { kind: 'survey', capture: 'jun' },
  points: [[100, 200, 5]],
  items: [],
  results: [],
  createdAt: '2026-10-11T00:00:00Z',
};

let host: HTMLDivElement;
let root: Root | undefined;
let sampled: [number, number][] = [];

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  sampled = [];
  workspace.getState().openProject({ id: 'two-dates', root: 'E:/p', manifest });
  measureStore.setState({
    editing: null,
    focus: 'spot',
    selected: ['spot'],
    readOnly: false,
    file: { schema: 'aio.measurements/1', measurements: [spot] },
    surface: {
      heightAt: (e, n) => {
        sampled.push([e, n]);
        return 3;
      },
    },
  });
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  look.only = false;
  run.copy.mockClear();
  measureStore.setState({ focus: null, selected: [], surface: null });
  qaStore.setState({ surfaces: [] });
  history.asked = [];
  history.tilesAsked = [];
  history.fail = false;
  history.heights.clear();
  cardViews.setState({}, true);
  workspace.getState().closeProject();
});

/** A row of the card's full readout ("More"), by its label. */
const cell = (label: string) => {
  const more = host.querySelector<HTMLButtonElement>('[data-testid="card-more"]');
  if (more?.getAttribute('aria-expanded') === 'false')
    act(() => {
      more.click();
    });
  const row = [...host.querySelectorAll('[data-testid="card-readout"] tr')].find(
    (r) => r.querySelector('th')?.textContent === label,
  );
  return row?.querySelector('td')?.textContent ?? '';
};

describe('the measurement panel on a lined-up date', () => {
  it('reads out and samples the measurement where it is drawn', () => {
    act(() => {
      root = createRoot(host);
      root.render(<MeasurementPanel />);
    });
    // stored at E 100, N 200; drawn 2 m east and 1 m south: the surface there is 3, the point 5
    expect(cell('Surface elevation')).toContain('3.00');
    // the terrain is sampled under the point the person sees, not the stored one
    expect(sampled).toContainEqual([102, 199]);
    expect(sampled).not.toContainEqual([100, 200]);
    // the vertex fields show the drawn position too (an edit there is in the drawn frame)
    const east = host.querySelector<HTMLInputElement>('input[aria-label="Vertex 1 E"]');
    expect(east?.value).toBe('102.000');
  });

  it('shows the easting and northing of the drawn point', () => {
    measureStore.setState({
      file: { schema: 'aio.measurements/1', measurements: [{ ...spot, tool: 'elevation' }] },
    });
    act(() => {
      root = createRoot(host);
      root.render(<MeasurementPanel />);
    });
    expect(cell('Easting')).toContain('102');
    expect(cell('Northing')).toContain('199');
  });
});

describe('the measurement panel for a look-only reviewer', () => {
  it('shows the measurement and offers no edits, as the tree and the 3D menu do', () => {
    look.only = true;
    act(() => {
      root = createRoot(host);
      root.render(<MeasurementPanel />);
    });
    const card = host.querySelector('[data-testid="survey-panel"]');
    expect(card).not.toBeNull();
    // the shared card in its detail variant, its name a heading, not a field
    expect(card?.getAttribute('data-variant')).toBe('detail');
    expect(card?.getAttribute('data-measure-id')).toBe('spot');
    expect(host.querySelector('[data-testid="card-name"]')?.tagName).toBe('H3');
    expect(host.textContent).not.toContain('Delete measurement');
  });
});

/** Render the panel and let its surface reads settle. */
async function renderPanel() {
  await act(async () => {
    root = createRoot(host);
    root.render(<MeasurementPanel />);
    await Promise.resolve();
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

const design = (): HeightTiles => ({
  ...tiles('d1', 'none'),
  name: 'Design pad FG',
  source: { kind: 'design', design: 'd1', layer: 'd1' },
  capture: undefined,
});

describe('the point card', () => {
  it('compares the point with a chosen design: the secondary line and a dashed level', async () => {
    qaStore.setState({ surfaces: [tiles('sjan2', 'jan'), design()] });
    history.rows = [{ capture: 'jan', label: 'January', date: '2026-01-01', z: 4.9 }];
    // the point is at 5 m; the design 5.038 m under it
    history.heights.set('d1', 5.038);
    chooseVs('spot', 'design:d1');
    await renderPanel();
    const card = host.querySelector('[data-testid="survey-panel"]');
    expect(card?.querySelector('[data-testid="card-secondary"]')?.textContent).toContain(
      'vs Design pad FG -0.038 m',
    );
    const level = card?.querySelector('[data-reference="design:d1"]');
    expect(level?.getAttribute('data-kind')).toBe('design');
    expect(level?.querySelector('line')?.getAttribute('stroke-dasharray')).toBe('6 4');
    // an elevation difference charts the ground on each date and its own level, dotted
    expect(card?.querySelector('[data-reference="point"]')?.getAttribute('data-kind')).toBe('base');
  });

  it('says it could not read the surface instead of computing for ever', async () => {
    qaStore.setState({ surfaces: [tiles('sfail', 'jan')] });
    history.fail = true;
    await renderPanel();
    expect(host.querySelector('[data-testid="elevation-time-error"]')?.textContent).toBe(
      'Could not read the surface',
    );
    expect(host.querySelector('[data-testid="elevation-time-busy"]')).toBeNull();
  });

  it('point card shows elevation over time from the drawn point, with no typed E and N', async () => {
    measureStore.setState({
      file: {
        schema: 'aio.measurements/1',
        measurements: [{ ...spot, tool: 'elevation-history' }],
      },
    });
    qaStore.setState({ surfaces: [tiles('sjan', 'jan'), tiles('sjun', 'jun')] });
    history.rows = [
      { capture: 'jan', label: 'January', date: '2026-01-01', z: 4.5 },
      { capture: 'jun', label: 'June', date: '2026-06-01', z: 5 },
    ];
    await act(async () => {
      root = createRoot(host);
      root.render(<MeasurementPanel />);
      await Promise.resolve();
    });
    const card = host.querySelector('[data-testid="survey-panel"]');
    // a real time chart: the dates on a time axis, the elevation in the site's units
    const chart = card?.querySelector('[data-testid="elevation-time"]');
    expect(chart).not.toBeNull();
    // the point comes from the measurement (where it is drawn), not typed in
    expect(history.asked).toEqual([[102, 199]]);
    expect(card?.querySelector('[data-testid="history-e"]')).toBeNull();
    expect(card?.querySelectorAll('input[inputmode="decimal"]').length).toBe(0);
  });
});

describe('the terrain under a large polygon', () => {
  /** A pile's toe about 94 m across, site-wide, drawn where it is stored. */
  const ring = Array.from({ length: 48 }, (_, k): [number, number, number] => {
    const a = (k / 48) * 2 * Math.PI;
    return [1000 + 47 * Math.cos(a), 2000 + 47 * Math.sin(a), 30];
  });
  const polygon = (tool: 'area' | 'volume'): SurveyMeasurement => ({
    ...spot,
    id: 'spot',
    family: 'polygon',
    tool,
    scope: { kind: 'site' },
    points: ring,
  });
  /** The 3D stage's height picker: counts its raycasts. */
  let rays = 0;
  /** The terrain's height (null: its mesh has not loaded yet). */
  let ground: number | null = 3;
  beforeEach(() => {
    rays = 0;
    ground = 3;
    measureStore.setState({
      surface: {
        heightAt: () => {
          rays++;
          return ground;
        },
      },
    });
  });
  afterEach(() => {
    history.tilesFail = false;
  });
  /** Let the card's terrain read finish (it reads in slices, off the render). */
  const settle = async (label: string) => {
    for (let i = 0; i < 200 && cell(label) === 'Computing'; i++)
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
  };
  const mount = () => {
    act(() => {
      root = createRoot(host);
      root.render(<MeasurementPanel />);
    });
  };

  it("never reads a line's terrain in the render", () => {
    measureStore.setState({
      file: {
        schema: 'aio.measurements/1',
        measurements: [
          {
            ...spot,
            family: 'line',
            tool: 'distance',
            scope: { kind: 'site' },
            points: [
              [1000, 2000, 30],
              [1060, 2000, 30],
            ],
          },
        ],
      },
    });
    mount();
    // 241 places along 60 m: none read while the card renders, all of them a slice at a time after
    expect(rays).toBe(0);
    expect(cell('Terrain length')).toBe('Computing');
  });

  it('reads the terrain again once it has loaded, instead of keeping "no surface"', async () => {
    measureStore.setState({
      file: { schema: 'aio.measurements/1', measurements: [polygon('area')] },
    });
    ground = null;
    mount();
    await settle('Terrain area');
    expect(cell('Terrain area')).toBe('No surface under it');
    act(() => root?.unmount());
    // the mesh has loaded now: the card opened again reads it
    ground = 3;
    mount();
    await settle('Terrain area');
    expect(cell('Terrain area')).toBe(cell('Horizontal area'));
  });

  it('says it could not read the surface when the read fails, not that there is none', async () => {
    qaStore.setState({ surfaces: [tiles('sjun-fail', 'jun')] });
    history.tilesFail = true;
    measureStore.setState({
      file: { schema: 'aio.measurements/1', measurements: [polygon('area')] },
    });
    mount();
    await settle('Terrain area');
    expect(cell('Terrain area')).toBe('Could not read the surface');
    // the prepared surface is read, not the 3D view
    expect(rays).toBe(0);
  });

  it("reads a site-wide area's terrain from the latest prepared surface", async () => {
    qaStore.setState({ surfaces: [tiles('sjun-ok', 'jun')] });
    measureStore.setState({
      file: { schema: 'aio.measurements/1', measurements: [polygon('area')] },
    });
    mount();
    await settle('Terrain area');
    expect(cell('Terrain area')).toBe(cell('Horizontal area'));
    expect(rays).toBe(0);
  });

  it("opens a pile's card without asking the 3D view for any terrain", async () => {
    measureStore.setState({
      file: { schema: 'aio.measurements/1', measurements: [polygon('volume')] },
    });
    await renderPanel();
    expect(host.querySelector('[data-testid="survey-panel"]')).not.toBeNull();
    expect(rays).toBe(0);
  });

  it("works out an area's terrain after the card shows, each place asked once", async () => {
    measureStore.setState({
      file: { schema: 'aio.measurements/1', measurements: [polygon('area')] },
    });
    act(() => {
      root = createRoot(host);
      root.render(<MeasurementPanel />);
    });
    // the card is up at once; its terrain area is still being read
    expect(host.querySelector('[data-testid="survey-panel"]')).not.toBeNull();
    expect(cell('Terrain area')).toBe('Computing');
    // the reads come in slices, off the render; let them finish
    for (let i = 0; i < 200 && cell('Terrain area') === 'Computing'; i++)
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
    // a flat surface: the terrain area is the plan area
    expect(cell('Terrain area')).toBe(cell('Horizontal area'));
    // every place once (half-metre cells over a 94 m toe), not once per row the card reads
    expect(rays).toBeGreaterThan(30_000);
    expect(rays).toBeLessThanOrEqual(201 * 201);
  });
});

describe('the panel colour picker', () => {
  it('offers the one palette the right-click menu offers, and sets the colour', async () => {
    const { MEASURE_COLOURS } = await import('./measureColours');
    act(() => {
      root = createRoot(host);
      root.render(<MeasurementPanel />);
    });
    const picks = [...host.querySelectorAll<HTMLButtonElement>('[data-testid^="style-colour-"]')];
    expect(picks.map((b) => b.dataset.testid)).toEqual(
      MEASURE_COLOURS.map((c) => `style-colour-${c.id}`),
    );
    act(() => {
      picks[2]?.click();
    });
    const saved = measureStore.getState().file.measurements.find((x) => x.id === 'spot');
    expect(saved?.style?.color).toBe(MEASURE_COLOURS[2]?.hex);
  });
});

const mountPanel = () => {
  act(() => {
    root = createRoot(host);
    root.render(<MeasurementPanel />);
  });
};
const openScope = () => {
  for (const d of host.querySelectorAll('details')) d.open = true;
};

describe('the measurement panel scope, source and copy', () => {
  it('shows the date and the source layer, with no Promote to the whole site', () => {
    measureStore.setState({
      file: {
        schema: 'aio.measurements/1',
        measurements: [{ ...spot, source: { layer: 'ortho-jun' } }],
      },
    });
    mountPanel();
    expect(host.querySelector('[data-testid="survey-scope-date"]')?.textContent).toContain(
      'Survey date:',
    );
    expect(host.querySelector('[data-testid="survey-scope-source"]')?.textContent).toContain(
      'Measured on: June ortho',
    );
    expect(host.textContent).not.toContain('Promote to the whole site');
    expect(host.textContent).not.toContain('Only in');
  });

  it('a legacy measurement says it needs a date', () => {
    measureStore.setState({
      file: { schema: 'aio.measurements/1', measurements: [{ ...spot, scope: { kind: 'site' } }] },
    });
    mountPanel();
    expect(host.querySelector('[data-testid="survey-scope-date"]')?.textContent).toBe(
      'Needs a date: drag it onto a survey date in the Datasets list, or right-click it there and choose Move to date.',
    );
  });

  it('no date line in a project with no survey dates', () => {
    workspace.getState().openProject({
      id: 'two-dates',
      root: 'E:/p',
      manifest: { ...manifest, captures: [] },
    });
    measureStore.setState({
      file: { schema: 'aio.measurements/1', measurements: [{ ...spot, scope: { kind: 'site' } }] },
    });
    mountPanel();
    expect(host.querySelector('[data-testid="survey-scope-date"]')).toBeNull();
  });

  it('a measurement whose date was deleted says it needs a date', () => {
    measureStore.setState({
      file: {
        schema: 'aio.measurements/1',
        measurements: [{ ...spot, scope: { kind: 'survey', capture: 'gone' } }],
      },
    });
    mountPanel();
    expect(host.querySelector('[data-testid="survey-scope-date"]')?.textContent).toContain(
      'Needs a date',
    );
    expect(host.textContent).not.toContain('gone');
  });

  it('Copy re-measures through copyMeasurementToDate', () => {
    mountPanel();
    openScope();
    const sel = host.querySelector<HTMLSelectElement>('select[aria-label="Copy to survey"]');
    expect(sel).not.toBeNull();
    act(() => {
      if (!sel) return;
      sel.value = 'jan';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const copy = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Copy');
    act(() => copy?.click());
    expect(run.copy).toHaveBeenCalledWith('spot', 'jan');
  });

  it('reads a date re-lined-up after preparing where its prepared surface holds the point', async () => {
    // June's surface was prepared at 0.5 m east; June is lined up 2 m east and 1 m south now
    qaStore.setState({
      surfaces: [{ ...tiles('s-jun', 'jun'), dateShiftM: { eastM: 0.5, northM: 0 } }],
    });
    await renderPanel();
    // drawn (102, 199), back by the line-up now, on by the prepared one: (100.5, 200)
    expect(history.tilesAsked).toContainEqual([100.5, 200]);
    expect(history.tilesAsked).not.toContainEqual([102, 199]);
    expect(cell('Surface elevation')).toContain('7.00');
  });
});
