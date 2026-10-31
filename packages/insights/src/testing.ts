/** Builders for the rule and flag fixtures (tests only). */
import type { ChangeSetSummary, ComparisonResult, SurveyQa } from '@aio/schema';
import type { SiteFigure } from './rules';

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

/** A pile's counted figure per date (`values` by capture id; null: no figure). */
export function fig(
  id: string,
  values: Readonly<Record<string, number | null>>,
  captures: readonly { id: string; date: string }[] = CAPTURES,
): SiteFigure {
  const dates = new Map(captures.map((c) => [c.id, c.date]));
  return {
    id,
    label: `Pile ${id}`,
    points: Object.entries(values).flatMap(([capture, v]) =>
      v === null ? [] : [{ capture, date: dates.get(capture) ?? '', valueM3: v }],
    ),
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
