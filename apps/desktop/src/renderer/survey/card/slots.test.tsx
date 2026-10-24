// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  defaultSurveySettings,
  emptyMeasurements,
  MeasurementTool,
  type HeightTiles,
  type MeasurementFamily,
  type ProjectManifest,
  type SurveyMeasurement,
} from '@aio/schema';
import { workspace } from '@aio/workspace';
import { act, isValidElement, type ReactElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Synthetic surfaces by tile id: a height at (E, N). */
const ground = vi.hoisted((): { at: Record<string, (e: number, n: number) => number | null> } => ({
  at: {},
}));
vi.mock('./pointHistory', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  withSurface: <T,>(
    compute: (h: { heightAt(e: number, n: number): number | null }) => T,
    tiles: { id: string },
  ) => Promise.resolve(compute({ heightAt: (e, n) => ground.at[tiles.id]?.(e, n) ?? null })),
  heightAt: (tiles: { id: string }, e: number, n: number) =>
    Promise.resolve(ground.at[tiles.id]?.(e, n) ?? null),
}));
/** Each date's surface state, as `useSurfaceStates` gives it (A5). */
const states = vi.hoisted((): { map: Map<string, unknown>; running: boolean; soon: boolean } => ({
  map: new Map(),
  running: false,
  soon: true,
}));
vi.mock('../surfaceStates', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useSurfaceStates: () => states.map,
  usePrepareRunning: () => states.running,
  usePreparingSoon: () => states.soon,
}));
const prepared = vi.hoisted(
  (): { dates: (readonly string[])[]; answer: () => Promise<string | null> } => ({
    dates: [],
    answer: () => Promise.resolve(null),
  }),
);
vi.mock('../compareStore', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  prepareDates: (captures: readonly string[]) => {
    prepared.dates.push(captures);
    return prepared.answer();
  },
}));
const section = vi.hoisted(() => ({ opened: [] as unknown[], window: false }));
vi.mock('../sectionStore', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  openSection: (line: unknown, source: unknown) => {
    section.opened.push({ line, source });
  },
  setWindow: (open: boolean) => {
    section.window = open;
  },
}));

import { measureStore } from '../measureStore';
import { qaStore } from '../qaStore';
import { TOOL_ICON } from './cardModel';
import {
  autoExaggeration,
  BASE_KEY,
  cardViews,
  chartAgrees,
  chooseVs,
  lineOptions,
  slotKinds,
  slotsFor,
  VertexTable,
  type ChartKind,
} from './slots';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const FAMILY: Record<MeasurementTool, MeasurementFamily> = {
  elevation: 'point',
  'elevation-difference': 'point',
  'elevation-history': 'point',
  annotation: 'point',
  distance: 'line',
  grade: 'line',
  'vertex-table': 'line',
  'berm-check': 'line',
  section: 'line',
  azimuth: 'line',
  'antenna-tilt': 'line',
  clearance: 'line',
  area: 'polygon',
  volume: 'polygon',
  freehand: 'line',
};

const of = (tool: MeasurementTool, points?: SurveyMeasurement['points']): SurveyMeasurement => ({
  id: tool,
  family: FAMILY[tool],
  tool,
  label: tool,
  scope: { kind: 'site' },
  points: points ?? [
    [0, 0, 0],
    [10, 0, 1],
    [10, 10, 2],
  ],
  items: [],
  results: [],
  createdAt: '2026-10-20T00:00:00Z',
});

/** The spec's chart slot (W2): lines a profile, points elevation over time, volumes theirs. */
const SPEC: Record<MeasurementTool, ChartKind> = {
  distance: 'profile',
  grade: 'profile',
  'vertex-table': 'profile',
  'berm-check': 'profile',
  section: 'profile',
  elevation: 'elevation',
  'elevation-difference': 'elevation',
  annotation: 'elevation',
  'elevation-history': 'elevation',
  volume: 'volume',
  area: null,
  azimuth: null,
  'antenna-tilt': null,
  clearance: null,
  freehand: null,
};

/** The component a slot draws, by name (a fragment: the names of its children). */
const drawn = (n: ReactNode): string | null => {
  if (!isValidElement(n)) return null;
  const type = (n as ReactElement).type;
  if (typeof type === 'function') return type.name;
  const kids = (n as ReactElement<{ children?: ReactNode }>).props.children;
  return [kids]
    .flat()
    .map((k) => drawn(k))
    .filter(Boolean)
    .join('+');
};

const tiles = (id: string, capture?: string, design = false): HeightTiles => ({
  schema: 'aio.height-tiles/1',
  id,
  name: design ? 'Design pad FG' : id,
  source: design ? { kind: 'design', design: 'd1', layer: 'd1' } : { kind: 'dsm', layer: 'dsm' },
  ...(capture ? { capture } : {}),
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
});

const manifest: ProjectManifest = {
  schema: 'aio.project/1',
  id: 'slots',
  name: 'Slots',
  crs: { epsg: 32640 },
  origin: [0, 0, 0],
  captures: [
    { id: 'jan', label: 'January', date: '2026-01-01' },
    { id: 'jun', label: 'June', date: '2026-06-01' },
  ],
  layers: [],
  severityModels: [],
  classCatalogues: [],
};

describe('the card slots by tool', () => {
  it('each tool gets the chart from the spec table', () => {
    for (const tool of MeasurementTool.options) {
      expect([tool, slotKinds(tool).chart]).toEqual([tool, SPEC[tool]]);
      // the one chart rule (export, report) agrees with the slot table
      expect([tool, chartAgrees(tool)]).toEqual([tool, true]);
      const slots = slotsFor(of(tool), 'detail');
      const chart = drawn(slots.chart);
      if (SPEC[tool] === 'profile') expect(chart).toBe('LineProfile');
      else if (SPEC[tool] === 'elevation') expect(chart).toBe('ElevationOverTime');
      // a volume's chart is the over-time chart inside its detail
      else expect(chart).toBeNull();
    }
  });

  it('gives chips by type: surfaces on lines, one surface on points, dates on areas', () => {
    for (const tool of ['distance', 'grade', 'vertex-table', 'berm-check', 'section'] as const)
      expect(drawn(slotsFor(of(tool), 'detail').chips)).toBe('LineChips');
    for (const tool of ['elevation', 'elevation-difference', 'annotation'] as const)
      expect(drawn(slotsFor(of(tool), 'detail').chips)).toBe('PointChips');
    expect(drawn(slotsFor(of('area'), 'detail').chips)).toBe('AreaDates');
    for (const tool of ['azimuth', 'antenna-tilt', 'clearance', 'freehand', 'volume'] as const)
      expect(slotsFor(of(tool), 'detail').chips).toBeUndefined();
  });

  it('puts each tool its own detail', () => {
    const detail = (tool: MeasurementTool) => drawn(slotsFor(of(tool), 'detail').detail);
    expect(detail('distance')).toBe('TerrainLengths');
    expect(detail('grade')).toBe('TerrainLengths');
    expect(detail('vertex-table')).toBe('VertexTable');
    expect(detail('berm-check')).toBe('BermTable');
    expect(detail('section')).toBe('OpenSection');
    expect(detail('volume')).toBe('Comparisons+Calculators');
    // an area with no comparison offers "+ Compare date"
    expect(detail('area')).toBe('CompareArea+Calculators');
    expect(detail('elevation')).toBeNull();
  });

  it('gives the live card no chips, chart or detail', () => {
    for (const tool of MeasurementTool.options) expect(slotsFor(of(tool), 'live')).toEqual({});
  });

  it('gives every tool its own icon', () => {
    const icons = MeasurementTool.options.map((tool) => TOOL_ICON[tool]);
    expect(new Set(icons).size).toBe(icons.length);
  });

  it('offers a line the survey dates, the designs and the base', () => {
    const dated = [
      {
        capture: 'jan',
        label: 'January',
        date: '2026-01-01',
        state: { kind: 'ready' as const },
        tiles: tiles('sjan', 'jan'),
      },
      {
        capture: 'jun',
        label: 'June',
        date: '2026-06-01',
        state: { kind: 'ready' as const },
        tiles: tiles('sjun', 'jun'),
      },
    ];
    const designs = [
      { key: 'design:d1', label: 'Design pad FG', group: 'design' as const, tiles: tiles('d1') },
    ];
    expect(
      lineOptions(dated, designs, 'jun', 'Line as drawn').map((o) => [o.key, o.group, o.kind]),
    ).toEqual([
      ['jan', 'survey', 'earlier'],
      ['jun', 'survey', 'current'],
      ['design:d1', 'design', 'design'],
      [BASE_KEY, 'base', 'base'],
    ]);
  });

  it('fits the exaggeration to the chart plot', () => {
    const flat = { key: 'a', label: 'a', kind: 'current' as const, chainage: [0, 100], z: [0, 1] };
    expect(autoExaggeration([flat])).toBe(20);
    expect(autoExaggeration([{ ...flat, z: [0, 50] }])).toBe(1);
    expect(autoExaggeration([{ ...flat, z: [5, 5] }])).toBe(1);
  });
});

let host: HTMLDivElement;
let root: Root | undefined;
const render = async (node: ReactNode) => {
  await act(async () => {
    root ??= createRoot(host);
    root.render(<>{node}</>);
    await Promise.resolve();
  });
  // the shared loads settle, then the cards render their values
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
};
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  workspace.getState().openProject({ id: 'slots', root: 'E:/p', manifest });
  qaStore.setState({
    surfaces: [tiles('sjan', 'jan'), tiles('sjun', 'jun'), tiles('d1', undefined, true)],
  });
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  measureStore.setState({ settings: defaultSurveySettings(), file: emptyMeasurements() });
  qaStore.setState({ surfaces: [] });
  cardViews.setState({}, true);
  workspace.getState().closeProject();
  ground.at = {};
  states.map = new Map();
  states.running = false;
  states.soon = true;
  prepared.dates = [];
  prepared.answer = () => Promise.resolve(null);
});

describe('lines on the card', () => {
  it('distance shows each shown surface terrain length: a date, a design and the base', async () => {
    ground.at = {
      sjun: () => 0,
      sjan: () => 0,
      // the design rises 0.75 m per metre east: 10 m plan is 12.5 m on it
      d1: (e) => 0.75 * e,
    };
    const m = of('distance', [
      [0, 0, 0],
      [10, 0, 0],
    ]);
    act(() => {
      cardViews.setState({
        distance: { shown: ['jun', 'design:d1', BASE_KEY], off: [], shadeVs: null, vs: null },
      });
    });
    const s = slotsFor(m, 'detail');
    await render(
      <>
        {s.chips}
        {s.chart}
        {s.detail}
      </>,
    );
    const rows = [...host.querySelectorAll('[data-testid="terrain-lengths"] tbody tr')].map((r) => [
      r.getAttribute('data-surface'),
      r.querySelector('td')?.textContent,
    ]);
    expect(rows).toEqual([
      ['jun', '10.000 m'],
      ['design:d1', '12.500 m'],
      [BASE_KEY, '10.000 m'],
    ]);
    expect(host.querySelector('[data-testid="line-profile"]')).not.toBeNull();
    // the ends of the profile go through the strings
    expect(host.querySelector('[data-testid="line-chips"]')).not.toBeNull();
  });

  it('a berm check marks its berm on the profile and tables its sides', async () => {
    // level ground, a 2 m berm: toes at 5 and 15 m, crest from 7 to 13 m
    const berm = (e: number) => (e <= 5 ? 0 : e < 7 ? e - 5 : e <= 13 ? 2 : e < 15 ? 15 - e : 0);
    ground.at = { sjun: berm, sjan: berm };
    const m = of('berm-check', [
      [0, 0, 0],
      [20, 0, 0],
    ]);
    const s = slotsFor(m, 'detail');
    await render(
      <>
        {s.chart}
        {s.detail}
      </>,
    );
    expect(host.querySelectorAll('[data-testid="section-chart-pin"]').length).toBe(4);
    const side = (k: string) =>
      [...host.querySelectorAll(`[data-testid="berm-table"] tr[data-side="${k}"] td`)].map(
        (c) => c.textContent,
      );
    expect(side('left')[0]).toBe('5.000 m');
    expect(side('left')[1]).toBe('2.000 m');
    expect(side('right')[0]).toBe('15.000 m');
    expect(side('crest')[0]).toBe('6.000 m');
    expect(side('base')[0]).toBe('10.000 m');
  });

  it('a cross-section opens in the section view, its pins stay there', async () => {
    const m = of('section', [
      [0, 0, 0],
      [20, 0, 0],
    ]);
    await render(slotsFor(m, 'detail').detail);
    const open = host.querySelector<HTMLButtonElement>('[data-testid="card-open-section"]');
    expect(open?.textContent).toBe('Open in section view');
    act(() => {
      open?.click();
    });
    expect(section.opened).toEqual([
      {
        line: [
          [0, 0],
          [20, 0],
        ],
        source: { kind: 'measurement', id: 'section', label: 'section' },
      },
    ]);
    expect(section.window).toBe(true);
    expect(host.querySelector('[data-testid="section-chart-pin"]')).toBeNull();
  });
});

describe('points on the card', () => {
  it('offers the dates and the designs to compare with', async () => {
    const m = of('elevation', [[5, 5, 3]]);
    chooseVs(m.id, 'design:d1');
    await render(slotsFor(m, 'detail').chips);
    const chips = [...host.querySelectorAll('[data-testid="point-chips"] [data-chip]')];
    expect(chips.map((c) => c.getAttribute('data-chip'))).toEqual(['design:d1']);
  });
});

describe('an area on the card', () => {
  it('starts a comparison with "+ Compare date"', async () => {
    const m = of('area');
    measureStore.setState({
      readOnly: false,
      file: { ...emptyMeasurements(), measurements: [m] },
    });
    await render(slotsFor(m, 'detail').detail);
    const add = host.querySelector<HTMLButtonElement>('[data-testid="survey-add-comparison"]');
    expect(add?.textContent).toBe('+ Compare date');
    act(() => {
      add?.click();
    });
    expect(measureStore.getState().file.measurements[0]?.items).toHaveLength(1);
  });
});

describe('every survey date with its surface state', () => {
  /** Three dates: January prepared, June preparing, September waiting for Prepare. */
  const threeDates = () => {
    workspace.getState().openProject({
      id: 'slots',
      root: 'E:/p',
      manifest: {
        ...manifest,
        captures: [
          { id: 'jan', label: 'January', date: '2026-01-01' },
          { id: 'jun', label: 'June', date: '2026-06-01' },
          { id: 'sep', label: 'September', date: '2026-09-01' },
          { id: 'dec', label: 'December', date: '2026-12-01' },
        ],
      },
    });
    qaStore.setState({ surfaces: [tiles('sjan', 'jan')] });
    states.map = new Map<string, unknown>([
      ['jan', { kind: 'ready' }],
      ['jun', { kind: 'preparing', pct: 62 }],
      ['sep', { kind: 'missing' }],
      ['dec', { kind: 'none' }],
    ]);
  };
  const line = () =>
    of('distance', [
      [0, 0, 0],
      [10, 0, 0],
    ]);
  const chipAt = (key: string) =>
    host.querySelector<HTMLElement>(`[data-testid="line-chips"] [data-chip="${key}"]`);

  it('a line card lists every survey date as a chip, ready, preparing 62 % and Prepare', async () => {
    threeDates();
    ground.at = { sjan: () => 0 };
    act(() => {
      cardViews.setState({
        distance: { shown: ['jan', 'jun', 'sep', 'dec'], off: [], shadeVs: null, vs: null },
      });
    });
    await render(slotsFor(line(), 'detail').chips);
    expect(chipAt('jan')?.getAttribute('data-state')).toBe('ready');
    expect(chipAt('jun')?.getAttribute('data-state')).toBe('preparing');
    expect(chipAt('jun')?.textContent).toContain('preparing 62 %');
    expect(chipAt('sep')?.querySelector('[data-testid="chip-prepare"]')?.textContent).toBe(
      'Prepare',
    );
  });

  it('by default the chips are the latest date and the one before, whatever their state', async () => {
    threeDates();
    await render(slotsFor(line(), 'detail').chips);
    const keys = [...host.querySelectorAll('[data-testid="line-chips"] [data-chip]')].map((c) =>
      c.getAttribute('data-chip'),
    );
    expect(keys).toEqual(['dec', 'sep']);
  });

  it('Prepare on a chip starts prepareDates for that date', async () => {
    threeDates();
    act(() => {
      cardViews.setState({
        distance: { shown: ['jan', 'sep'], off: [], shadeVs: null, vs: null },
      });
    });
    await render(slotsFor(line(), 'detail').chips);
    act(() => {
      chipAt('sep')?.querySelector<HTMLButtonElement>('[data-testid="chip-prepare"]')?.click();
    });
    expect(prepared.dates).toEqual([['sep']]);
  });

  it('a second Prepare while the first is on its way starts nothing more', async () => {
    threeDates();
    let finish: (v: string | null) => void = () => undefined;
    prepared.answer = () =>
      new Promise((r) => {
        finish = r;
      });
    act(() => {
      cardViews.setState({
        distance: { shown: ['jan', 'sep'], off: [], shadeVs: null, vs: null },
      });
    });
    await render(slotsFor(line(), 'detail').chips);
    const button = chipAt('sep')?.querySelector<HTMLButtonElement>('[data-testid="chip-prepare"]');
    act(() => {
      button?.click();
      button?.click();
    });
    expect(prepared.dates).toEqual([['sep']]);
    await act(async () => {
      finish(null);
      await Promise.resolve();
    });
  });

  it('no Prepare while a prepare job runs on the project', async () => {
    threeDates();
    states.running = true;
    act(() => {
      cardViews.setState({
        distance: { shown: ['jan', 'sep'], off: [], shadeVs: null, vs: null },
      });
    });
    await render(slotsFor(line(), 'detail').chips);
    expect(chipAt('sep')?.querySelector('[data-testid="chip-prepare"]')).toBeNull();
  });

  it('a Prepare that could not start says why on the card', async () => {
    threeDates();
    prepared.answer = () => Promise.resolve('The pipeline Python is not installed.');
    act(() => {
      cardViews.setState({
        distance: { shown: ['jan', 'sep'], off: [], shadeVs: null, vs: null },
      });
    });
    await render(slotsFor(line(), 'detail').chips);
    await act(async () => {
      chipAt('sep')?.querySelector<HTMLButtonElement>('[data-testid="chip-prepare"]')?.click();
      await Promise.resolve();
    });
    expect(host.querySelector('[data-testid="prepare-error"]')?.textContent).toBe(
      'The pipeline Python is not installed.',
    );
  });

  it('a date no job will prepare reads "Not prepared yet", one a job will "Surface preparing"', async () => {
    threeDates();
    qaStore.setState({ surfaces: [] });
    states.map = new Map<string, unknown>([['jan', { kind: 'missing' }]]);
    states.soon = false;
    const point = of('elevation', [[5, 5, 3]]);
    await render(slotsFor(point, 'detail').chart);
    expect(host.textContent).toContain('Not prepared yet');
    expect(host.textContent).not.toContain('Surface preparing');
    states.soon = true;
    act(() => root?.unmount());
    root = undefined;
    await render(slotsFor(point, 'detail').chart);
    expect(host.textContent).toContain('Surface preparing');
  });

  it('a date without elevation is a disabled chip with "No elevation for this date"', async () => {
    threeDates();
    act(() => {
      cardViews.setState({ distance: { shown: ['dec'], off: [], shadeVs: null, vs: null } });
    });
    await render(slotsFor(line(), 'detail').chips);
    const main = chipAt('dec')?.querySelector<HTMLButtonElement>('.pc-chip-main');
    expect(chipAt('dec')?.getAttribute('data-state')).toBe('none');
    expect(main?.getAttribute('aria-disabled')).toBe('true');
    expect(host.textContent).toContain('No elevation for this date');
  });

  it('no card shows "No survey data"', async () => {
    threeDates();
    // nothing prepared yet: June preparing, September missing, December without elevation
    qaStore.setState({ surfaces: [] });
    states.map.set('jan', { kind: 'preparing', pct: 10 });
    const texts: string[] = [];
    for (const m of [
      line(),
      of('elevation', [[5, 5, 3]]),
      of('elevation-difference', [[5, 5, 3]]),
      of('area'),
    ]) {
      const s = slotsFor(m, 'detail');
      await render(
        <>
          {s.chips}
          {s.chart}
          {s.detail}
        </>,
      );
      texts.push(host.textContent);
    }
    for (const text of texts) expect(text).not.toContain('No survey data');
    // the line's profile and the point's chart name the reason
    expect(texts[0]).toContain('Surface preparing');
    expect(texts[1]).toContain('Surface preparing');
    // the area names each date's state
    expect(texts[3]).toContain('preparing 62 %');
    expect(texts[3]).toContain('No elevation for this date');
  });

  it('a date with elevation where the line has none reads "Not measured on this date"', async () => {
    threeDates();
    states.map = new Map([['jan', { kind: 'ready' }]]);
    act(() => {
      cardViews.setState({ distance: { shown: ['jan'], off: [], shadeVs: null, vs: null } });
    });
    // the surface has no height under the line (a line of its own: loads are shared by inputs)
    ground.at = { sjan: () => null };
    const s = slotsFor(
      of('distance', [
        [100, 0, 0],
        [110, 0, 0],
      ]),
      'detail',
    );
    await render(s.chart);
    expect(host.textContent).toContain('Not measured on this date');
  });
});

describe('the card choices', () => {
  it('are forgotten once the measurement is deleted', () => {
    const m = of('elevation');
    measureStore.setState({ file: { ...emptyMeasurements(), measurements: [m] } });
    chooseVs(m.id, 'jan');
    expect(cardViews.getState()[m.id]?.vs).toBe('jan');
    measureStore.setState({ file: emptyMeasurements() });
    expect(cardViews.getState()[m.id]).toBeUndefined();
  });
});

describe('the vertex table', () => {
  it('vertex table uses the formatter (imperial gives ft)', () => {
    const settings = defaultSurveySettings();
    measureStore.setState({
      settings: {
        ...settings,
        units: { ...settings.units, distance: 'ft' },
        angles: { angle: 'deg', bearing: 'deg', precision: 1 },
      },
    });
    act(() => {
      root = createRoot(host);
      root.render(<VertexTable m={of('vertex-table')} />);
    });
    const cells = [...host.querySelectorAll('tbody tr:first-child td')].map((c) => c.textContent);
    // 10 m east is 32.81 ft, due east is a bearing of 090.0°
    expect(cells[0]).toBe('1 to 2');
    expect(cells[1]).toMatch(/^32\.8\d* ft$/);
    expect(cells[5]).toBe('090.0°');
    expect(host.querySelector('caption')?.textContent).toBe('Vertex differences');
  });
});

describe('Survey QA', () => {
  it('has no elevation history panel any more', () => {
    const qa = readFileSync(join(import.meta.dirname, '..', 'Qa.tsx'), 'utf8');
    expect(qa).not.toContain('ElevationHistory');
    expect(qa).not.toMatch(/panel: 'history'/);
    const store = readFileSync(join(import.meta.dirname, '..', 'qaStore.ts'), 'utf8');
    expect(store).not.toMatch(/'history'/);
  });
});
