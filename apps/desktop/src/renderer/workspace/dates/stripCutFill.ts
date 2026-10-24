/**
 * The dates strip's Cut & fill bars (spec section 5): one comparison between each pair of
 * consecutive surveys, with the Cut & fill tab's area rule and threshold (`cutFillPrefs`). Inside
 * piles, the piles' totals (or the selected pile's own row); whole site, the engine's site
 * comparison, and only the area shown is run. Answers are shared with the Cut & fill tab and kept
 * per pair, pile and threshold (`cutFill.ts`), so a change elsewhere asks only what is new, and a
 * superseded run stops asking. A pair whose dates lack a prepared surface waits for it; nothing is
 * estimated.
 */
import type { HeightTiles, SurveyMeasurement } from '@aio/schema';
import { useEffect, useMemo, useState } from 'react';
import { engineClient, useCompare } from '../../survey/compareStore';
import {
  captureRef,
  cutFillByPile,
  cutFillTotals,
  pairKey,
  pileRunKey,
  siteCellM,
  useCutFillPrefs,
  wholeSiteCutFill,
  type PileRun,
} from '../../survey/volumes/cutFill';
import type { CutFillPair } from './stripModel';

export interface StripCutFill {
  /** Computed pairs, oldest first. */
  bars: CutFillPair[];
  /** Pairs still waiting for a surface, with the date they wait for. */
  waiting: { from: string; to: string; on: string }[];
  /** True while a comparison runs. */
  computing: boolean;
}

/** Which surface a pair still needs, or null when both dates have one. */
export function pairNeeds(
  surfaces: readonly HeightTiles[],
  pair: { from: string; to: string },
): string | null {
  if (!captureRef(surfaces, pair.from)) return pair.from;
  if (!captureRef(surfaces, pair.to)) return pair.to;
  return null;
}

const stripRun: PileRun = async (ring, item, capture, id) => {
  const r = await engineClient().run(
    { ring, items: [item], ...(capture !== undefined ? { capture } : {}) },
    `strip:${item.from.kind === 'survey' ? item.from.capture : ''}:${id ?? ''}`,
  );
  const first = r.results[0];
  if (!first) throw new Error('The comparison gave no result.');
  return first;
};

const EMPTY: StripCutFill = { bars: [], waiting: [], computing: false };

export function useStripCutFill(
  enabled: boolean,
  pairs: readonly { from: string; to: string }[],
  piles: readonly SurveyMeasurement[],
  pile: string | null,
): StripCutFill {
  const surfaces = useCompare((s) => s.surfaces);
  const ready = useCompare((s) => s.status) === 'ready';
  const thresholdM = useCutFillPrefs((s) => s.thresholdM);
  const area = useCutFillPrefs((s) => s.area);
  const subset = useMemo(
    () => (pile !== null ? piles.filter((m) => m.id === pile) : piles),
    [piles, pile],
  );
  const runnable = pairs.filter((p) => pairNeeds(surfaces, p) === null);
  const waiting = pairs.flatMap((p) => {
    const on = pairNeeds(surfaces, p);
    return on === null ? [] : [{ ...p, on }];
  });
  const siteArea = pile === null && area === 'site';
  // what the runs read: the pairs' surfaces with their fingerprints, the threshold, the area and
  // the piles' rings (never `updatedAt`: saving the measurements does not ask again)
  const key =
    enabled && ready && runnable.length > 0
      ? JSON.stringify([
          runnable.map((p) => {
            const from = captureRef(surfaces, p.from);
            const to = captureRef(surfaces, p.to);
            return from && to ? pairKey(surfaces, { from, to }) : null;
          }),
          thresholdM,
          siteArea ? 'site' : 'piles',
          siteArea ? null : subset.map(pileRunKey),
          siteArea ? siteCellM(surfaces) : null,
        ])
      : null;
  const [done, setDone] = useState<{ key: string; bars: CutFillPair[]; all: boolean } | null>(null);
  useEffect(() => {
    if (key === null) return;
    const ac = new AbortController();
    void (async () => {
      const bars: CutFillPair[] = [];
      try {
        for (const p of runnable) {
          const from = captureRef(surfaces, p.from);
          const to = captureRef(surfaces, p.to);
          if (!from || !to) continue;
          const refs = { from, to };
          const pk = pairKey(surfaces, refs);
          if (siteArea) {
            // its own engine key: the Cut & fill tab's site run is never cancelled by the strip's
            const site = await wholeSiteCutFill(
              refs,
              thresholdM,
              siteCellM(surfaces),
              (req) => engineClient().site(req, `strip-site:${p.from}:${p.to}`),
              { pair: pk, signal: ac.signal },
            );
            if (site.status !== 'refused' && site.status !== 'stale')
              bars.push({ ...p, cutM3: site.cutM3, fillM3: site.fillM3 });
          } else {
            const rows = await cutFillByPile(subset, refs, thresholdM, stripRun, ac.signal, {
              pair: pk,
            });
            const tot = cutFillTotals(rows);
            if (tot.counted > 0) bars.push({ ...p, cutM3: tot.cutM3, fillM3: tot.fillM3 });
          }
          // each pair's bar shows as soon as it is known
          if (!ac.signal.aborted) setDone({ key, bars: [...bars], all: false });
        }
      } catch {
        // cancelled, or the engine failed: the bars computed so far stand, the rest stay empty
        if (ac.signal.aborted) return;
      }
      if (!ac.signal.aborted) setDone({ key, bars, all: true });
    })();
    return () => {
      ac.abort();
    };
    // the key names every input the run reads
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (!enabled) return EMPTY;
  const mine = done?.key === key ? done : null;
  return { bars: mine?.bars ?? [], waiting, computing: key !== null && !mine?.all };
}
