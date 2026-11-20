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
  recomputeVolume: vi.fn<(m: { id: string }) => string | null>(() => null),
  recomputeStandard: vi.fn<(id: string) => Promise<string | null>>(() => Promise.resolve(null)),
}));
/** What the panel reads of the survey engine: its prepared surfaces and the runs under way. */
const engine = vi.hoisted(
  (): {
    surfaces: { id: string }[];
    running: Record<string, boolean>;
    /** Why the last run of a measurement failed, and the engine's own trouble. */
    problems: Record<string, string>;
    error: string | null;
  } => ({ surfaces: [{ id: 's1' }], running: {}, problems: {}, error: null }),
);
const CAPTURES = [
  { id: 'c1', date: '2020-12-31', label: '31 Dec 2020' },
  { id: 'c2', date: '2021-01-10', label: '10 Jan 2021' },
];
vi.mock('../compareStore', () => ({
  useCompare: (sel: (x: unknown) => unknown) =>
    sel({
      captures: CAPTURES,
      surfaces: engine.surfaces,
      running: engine.running,
      problems: engine.problems,
      error: engine.error,
    }),
  recomputeStandard: calls.recomputeStandard,
}));
// the volume card's own Recompute (it has its tests there)
vi.mock('../card/VolumeDetail', () => ({ recomputeVolume: calls.recomputeVolume }));
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
  engine.surfaces = [{ id: 's1' }];
  engine.running = {};
  engine.problems = {};
  engine.error = null;
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
    expect(q('[data-testid="pile-history-title"]')?.textContent).toBe('Volume over time');
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

  it('keeps Export CSV in the head row, beside the unit switch', () => {
    render(dataOf());
    const csv = q('[data-testid="pile-history-csv"]');
    const head = q('[data-testid="pile-history-title"]')?.parentElement;
    expect(head?.contains(csv)).toBe(true);
    expect(head?.contains(q('[data-testid="pile-history-unit"]'))).toBe(true);
    // one group with the switch, so the two stay on one line
    expect(csv?.parentElement).toBe(q('[data-testid="pile-history-unit"]')?.parentElement);
    expect(csv?.parentElement).not.toBe(head);
    // before the chart and the table, so it shows without scrolling
    const chart = q('[data-testid="pile-history-chart"]');
    expect(csv && chart && csv.compareDocumentPosition(chart)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect((csv as HTMLButtonElement | null)?.disabled).toBe(false);
    expect(q('[data-testid="pile-history-none"]')).toBeNull();
  });

  describe('a pile with no computed volume', () => {
    /** A volume outline with no comparison yet: no row on any date. */
    const empty = (over: Partial<PileData> = {}): PileData => ({
      ...dataOf({ items: [], results: [], series: [] }),
      rows: [],
      figures: pileFigures([]),
      stored: undefined,
      line: { tone: 'muted', text: 'Not computed yet' },
      ...over,
    });

    it('says so in place of an empty chart and table, and offers the card’s Recompute', () => {
      const data = empty();
      render(data);
      expect(q('[data-testid="pile-history-none"]')?.textContent).toBe(
        'This pile has no volume yet',
      );
      expect(q('[data-testid="pile-history-none"]')?.getAttribute('role')).toBe('status');
      expect(q('[data-testid="pile-history-table"]')).toBeNull();
      expect(q('[data-testid="pile-history-chart"]')).toBeNull();
      // nothing to export yet: the line beside it says why
      expect((q('[data-testid="pile-history-csv"]') as HTMLButtonElement | null)?.disabled).toBe(
        true,
      );
      const recompute = q('[data-testid="pile-history-recompute"]');
      expect(recompute?.textContent).toBe('Recompute');
      click(recompute);
      expect(calls.recomputeVolume).toHaveBeenCalledTimes(1);
      expect(calls.recomputeVolume).toHaveBeenCalledWith(data.m);
    });

    it('says why Recompute could not start', () => {
      calls.recomputeVolume.mockReturnValueOnce('The volume engine is still starting.');
      render(empty());
      click(q('[data-testid="pile-history-recompute"]'));
      // with the note it explains, not at the foot of the tab
      const why = q('[data-testid="pile-history-problem"]');
      expect(why?.textContent).toBe('The volume engine is still starting.');
      expect(why?.getAttribute('role')).toBe('alert');
      expect(q('[data-testid="pile-history-done"]')).toBeNull();
    });

    it('says why a Recompute that started then failed, as the volume card does', () => {
      render(empty());
      expect(q('[data-testid="pile-history-problem"]')).toBeNull();
      // the run ended with the engine's reason for this pile
      engine.problems = { '02': 'The comparison engine stopped. Recompute to start it again.' };
      render(empty());
      const why = q('[data-testid="pile-history-problem"]');
      expect(why?.textContent).toBe('The comparison engine stopped. Recompute to start it again.');
      expect(why?.getAttribute('role')).toBe('alert');
      expect(q('[data-testid="pile-history-none"]')).not.toBeNull();
      // another pile's failure is not this one's
      engine.problems = { '07': 'Not this pile' };
      render(empty());
      expect(q('[data-testid="pile-history-problem"]')).toBeNull();
    });

    it('says the engine’s own trouble too, before the pile’s', () => {
      engine.error = 'The comparison engine could not start.';
      engine.problems = { '02': 'The run failed.' };
      render(empty());
      expect(q('[data-testid="pile-history-problem"]')?.textContent).toBe(
        'The comparison engine could not start.',
      );
    });

    it('keeps saying why once the failed run left a comparison with no figure on any date', () => {
      // Recompute gave the outline its comparison, then the run failed: a row per date, no value
      engine.problems = { '02': 'The run failed.' };
      render(dataOf({ results: [], series: [] }));
      expect(q('[data-testid="pile-history-none"]')).toBeNull();
      expect(cells().map((r) => r[1])).toEqual([
        'Not measured on this date',
        'Not measured on this date',
      ]);
      expect(q('[data-testid="pile-history-problem"]')?.textContent).toBe('The run failed.');
    });

    it('a kit-carried pile gets the card’s Recompute with the standard base, never the plain one', async () => {
      const kit = {
        ...result(11378.7, 'c2'),
        carried: { from: 'kit' as const, base: 'tin' as const, pile: 'p7', epoch: 'e1' },
      };
      const data = empty();
      const carried = { ...data, m: { ...data.m, items: dataOf().m.items, results: [kit] } };
      render(carried);
      expect(q('[data-testid="pile-history-recompute"]')).toBeNull();
      const standard = q('[data-testid="pile-history-recompute-standard"]');
      expect(standard?.textContent).toBe('Recompute with the standard base');
      calls.recomputeStandard.mockResolvedValueOnce('This project is read-only.');
      await act(async () => {
        standard?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await Promise.resolve();
      });
      expect(calls.recomputeStandard).toHaveBeenCalledWith('02');
      expect(calls.recomputeVolume).not.toHaveBeenCalled();
      expect(q('[data-testid="pile-history-problem"]')?.textContent).toBe(
        'This project is read-only.',
      );
    });

    it('shows Recompute as busy while the volume is worked out', () => {
      engine.running = { '02': true };
      render(empty());
      expect(q('[data-testid="pile-history-recompute"]')?.getAttribute('aria-busy')).toBe('true');
    });

    it('offers no Recompute in a read-only project, or before a surface is prepared', () => {
      render(empty({ readOnly: true }));
      expect(q('[data-testid="pile-history-none"]')).not.toBeNull();
      expect(q('[data-testid="pile-history-recompute"]')).toBeNull();
      engine.surfaces = [];
      render(empty());
      expect(q('[data-testid="pile-history-none"]')).not.toBeNull();
      expect(q('[data-testid="pile-history-recompute"]')).toBeNull();
    });
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
    // the pile and what the file holds (the profile's PNG is named after the pile too)
    expect(req?.defaultName).toBe('Pile-02-Volume-over-time.csv');
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

  it('the CSV weighs each date at its own density when the density changed from a later date', async () => {
    // 1.5 t/m³ from the first survey, 2 t/m³ from the second (Materials, "from" a survey date)
    const material = {
      id: 'agg',
      name: 'Aggregate 20 mm',
      densityTPerM3: 2,
      densityHistory: [
        { fromCapture: 'c1', tPerM3: 1.5 },
        { fromCapture: 'c2', tPerM3: 2 },
      ],
    };
    const dates = new Map(CAPTURES.map((c) => [c.id, Date.parse(c.date)]));
    const data = dataOf({ results: [result(100, 'c2')], series: [result(200, 'c1')] });
    render({ ...data, material, dateOf: (id: string) => dates.get(id) ?? null });
    await act(async () => {
      q('[data-testid="pile-history-csv"]')?.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
      await Promise.resolve();
    });
    const lines = calls.saveFile.mock.calls[0]?.[1].data.split(/\r?\n/) ?? [];
    const head = lines[0]?.split(',') ?? [];
    const tonnage = head.findIndex((h) => h.startsWith('Tonnage'));
    expect(tonnage).toBeGreaterThanOrEqual(0);
    const tonnesOn = (date: string) =>
      Number(lines.find((l) => l.includes(date))?.split(',')[tonnage]);
    // 200 m³ at 1.5 on the first date, 100 m³ at 2 on the second: never 400 and 200
    expect(tonnesOn('2020-12-31')).toBe(300);
    expect(tonnesOn('2021-01-10')).toBe(200);
    // the table beside it names each date's density (newest first)
    expect(cells().map((r) => r[2])).toEqual(['2.00', '1.50']);
  });
});
