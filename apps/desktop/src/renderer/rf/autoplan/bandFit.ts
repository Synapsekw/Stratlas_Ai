/** Whether catalogue equipment can carry a band: the band's downlink range must lie inside it. */
import { bandOfName } from '@aio/rf';
import type { RfCatalogueEntry } from '@aio/schema';

type Range = readonly [number, number];

function holds(range: Range, dl: Range): boolean {
  return range[0] <= dl[0] && range[1] >= dl[1];
}

/**
 * True when the band's downlink range lies inside the entry's range: a radio's or an AAU's
 * `bandRangeMhz`, or the range of at least one antenna port. False for an unknown band.
 */
export function entryCoversBand(entry: RfCatalogueEntry, band: string): boolean {
  const dl = bandOfName(band)?.dlRangeMHz;
  if (!dl) return false;
  if (entry.kind === 'antenna') return entry.ports.some((p) => holds(p.bandRangeMhz, dl));
  return holds(entry.bandRangeMhz, dl);
}
