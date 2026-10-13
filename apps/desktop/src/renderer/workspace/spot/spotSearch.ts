import type { CaptureIndex } from '@aio/workspace';
import { matchEntry } from './spotMatchers';
import { originCapture, spotOf } from './spotOrigin';
import type {
  Spot,
  SpotDate,
  SpotEntry,
  SpotHistory,
  SpotItem,
  SpotKind,
  SpotMatch,
  SpotOpen,
} from './spotTypes';

/**
 * The spot search (spec Part S1): every survey date, oldest first, with its matches ranked
 * (the spot's class first, ground-level or aerial, then the score) and the items that cannot
 * match counted. One linear pass; nothing is indexed or stored.
 */
export interface SearchInput {
  spot: Spot;
  entries: readonly SpotEntry[];
  /** Survey dates, oldest first. */
  captures: readonly string[];
  /**
   * The clicked item and its date. It fills the first place of its own date; an undated origin
   * (`capture` undefined) gets no slot. Whatever `selfMatch` later needs from the origin's entry
   * (a walk sample's bearing) is read from `entries` inside `searchSpot`, so this shape holds.
   */
  origin?: { item: SpotItem; capture: string | undefined };
}

const unplaced = (e: SpotEntry): boolean =>
  (e.kind === 'photo' && !e.pos) || ((e.kind === 'walk' || e.kind === 'video') && !e.samples);

/** The same photo or panorama; for walks and clips, the same layer (one match per layer). */
export function sameItem(a: SpotItem, b: SpotItem): boolean {
  if (a.layer !== b.layer) return false;
  if (a.kind === 'photo') return b.kind === 'photo' && a.photo === b.photo;
  if (a.kind === 'pano') return b.kind === 'pano' && a.pano === b.pano;
  return a.kind === b.kind;
}

/** The clicked item as a match of its own spot (the viewer shows an undated one through it). */
export function selfMatch(item: SpotItem, capture: string, spot: Spot): SpotMatch {
  const kind: SpotKind = item.kind === 'photo' ? (spot.aerial ? 'drone' : 'photo') : item.kind;
  return {
    capture,
    kind,
    item,
    aerial: spot.aerial,
    distanceM: 0,
    angleDeg: 0,
    ...(spot.bearingDeg !== undefined ? { lookDeg: spot.bearingDeg } : {}),
    score: -Infinity,
  };
}

export function searchSpot(input: SearchInput): SpotHistory {
  const { spot } = input;
  const dates = input.captures.map((capture): SpotDate => ({ capture, matches: [], skipped: 0 }));
  const byCapture = new Map(dates.map((d) => [d.capture, d]));
  for (const e of input.entries) {
    const date = e.capture === undefined ? undefined : byCapture.get(e.capture);
    if (!date) continue;
    if (unplaced(e)) {
      date.skipped++;
      continue;
    }
    const m = matchEntry(spot, e);
    if (m) date.matches.push({ ...m, capture: date.capture });
  }
  const cls = (m: SpotMatch) => (m.aerial === spot.aerial ? 0 : 1);
  // Array.prototype.sort is stable, so equal scores keep entry order.
  for (const d of dates) d.matches.sort((a, b) => cls(a) - cls(b) || a.score - b.score);
  const o = input.origin;
  const own = o?.capture === undefined ? undefined : byCapture.get(o.capture);
  if (o && own)
    own.matches = [
      selfMatch(o.item, own.capture, spot),
      ...own.matches.filter((m) => !sameItem(m.item, o.item)),
    ];
  return { spot, dates };
}

export type HistoryResult = { history: SpotHistory } | { error: 'noPosition' };

/** The history of a clicked item, or why there is none. */
export function historyFor(
  open: SpotOpen,
  entries: readonly SpotEntry[],
  index: Pick<CaptureIndex, 'captures'>,
): HistoryResult {
  const spot = spotOf(open, entries);
  if (!spot) return { error: 'noPosition' };
  return {
    history: searchSpot({
      spot,
      entries,
      captures: index.captures.map((c) => c.id),
      origin: { item: open.item, capture: originCapture(open.item, entries) },
    }),
  };
}
