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
const bar = (h: HTMLElement, capture: string) => h.querySelector(`[data-bar="${capture}"]`);

describe('TimeChart', () => {
  it('latest date is highlighted', () => {
    const h = render({
      kind: 'volume',
      rows: [
        row('a', '2026-09-01', 100),
        row('b', '2026-09-15', 150, { changeM3: 50 }),
        row('c', '2026-10-01', 130, { changeM3: -20, latest: true }),
      ],
    });
    expect(bar(h, 'c')?.getAttribute('fill')).toBe('var(--chart-current)');
    expect(bar(h, 'a')?.getAttribute('fill')).toBe('var(--chart-earlier)');
    expect(bar(h, 'b')?.getAttribute('fill')).toBe('var(--chart-earlier)');
  });

  it('a missing date is a gap with its note, not a zero bar', () => {
    const h = render({
      kind: 'volume',
      rows: [
        row('a', '2026-09-01', 100),
        row('b', '2026-09-15', null),
        row('c', '2026-10-01', 90, { latest: true }),
      ],
    });
    expect(bar(h, 'b')).toBeNull();
    const gap = h.querySelector('[data-gap="b"]');
    expect(gap).not.toBeNull();
    expect(gap?.textContent).toContain('No survey data');
  });

  it('stale date is hatched with the stale tip', () => {
    const h = render({
      kind: 'volume',
      rows: [
        row('a', '2026-09-01', 100, { stale: true }),
        row('b', '2026-10-01', 90, { latest: true }),
      ],
    });
    expect(bar(h, 'a')?.getAttribute('fill')).toMatch(/^url\(#.*hatch/);
    expect(bar(h, 'b')?.getAttribute('fill')).toBe('var(--chart-current)');
    expect(h.querySelector('[data-stale="a"]')?.textContent).toContain('Stale, recompute');
    expect(h.querySelector('[data-stale="b"]')).toBeNull();
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
    const cx = (id: string) => Number(bar(h, id)?.getAttribute('data-cx'));
    expect((cx('c') - cx('b')) / (cx('b') - cx('a'))).toBeCloseTo(10, 1);
  });

  it('stack shows the total and names missing piles', () => {
    const rows: StackRow[] = [
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
    const h = render({
      kind: 'stack',
      rows,
      names: new Map([
        ['p1', 'North'],
        ['p2', 'East'],
        ['p3', 'South'],
      ]),
    });
    expect(h.querySelector('[data-total="a"]')?.textContent).toContain('300');
    expect(h.querySelectorAll('[data-part]').length).toBe(2);
    const note = h.querySelector('[data-testid="time-missing"]')?.textContent ?? '';
    expect(note).toContain('1 piles have no survey data on 01 Sep');
    expect(note).toContain('South');
  });

  it('values follow the volume unit', () => {
    const h = render(
      { kind: 'volume', rows: [row('a', '2026-09-01', 100, { latest: true })] },
      { units: IMPERIAL },
    );
    expect(h.textContent).toContain('yd');
    expect(bar(h, 'a')?.getAttribute('data-value')).toMatch(/130\.8/); // 100 m3 in yd3
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
  });
});
