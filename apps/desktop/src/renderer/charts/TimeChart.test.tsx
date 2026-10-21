// @vitest-environment jsdom
import type { SurveyPrecision, SurveyUnits } from '@aio/schema';
import type { StackRow, TimeRow } from '@aio/survey';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { TimeChart, type TimeChartData } from './TimeChart';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const METRIC: SurveyUnits = {
  distance: 'm',
  area: 'm2',
  volume: 'm3',
  density: 't/m3',
  mass: 't',
  grade: 'percent',
};
const IMPERIAL: SurveyUnits = { ...METRIC, distance: 'ft', area: 'ft2', volume: 'yd3' };
const PRECISION: SurveyPrecision = { coordinate: 3, distance: 2, area: 1, volume: 1, grade: 1 };

const row = (
  capture: string,
  date: string,
  v: number | null,
  o: Partial<TimeRow> = {},
): TimeRow => ({
  capture,
  date,
  label: date,
  valueM3: v,
  changeM3: null,
  tonnes: null,
  status: v === null ? 'missing' : 'ok',
  stale: false,
  latest: false,
  ...o,
});

let root: Root | undefined;
let host: HTMLElement;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
});

function render(data: TimeChartData, p: { units?: SurveyUnits; interactive?: boolean } = {}) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root?.render(
      <TimeChart
        data={data}
        units={p.units ?? METRIC}
        precision={PRECISION}
        width={600}
        height={220}
        {...(p.interactive === undefined ? {} : { interactive: p.interactive })}
      />,
    ),
  );
  return host;
}
const dot = (h: HTMLElement, capture: string) => h.querySelector(`[data-dot="${capture}"]`);
const svgOf = (h: HTMLElement) => {
  const svg = h.querySelector('svg');
  if (!svg) throw new Error('no svg');
  return svg;
};

describe('TimeChart', () => {
  it('latest date is highlighted, following TimeRow.latest', () => {
    // `latest` sits on the middle row: a chart that recomputes it from the order would pick 'c'
    const h = render({
      kind: 'volume',
      rows: [
        row('a', '2026-09-01', 100),
        row('b', '2026-09-15', 150, { changeM3: 50, latest: true }),
        row('c', '2026-10-01', 130, { changeM3: -20 }),
      ],
    });
    expect(dot(h, 'b')?.getAttribute('fill')).toBe('var(--chart-current)');
    expect(dot(h, 'a')?.getAttribute('fill')).toBe('var(--chart-earlier)');
    expect(dot(h, 'c')?.getAttribute('fill')).toBe('var(--chart-earlier)');
    expect(Number(dot(h, 'b')?.getAttribute('r'))).toBeGreaterThan(
      Number(dot(h, 'a')?.getAttribute('r')),
    );
    expect(h.querySelector('rect[data-bar]')).toBeNull();
  });

  it('volume is a line through its dots, broken at a missing date', () => {
    const h = render({
      kind: 'volume',
      rows: [
        row('a', '2026-09-01', 100),
        row('b', '2026-09-10', 120),
        row('c', '2026-09-15', null),
        row('d', '2026-09-20', 90),
        row('e', '2026-09-25', 95, { latest: true }),
      ],
    });
    expect(h.querySelectorAll('polyline.tc-line').length).toBe(2);
    expect(h.querySelectorAll('circle[data-dot]').length).toBe(4);
  });

  it('a missing date is a gap with its note, not a zero point', () => {
    const h = render({
      kind: 'volume',
      rows: [
        row('a', '2026-09-01', 100),
        row('b', '2026-09-15', null),
        row('c', '2026-10-01', 90, { latest: true }),
      ],
    });
    expect(dot(h, 'b')).toBeNull();
    expect(h.querySelector('[data-gap="b"]')?.textContent).toContain('No survey data');
  });

  it('stale date is a hollow dot with the stale tip', () => {
    const h = render({
      kind: 'volume',
      rows: [
        row('a', '2026-09-01', 100, { stale: true }),
        row('b', '2026-10-01', 90, { latest: true }),
      ],
    });
    expect(dot(h, 'a')?.getAttribute('fill')).toBe('var(--bg-1)');
    expect(dot(h, 'a')?.getAttribute('stroke')).toBe('var(--chart-earlier)');
    expect(h.querySelector('[data-stale="a"]')?.textContent).toContain('Stale, recompute');
    expect(h.querySelector('[data-stale="b"]')).toBeNull();
    expect(dot(h, 'b')?.getAttribute('fill')).toBe('var(--chart-current)');
  });

  it('a partial date is a dashed hollow dot with its tip', () => {
    const h = render({
      kind: 'volume',
      rows: [
        row('a', '2026-09-01', 100, { status: 'partial' }),
        row('b', '2026-10-01', 90, { latest: true }),
      ],
    });
    expect(dot(h, 'a')?.getAttribute('fill')).toBe('var(--bg-1)');
    expect(dot(h, 'a')?.getAttribute('stroke-dasharray')).toBeTruthy();
    expect(h.querySelector('[data-partial="a"]')?.textContent).toContain('Partly outside');
    expect(dot(h, 'b')?.getAttribute('stroke-dasharray')).toBeNull();
  });

  it('x spacing follows dates', () => {
    const h = render({
      kind: 'volume',
      rows: [
        row('a', '2026-09-01', 10),
        row('b', '2026-09-02', 10),
        row('c', '2026-09-12', 10, { latest: true }),
      ],
    });
    const cx = (id: string) => Number(dot(h, id)?.getAttribute('data-cx'));
    expect((cx('c') - cx('b')) / (cx('b') - cx('a'))).toBeCloseTo(10, 1);
  });

  it('the value axis does not start at zero for a line', () => {
    const h = render({
      kind: 'volume',
      rows: [row('a', '2026-09-01', 1000), row('b', '2026-09-10', 1010, { latest: true })],
    });
    const ticks = [...h.querySelectorAll('[data-axis="z"] text')].map((n) => n.textContent);
    expect(ticks).not.toContain('0');
  });

  const stackRows: StackRow[] = [
    {
      capture: 'a',
      date: '2026-09-01',
      label: '01 Sep',
      totalM3: 300,
      parts: [
        { id: 'p1', valueM3: 100 },
        { id: 'p2', valueM3: 200 },
      ],
      missing: ['p3'],
    },
  ];
  const names = new Map([
    ['p1', 'North'],
    ['p2', 'East'],
    ['p3', 'South'],
  ]);

  it('stack shows the total, names missing piles and has a legend', () => {
    const h = render({ kind: 'stack', rows: stackRows, names });
    expect(h.querySelector('[data-total="a"]')?.textContent).toContain('300');
    expect(h.querySelectorAll('[data-part]').length).toBe(2);
    const note = h.querySelector('[data-testid="time-missing"]')?.textContent ?? '';
    expect(note).toContain('1 pile has no survey data on 01 Sep');
    expect(note).toContain('South');
    const legend = h.querySelector('[data-testid="time-legend"]')?.textContent ?? '';
    expect(legend).toContain('North');
    expect(legend).toContain('East');
  });

  it('stack shades are neutral, never the latest-survey colour', () => {
    const h = render({ kind: 'stack', rows: stackRows, names });
    for (const r of h.querySelectorAll('[data-part]')) {
      const fill = r.getAttribute('fill') ?? '';
      expect(fill).not.toContain('--chart-current');
      expect(fill).toContain('--chart-earlier');
    }
    const fills = [...h.querySelectorAll('[data-part]')].map((r) => r.getAttribute('fill'));
    expect(new Set(fills).size).toBe(2);
  });

  it("stack change is the inventory's, over the piles counted on both dates", () => {
    // date 1: A 100 + B 60; date 2: only A (110), B stale. Not 110 - 160 = -50
    const rows: StackRow[] = [
      {
        capture: 'a',
        date: '2026-09-01',
        label: '01 Sep',
        totalM3: 160,
        parts: [
          { id: 'p1', valueM3: 100 },
          { id: 'p2', valueM3: 60 },
        ],
        missing: [],
        change: null,
      },
      {
        capture: 'b',
        date: '2026-10-01',
        label: '01 Oct',
        totalM3: 110,
        parts: [{ id: 'p1', valueM3: 110 }],
        missing: [],
        change: { m3: 10, piles: 1, of: 2 },
      },
    ];
    const h = render({ kind: 'stack', rows, names });
    const plot = h.querySelector<HTMLElement>('[data-testid="time-plot"]');
    act(() => {
      plot?.focus();
    });
    const live = h.querySelector('[data-testid="time-live"]')?.textContent ?? '';
    const readout = h.querySelector('[data-testid="time-readout"]')?.textContent ?? '';
    expect(live).toContain('+10');
    expect(live).not.toContain('-50');
    expect(live).toContain('1 of 2 piles');
    expect(readout).toContain('+10');
    expect(readout).toContain('1 of 2 piles');
    act(() => {
      plot?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    });
    // no earlier date with piles in common: no change, never a made-up one
    const first = h.querySelector('[data-testid="time-live"]')?.textContent ?? '';
    expect(first).toContain('Change -');
  });

  it('missing piles use the plural form', () => {
    const [first] = stackRows;
    if (!first) throw new Error('fixture');
    const two: StackRow[] = [{ ...first, missing: ['p3', 'p1'] }];
    const h = render({ kind: 'stack', rows: two, names });
    expect(h.querySelector('[data-testid="time-missing"]')?.textContent).toContain(
      '2 piles have no survey data',
    );
  });

  it('values follow the volume unit', () => {
    const h = render(
      { kind: 'volume', rows: [row('a', '2026-09-01', 100, { latest: true })] },
      { units: IMPERIAL },
    );
    expect(h.textContent).toContain('yd');
    expect(dot(h, 'a')?.getAttribute('data-value')).toMatch(/130\.8/); // 100 m3 in yd3
  });

  it('elevation draws a line with dots and breaks at a missing date', () => {
    const h = render({
      kind: 'elevation',
      rows: [
        { capture: 'a', date: '2026-09-01', label: 'a', z: 10 },
        { capture: 'b', date: '2026-09-10', label: 'b', z: null },
        { capture: 'c', date: '2026-09-20', label: 'c', z: 12 },
      ],
    });
    expect(h.querySelectorAll('circle[data-dot]').length).toBe(2);
    expect(h.querySelector('[data-gap="b"]')).not.toBeNull();
    expect(dot(h, 'c')?.getAttribute('fill')).toBe('var(--chart-current)');
  });

  it('hover shows the date, the value and the change', () => {
    const h = render({
      kind: 'volume',
      rows: [
        row('a', '2026-09-01', 100),
        row('b', '2026-10-01', 130, { changeM3: 30, latest: true }),
      ],
    });
    expect(h.querySelector('[data-testid="time-readout"]')).toBeNull();
    const cxB = Number(dot(h, 'b')?.getAttribute('data-cx'));
    act(() => {
      svgOf(h).dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: cxB }));
    });
    const ro = h.querySelector('[data-testid="time-readout"]')?.textContent ?? '';
    expect(ro).toContain('2026-10-01');
    expect(ro).toContain('130');
    expect(ro).toContain('+30');
    expect(h.querySelector('[data-testid="time-live"]')?.textContent).toContain('2026-10-01');
    act(() => {
      svgOf(h).dispatchEvent(new MouseEvent('pointerout', { bubbles: true }));
    });
    expect(h.querySelector('[data-testid="time-readout"]')).toBeNull();
  });

  it('one tab stop: no focusable mark in the hidden svg, the plot reads the notes out', () => {
    const h = render({
      kind: 'volume',
      rows: [
        row('a', '2026-08-01', 90, { stale: true }),
        row('b', '2026-09-01', null),
        row('c', '2026-10-01', 130, { status: 'partial', latest: true }),
      ],
    });
    const svg = svgOf(h);
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.querySelectorAll('[tabindex], [aria-label]')).toHaveLength(0);
    const plot = h.querySelector<HTMLElement>('[data-testid="time-plot"]');
    expect(plot?.getAttribute('tabindex')).toBe('0');
    const live = () => h.querySelector('[data-testid="time-live"]')?.textContent ?? '';
    const readout = () => h.querySelector('[data-testid="time-readout"]')?.textContent ?? '';
    const press = (key: string) => {
      act(() => {
        plot?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
      });
    };
    act(() => {
      plot?.focus();
    });
    // the latest date first: partly outside the survey
    expect(live()).toContain('2026-10-01');
    expect(live()).toContain('Partly outside');
    expect(readout()).toContain('Partly outside');
    press('ArrowLeft');
    expect(live()).toContain('No survey data');
    press('ArrowLeft');
    expect(live()).toContain('Stale, recompute');
    expect(readout()).toContain('Stale, recompute');
  });

  it('static mode is an image with no handlers or live region', () => {
    const rows = [row('a', '2026-09-01', 100), row('b', '2026-10-01', 130, { latest: true })];
    const h = render({ kind: 'volume', rows }, { interactive: false });
    expect(svgOf(h).getAttribute('role')).toBe('img');
    expect(h.querySelector('[data-testid="time-live"]')).toBeNull();
    expect(h.querySelector('[tabindex]')).toBeNull();
    act(() => {
      svgOf(h).dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 300 }));
    });
    expect(h.querySelector('[data-testid="time-readout"]')).toBeNull();
  });

  it('no rows draws an empty frame without crashing', () => {
    const h = render({ kind: 'volume', rows: [] });
    expect(svgOf(h)).not.toBeNull();
    expect(h.querySelectorAll('circle[data-dot]').length).toBe(0);
  });

  it('a single date is one centred dot', () => {
    const h = render({ kind: 'volume', rows: [row('a', '2026-09-01', 100, { latest: true })] });
    expect(h.querySelectorAll('circle[data-dot]').length).toBe(1);
    expect(h.querySelectorAll('polyline.tc-line').length).toBe(0);
    expect(Number(dot(h, 'a')?.getAttribute('data-cx'))).toBeCloseTo(60 + (600 - 60 - 14) / 2, 0);
  });
});
