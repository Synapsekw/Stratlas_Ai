// @vitest-environment jsdom
import {
  defaultSurveySettings,
  type ComparisonResult,
  type SurveyMeasurement,
  type SurveySettings,
} from '@aio/schema';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PileData } from './PilePanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const calls = vi.hoisted(() => ({
  saveFile: vi.fn<
    (channel: string, req: { defaultName: string; data: string }) => Promise<unknown>
  >(() => Promise.resolve({ ok: true, value: { path: 'x.csv' } })),
  addToReport: vi.fn<(id: string) => Promise<'added' | 'already'>>(() => Promise.resolve('added')),
}));
const CAPTURES = [
  { id: 'c1', date: '2020-12-31', label: '31 Dec 2020' },
  { id: 'c2', date: '2021-01-10', label: '10 Jan 2021' },
];
vi.mock('../compareStore', () => ({
  useCompare: (sel: (x: unknown) => unknown) => sel({ captures: CAPTURES }),
}));
vi.mock('../../shell', () => ({ bridge: { call: calls.saveFile } }));
// the head's "⋯" menu reads the shell; it has its own tests
vi.mock('../card/CardActions', () => ({ CardMenu: () => null }));
vi.mock('../../report/templateStore', () => ({ addToReport: calls.addToReport }));

const { PileHistory } = await import('./PileHistory');
const { pileView } = await import('./pileView');
const { pileSeries, volumeRows, pileFigures } = {
  ...(await import('@aio/survey')),
  ...(await import('./pileView')),
};

const NOW = '2026-10-24T00:00:00.000Z';
function result(net: number, capture: string): ComparisonResult {
  return {
    item: 'a',
    status: 'ok',
    cutM3: 0,
    fillM3: net,
    netM3: net,
    totalM3: net,
    areaM2: 100,
    areaCutM2: 0,
    areaFillM2: 100,
    areaUnchangedM2: 0,
    uncoveredM2: 0,
    fromLabel: 'Triangulated toe',
    toLabel: capture,
    toCapture: capture,
    deadbandM: 0,
    usedDeadband: false,
    cellM: 0.5,
    engine: 'ts',
    fingerprint: `sha256:${capture}`,
    computedAt: NOW,
  };
}

const settings: SurveySettings = {
  ...defaultSurveySettings(),
  materials: [{ id: 'agg', name: 'Aggregate 20 mm', densityTPerM3: 1.6 }] as never,
};

function dataOf(over: Partial<SurveyMeasurement> = {}): PileData {
  const m: SurveyMeasurement = {
    id: '02',
    family: 'polygon',
    tool: 'volume',
    label: 'Pile 02',
    scope: { kind: 'site' },
    points: [
      [0, 0, 10],
      [40, 0, 10],
      [40, 20, 10],
    ],
    items: [{ id: 'a', from: { kind: 'smart' }, to: { kind: 'current' }, useDeadband: false }],
    results: [result(11378.7, 'c2')],
    series: [result(14686.7, 'c1')],
    material: 'agg',
    createdAt: NOW,
    ...over,
  };
  const material = { id: 'agg', name: 'Aggregate 20 mm', densityTPerM3: 1.6 };
  const rows = volumeRows(pileSeries(m).series, CAPTURES, {
    densityTPerM3: 1.6,
    isStale: () => false,
  });
  return {
    m,
    settings,
    units: settings.units,
    locale: 'metric',
    readOnly: false,
    material,
    rows,
    figures: pileFigures(rows),
    stored: m.results[0],
    line: { tone: 'ok', text: 'Up to date' },
    dateOf: () => null,
    densityFrom: null,
    earliest: null,
  };
}

let host: HTMLDivElement;
let root: Root | undefined;
const render = (data: PileData) => {
  root ??= createRoot(host);
  act(() => {
    root?.render(<PileHistory data={data} />);
  });
};
const q = (sel: string) => host.querySelector(sel);
const qa = (sel: string) => [...host.querySelectorAll(sel)];
const click = (el: Element | null | undefined) => {
  if (!el) throw new Error('not found');
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
};
const cells = () =>
  qa('[data-testid="pile-history-table"] tbody tr').map((tr) =>
    [...tr.querySelectorAll('th, td')].map((c) => c.textContent),
  );

beforeEach(() => {
  vi.clearAllMocks();
  pileView.setState({ historyUnit: 'm3' });
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
});

describe('PileHistory', () => {
  it('lists one row per date, newest first, with density, tonnes and "first" on the earliest', () => {
    render(dataOf());
    expect(q('[data-testid="pile-history-title"]')?.textContent).toBe(
      'Volume and tonnes over time',
    );
    expect(cells()).toEqual([
      ['10 Jan 2021', '11 378.7', '1.60', '18 206', '−3 308.0'],
      ['31 Dec 2020', '14 686.7', '1.60', '23 499', 'first'],
    ]);
    expect(q('[data-testid="pile-history-note"]')?.textContent).toBe(
      'Density 1.60 t/m³ for Aggregate 20 mm applies from 31 Dec 2020. A new density takes effect from the date you choose in Materials; earlier dates keep the tonnes they had.',
    );
  });

  it('writes the density in the locale, as the tonnes figure does', () => {
    const data = dataOf();
    render({ ...data, material: { ...data.material, densityTPerM3: 1234.5 } as never });
    expect(cells()[0]?.[2]).toBe('1 234.50');
    expect(q('[data-testid="pile-history-note"]')?.textContent).toContain('Density 1 234.50 t/m³');
  });

  it('shows the kit figure a standard-base figure replaced as was, on its date', () => {
    render(
      dataOf({
        origin: { kind: 'kit-pile', pile: 'k2' },
        previousResults: [
          { netM3: 11690.2, totalM3: 11690.2, label: 'kit, Toe line', replacedAt: NOW },
        ],
      }),
    );
    const was = q('[data-testid="pile-history-was"]');
    expect(was?.textContent).toBe('was 11 690.2 · earlier version');
    expect(was?.closest('tr')?.getAttribute('data-capture')).toBe('c2');
  });

  it('draws the volume bars, the tonnes or both', () => {
    render(dataOf());
    expect(qa('[data-testid="pile-history-chart"] rect[data-bar]').length).toBe(2);
    expect(q('[data-testid="pile-history-chart"]')?.textContent).toContain('Volume (m³)');
    click(qa('[data-testid="pile-history-unit"] button')[1]);
    expect(pileView.getState().historyUnit).toBe('t');
    expect(q('[data-testid="pile-history-chart"]')?.textContent).toContain('Tonnes (t)');
    expect(q('[data-testid="pile-history-chart"] [data-bar-value="c2"]')?.textContent).toBe(
      '18 206',
    );
    click(qa('[data-testid="pile-history-unit"] button')[2]);
    expect(qa('[data-testid="pile-history-chart"]').length).toBe(2);
  });

  it('exports the pile’s dates as CSV and adds it to the report', async () => {
    render(dataOf());
    await act(async () => {
      q('[data-testid="pile-history-csv"]')?.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
      await Promise.resolve();
    });
    expect(calls.saveFile).toHaveBeenCalledTimes(1);
    const req = calls.saveFile.mock.calls[0]?.[1];
    expect(req?.defaultName).toBe('Pile-02.csv');
    expect(req?.data).toContain('Pile 02');
    expect(req?.data.split('\n').filter((l) => l.includes('Pile 02')).length).toBe(2);
    await act(async () => {
      q('[data-testid="pile-history-report"]')?.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
      await Promise.resolve();
    });
    expect(calls.addToReport).toHaveBeenCalledWith('02');
    expect(q('[data-testid="pile-history-done"]')?.textContent).toBe('Added to the report');
  });
});
