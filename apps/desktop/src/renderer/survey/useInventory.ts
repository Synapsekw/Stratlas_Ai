/**
 * The one rule for a total of volume measurements (volumetric parity W3/W4), wherever it shows:
 * the site inventory per survey date (`inventorySeries`) with the app's own checks. A stored figure
 * is stale by the current fingerprints (`isStale`), a per-date one by the series check
 * (`seriesStale`), a date the series ran for without a figure has no survey data, and a pile whose
 * dates could not be worked out says why (`setSeriesFailed`, shared). The volumes view and the
 * selection totals both call it, so their totals and reasons cannot differ.
 */
import type { ComparisonResult, SurveyMeasurement } from '@aio/schema';
import { inventorySeries, seriesKeyOf, type StackRow } from '@aio/survey';
import { useMemo } from 'react';
import { createStore, useStore } from 'zustand';
import { isStale, seriesStale, useCompare } from './compareStore';

/** Why working out a measurement's dates last failed, by measurement (none once it works). */
const failures = createStore<{ failed: Readonly<Record<string, string>> }>(() => ({ failed: {} }));

/** Record why a measurement's dates could not be worked out, or `null` once they were. */
export function setSeriesFailed(id: string, why: string | null): void {
  const { failed } = failures.getState();
  if (why === null) {
    if (!(id in failed)) return;
    failures.setState({
      failed: Object.fromEntries(Object.entries(failed).filter(([k]) => k !== id)),
    });
  } else if (failed[id] !== why) failures.setState({ failed: { ...failed, [id]: why } });
}

/** Why working out a measurement's dates last failed (the card and every total read this). */
export const useSeriesFailed = (id: string): string | undefined =>
  useStore(failures, (s) => s.failed[id]);

export function useInventory(piles: readonly SurveyMeasurement[]): StackRow[] {
  const failed = useStore(failures, (s) => s.failed);
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
          return (
            item !== undefined &&
            seriesCurrent[m.id]?.[seriesKeyOf({ item: item.id, toCapture: capture })] !== undefined
          );
        },
      }),
    // seriesInputs is read by seriesStale
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [piles, captures, current, failed, seriesCurrent, seriesInputs],
  );
}
