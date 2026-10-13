import { dateTags, useWorkspace, type CaptureIndex, type DateTag } from '@aio/workspace';
import { useMemo } from 'react';
import { useCaptureIndex } from '../compare';
import { originCapture } from './spotOrigin';
import { historyFor, type HistoryResult } from './spotSearch';
import type { SpotEntry, SpotOpen } from './spotTypes';
import { useSpotEntries } from './useSpotEntries';

export interface SpotHistoryView {
  entries: SpotEntry[];
  /** Flight logs are still being read (clips join the search when they arrive). */
  reading: boolean;
  index: CaptureIndex | null;
  tags: Readonly<Record<string, DateTag>>;
  /** Null while nothing is open or the project's dates are not known yet. */
  result: HistoryResult | null;
  /** The clicked item's survey date; undefined for an undated layer. */
  origin: string | undefined;
}

/**
 * The spot history of `open` in the open project, for the viewer and the inline strip: the
 * entries (flight logs read only while `active`), the dates' tags, the search result and the
 * clicked item's own date.
 */
export function useSpotHistory(open: SpotOpen | null, active: boolean): SpotHistoryView {
  const index = useCaptureIndex();
  const layers = useWorkspace((s) => s.project?.manifest.layers);
  const { entries, reading } = useSpotEntries(active);
  // from the layer, not the entries: a clip or walk still being read keeps its date
  const origin = useMemo(
    () => (open && index && layers ? originCapture(open.item, layers, index) : undefined),
    [open, index, layers],
  );
  const result = useMemo(
    () => (open && index ? historyFor(open, entries, index, origin) : null),
    [open, entries, index, origin],
  );
  const tags = useMemo(() => (index ? dateTags(index.captures) : {}), [index]);
  return { entries, reading, index, tags, result, origin };
}
