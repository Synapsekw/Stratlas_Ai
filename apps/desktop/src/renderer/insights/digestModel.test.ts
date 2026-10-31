import { siteInsights } from '@aio/insights';
import {
  defaultSurveySettings,
  type ComparisonItem,
  type ComparisonResult,
  type SurveyMeasurement,
} from '@aio/schema';
import { inventoryPiles, inventorySeries, pileSeries, volumeRows } from '@aio/survey';
import { describe, expect, it } from 'vitest';
import { digestSnapshot, insightLine, localToday } from './digestModel';

const CAPTURES = [
  { id: 'm1', date: '2026-07-01', label: 'July' },
  { id: 'm2', date: '2026-08-01', label: 'August' },
];

const row = (
  item: string,
  toCapture: string,
  netM3: number,
  patch: Partial<ComparisonResult> = {},
) =>
  ({
    item,
    status: 'ok',
    cutM3: 0,
    fillM3: netM3,
    netM3,
    totalM3: netM3,
    areaM2: 1,
    areaCutM2: 0,
    areaFillM2: 1,
    areaUnchangedM2: 0,
    uncoveredM2: 0,
    fromLabel: 'Base',
    toLabel: toCapture,
    toCapture,
    deadbandM: 0,
    usedDeadband: false,
    cellM: 0.5,
    engine: 'ts',
    fingerprint: `${item}-${toCapture}`,
    computedAt: '2026-10-01T00:00:00.000Z',
    ...patch,
  }) as ComparisonResult;

const item = (id: string): ComparisonItem =>
  ({ id, from: { kind: 'lowest-point' }, to: { kind: 'current' }, useDeadband: false }) as never;

/** A pile with two comparisons: the first is the pile's figure, the second another base. */
const pile: SurveyMeasurement = {
  id: 'p',
  family: 'polygon',
  tool: 'volume',
  label: 'North pile',
  scope: { kind: 'site' },
  points: [
    [0, 0, 0],
    [1, 0, 0],
    [1, 1, 0],
  ],
  items: [item('a'), item('b')],
  results: [row('a', 'm2', 1300), row('b', 'm2', 9000)],
  series: [row('a', 'm1', 1000), row('b', 'm1', 5000), row('a', 'm2', 1250, { status: 'stale' })],
  createdAt: '2026-07-01T00:00:00.000Z',
};

/** The digest's snapshot as the app builds it, with the inventory's staleness kept to marks. */
function snapshot(ms: readonly SurveyMeasurement[], today = '2026-08-02') {
  const piles = inventoryPiles(ms);
  return digestSnapshot({
    manifest: { captures: CAPTURES, origin: [0, 0, 0] } as never,
    qa: {},
    settings: defaultSurveySettings(),
    piles,
    rows: inventorySeries(piles, CAPTURES),
    summaries: [],
    sets: {},
    isStale: () => false,
    today,
  });
}

describe('digestSnapshot', () => {
  it("takes a pile's figures by the card's rule: its first comparison, the stored figure for its date", () => {
    const figure = snapshot([pile]).figures[0];
    // the volume card's figures (`pileSeries` of the first comparison through `volumeRows`)
    const card = volumeRows(pileSeries(pile).series, CAPTURES, {
      isStale: (r) => r.status === 'stale',
    });
    expect(figure?.points.map((p) => [p.capture, p.valueM3])).toEqual(
      card.filter((r) => r.valueM3 !== null).map((r) => [r.capture, r.valueM3]),
    );
    expect(figure?.points.map((p) => p.valueM3)).toEqual([1000, 1300]);
  });

  it('leaves out a stale or refused figure, and measurements that are not volumes', () => {
    const stale: SurveyMeasurement = {
      ...pile,
      results: [row('a', 'm2', 1300, { status: 'stale' })],
    };
    expect(snapshot([stale]).figures[0]?.points.map((p) => p.capture)).toEqual(['m1']);
    const refused: SurveyMeasurement = {
      ...pile,
      results: [row('a', 'm2', 0, { status: 'refused' })],
    };
    expect(snapshot([refused]).figures[0]?.points.map((p) => p.capture)).toEqual(['m1']);
    expect(snapshot([{ ...pile, tool: 'area' }]).figures).toEqual([]);
  });

  it('leaves out the dates of a pile fixed to its dates (no current side)', () => {
    const fixed: SurveyMeasurement = {
      ...pile,
      items: [{ ...item('a'), to: { kind: 'survey', capture: 'm2' } } as never],
      results: [row('a', 'm2', 1300)],
    };
    expect(snapshot([fixed]).figures[0]?.points.map((p) => p.capture)).toEqual(['m2']);
  });
});

describe('insightLine', () => {
  const t = (key: string, vars: Record<string, string | number> = {}) =>
    `${key} ${JSON.stringify(vars)}`;

  it('formats quantities in the site units and dates as the app does', () => {
    const moved = siteInsights(snapshot([pile])).find((i) => i.rule === 'pile-moved');
    if (!moved) throw new Error('no pile-moved insight');
    const metric = insightLine(moved, t, defaultSurveySettings());
    expect(metric).toContain('"change":"300.0 m³"');
    expect(metric).toContain('"pct":"30"');
    expect(metric).toContain('"from":"1 Jul 2026"');
    const feet = {
      ...defaultSurveySettings(),
      units: { ...defaultSurveySettings().units, distance: 'ft', volume: 'yd3' },
    } as never;
    expect(insightLine(moved, t, feet)).toContain('"change":"392.4 yd³"');
  });
});

describe('localToday', () => {
  it('is the local calendar date', () => {
    expect(localToday(new Date(2026, 0, 5, 23, 30))).toBe('2026-01-05');
  });
});
