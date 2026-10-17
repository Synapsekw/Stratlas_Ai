/**
 * Catalogue lookup and search (spec D10). The seed files live in `packages/rf/catalogue/*.json`
 * (`aio.rf-catalogue/1`); the desktop main process reads and validates them and hands the entries
 * here, so this module stays pure and runs in the renderer and the worker.
 */

import type { RfCatalogueEntry } from '@aio/schema';
import { bandById } from './bands';

export type CatalogueKind = RfCatalogueEntry['kind'];

export interface CatalogueQuery {
  /** Every word must appear in the vendor, model or id (case-insensitive). */
  text?: string;
  /** Vendor name, case-insensitive, exact. */
  vendor?: string;
  /** A band id from the band table (for example `n78` or `b3-n3`): the entry must overlap its downlink range. */
  band?: string;
  kind?: CatalogueKind;
}

export function getEntry(
  entries: readonly RfCatalogueEntry[],
  id: string,
): RfCatalogueEntry | undefined {
  return entries.find((e) => e.id === id);
}

/** Frequency ranges an entry covers, MHz [low, high]. */
export function entryBandRanges(e: RfCatalogueEntry): [number, number][] {
  if (e.kind === 'antenna') return e.ports.map((p) => [p.bandRangeMhz[0], p.bandRangeMhz[1]]);
  return [[e.bandRangeMhz[0], e.bandRangeMhz[1]]];
}

export function searchCatalogue(
  entries: readonly RfCatalogueEntry[],
  q: CatalogueQuery,
): RfCatalogueEntry[] {
  const words = (q.text ?? '')
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w !== '');
  const vendor = q.vendor?.toLowerCase();
  const band = q.band === undefined ? undefined : bandById(q.band);
  if (q.band !== undefined && !band) return [];
  return entries.filter((e) => {
    if (q.kind && e.kind !== q.kind) return false;
    if (vendor !== undefined && e.vendor.toLowerCase() !== vendor) return false;
    if (band) {
      const [lo, hi] = band.dlRangeMHz;
      if (!entryBandRanges(e).some(([a, b]) => b >= lo && a <= hi)) return false;
    }
    if (words.length > 0) {
      const hay = `${e.vendor} ${e.model} ${e.id}`.toLowerCase();
      if (!words.every((w) => hay.includes(w))) return false;
    }
    return true;
  });
}

/** Distinct vendor names, sorted, for a filter list. */
export function catalogueVendors(entries: readonly RfCatalogueEntry[]): string[] {
  return [...new Set(entries.map((e) => e.vendor))].sort((a, b) => a.localeCompare(b));
}

/** Join catalogues in priority order: a later source replaces an earlier entry with the same id. */
export function mergeCatalogues(
  ...sources: readonly (readonly RfCatalogueEntry[])[]
): RfCatalogueEntry[] {
  const byId = new Map<string, RfCatalogueEntry>();
  for (const s of sources) for (const e of s) byId.set(e.id, e);
  return [...byId.values()];
}
