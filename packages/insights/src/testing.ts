/** Builders for the rule and flag fixtures (tests only). */
import type { ChangeSetSummary, ComparisonResult, SurveyMeasurement, SurveyQa } from '@aio/schema';

export const CAPTURES = [
  { id: 'm1', date: '2026-07-01', label: 'July' },
  { id: 'm2', date: '2026-08-01', label: 'August' },
  { id: 'm3', date: '2026-09-01', label: 'September' },
];

export function qaFile(capture: string, patch: Partial<SurveyQa> = {}): SurveyQa {
  return {
    schema: 'aio.survey-qa/1',
    capture,
    level: 'moderate',
    status: 'pass',
    checkedAt: '2026-10-01T00:00:00.000Z',
    ...patch,
  };
}

export const checkpoints = (rmseM: number, count = 4): NonNullable<SurveyQa['checkpoints']> => ({
  count,
  rmseM,
  meanM: 0,
  maxAbsM: rmseM,
  points: [],
});

export function result(
  toCapture: string,
  netM3: number,
  patch: Partial<ComparisonResult> = {},
): ComparisonResult {
  return {
    item: 'vol',
    status: 'ok',
    cutM3: 0,
    fillM3: Math.max(0, netM3),
    netM3,
    totalM3: Math.abs(netM3),
    areaM2: 100,
    areaCutM2: 0,
    areaFillM2: 100,
    areaUnchangedM2: 0,
    uncoveredM2: 0,
    fromLabel: 'Base',
    toLabel: toCapture,
    toCapture,
    deadbandM: 0,
    usedDeadband: false,
    cellM: 0.5,
    engine: 'ts',
    fingerprint: `fp-${toCapture}`,
    computedAt: '2026-10-01T00:00:00.000Z',
    ...patch,
  };
}

/** A stockpile polygon with a figure per date (`values` by capture id; null: no figure). */
export function pile(
  id: string,
  values: Readonly<Record<string, number | null>>,
  patch: Partial<SurveyMeasurement> = {},
): SurveyMeasurement {
  const series = Object.entries(values).flatMap(([c, v]) => (v === null ? [] : [result(c, v)]));
  return {
    id,
    family: 'polygon',
    tool: 'volume',
    label: `Pile ${id}`,
    scope: { kind: 'site' },
    points: [
      [0, 0, 0],
      [10, 0, 0],
      [10, 10, 0],
    ],
    items: [],
    results: series.slice(-1),
    series,
    createdAt: '2026-07-01T00:00:00.000Z',
    ...patch,
  };
}

export function summary(
  from: string,
  to: string,
  patch: Partial<ChangeSetSummary> = {},
): ChangeSetSummary {
  return {
    id: `${from}-${to}-issues`,
    from,
    to,
    producer: 'issues',
    createdAt: '2026-10-01T00:00:00.000Z',
    items: 3,
    open: 3,
    ...patch,
  };
}
