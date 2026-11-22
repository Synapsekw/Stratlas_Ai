/**
 * Each pile's volume per survey date, worked out while something that shows those figures is on
 * screen: Project > Volumes for every pile, and the pile panel for the pile it shows. The panel
 * needs its own run: a pile filed under one date shows a figure of this series on every other
 * date, and with the panel alone on screen (opened from 3D, the Map or after the list) a change
 * of its base or outline would leave that figure as it was.
 */
import { useAnnotateReadOnly } from '@aio/annotate';
import type { SurveyMeasurement } from '@aio/schema';
import { surfacesStamp } from '@aio/survey';
import { useEffect, useRef } from 'react';
import { computeSeries, hasCarried, neighboursKey, useCompare } from '../compareStore';
import { setSeriesFailed } from '../useInventory';

/**
 * What a pile's dates were last worked out for: its edits, its comparisons, whether it still holds
 * a carried kit figure (a carried pile has no dates to work out; the app's quiet acceptance changes
 * nothing else, so without this its dates were never worked out) and the piles next to it (an edge
 * shared with one is left out of its base).
 */
const stampOf = (m: SurveyMeasurement) =>
  `${m.updatedAt ?? m.createdAt}|${JSON.stringify(m.items)}|${String(m.points.length)}|${String(hasCarried(m))}|${neighboursKey(m)}`;

/**
 * Each pile's volume per survey date, worked out while the Volumes tab shows (carried piles keep
 * the kit's): only the piles changed since their last run are run again, every pile once the
 * dates or the prepared surfaces change (a run made before Prepare surfaces is redone). A
 * read-only project works its dates out too, held in memory and never written.
 */
export function useSeriesRun(piles: readonly SurveyMeasurement[]): void {
  const lookOnly = useAnnotateReadOnly();
  const status = useCompare((s) => s.status);
  const captures = useCompare((s) => s.captures);
  const surfaces = useCompare((s) => s.surfaces);
  const ran = useRef(new Map<string, string>());
  const ranFor = useRef('');
  const runFor = `${status}|${String(lookOnly)}|${captures.map((c) => c.id).join(',')}|${surfacesStamp(surfaces)}`;
  useEffect(() => {
    if (ranFor.current !== runFor) {
      ran.current.clear();
      ranFor.current = runFor;
    }
    if (status !== 'ready' || lookOnly || captures.length === 0) return;
    const todo = piles.filter((m) => m.items.length > 0 && ran.current.get(m.id) !== stampOf(m));
    if (todo.length === 0) return;
    const run = { gone: false };
    void (async () => {
      for (const m of todo) {
        if (run.gone) return;
        const stamp = stampOf(m);
        try {
          await computeSeries(m.id);
          setSeriesFailed(m.id, null);
        } catch (e) {
          // the totals name the pile as not counted, with why
          console.warn(`The volume over time of ${m.id} could not be worked out`, e);
          setSeriesFailed(m.id, e instanceof Error ? e.message : String(e));
        }
        ran.current.set(m.id, stamp);
      }
    })();
    return () => {
      run.gone = true;
    };
  }, [status, lookOnly, captures.length, piles, runFor]);
}
