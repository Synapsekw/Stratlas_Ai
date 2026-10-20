/**
 * The one rule for a total of volume measurements (volumetric parity W3/W4), wherever it shows:
 * the site inventory per survey date (`inventorySeries`) with the app's own checks. A stored figure
 * is stale by the current fingerprints (`isStale`), a per-date one by the series check
 * (`seriesStale`), and a date the series ran for without a figure has no survey data. The volumes
 * view and the selection totals both call it, so their totals cannot differ.
 */
import type { ComparisonResult, SurveyMeasurement } from '@aio/schema';
import { inventorySeries, type StackRow } from '@aio/survey';
import { useMemo } from 'react';
import { isStale, seriesStale, useCompare } from './compareStore';

const NO_FAILURES: Readonly<Record<string, string>> = {};

export function useInventory(
  piles: readonly SurveyMeasurement[],
  failed: Readonly<Record<string, string>> = NO_FAILURES,
): StackRow[] {
  const captures = useCompare((s) => s.captures);
  const current = useCompare((s) => s.current);
  // what `seriesStale` reads, and which dates the series ran for
  const seriesCurrent = useCompare((s) => s.seriesCurrent);
  const seriesInputs = useCompare((s) => s.seriesInputs);
  return useMemo(
    () =>
      inventorySeries(piles, captures, {
        isStale: (m: SurveyMeasurement, r: ComparisonResult, stored: boolean) =>
          stored ? isStale({ current }, m, r) : seriesStale(m, r),
        failed: (m) => failed[m.id],
        ran: (m, capture) => {
          const item = m.items[0];
          return item !== undefined && seriesCurrent[m.id]?.[`${item.id} ${capture}`] !== undefined;
        },
      }),
    // seriesInputs is read by seriesStale
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [piles, captures, current, failed, seriesCurrent, seriesInputs],
  );
}
