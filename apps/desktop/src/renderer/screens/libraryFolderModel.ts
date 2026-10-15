import type { LibraryEntry, LibraryFolder } from '@aio/schema';

/** Where the Projects screen is: the whole library (loose cards and the folder row) or one folder. */
export type LibraryPlace = { kind: 'all' } | { kind: 'folder'; id: string };

/** The drag data type a project card carries; its value is the library id. */
export const DRAG_TYPE = 'application/x-quadrion-project';

/** How many cards each folder holds, by folder id. */
export function folderCounts(entries: readonly LibraryEntry[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const e of entries) {
    if (e.folderId !== undefined) counts.set(e.folderId, (counts.get(e.folderId) ?? 0) + 1);
  }
  return counts;
}

/** The filter of the Projects screen: name, customer or site, any case. */
export function matches(e: LibraryEntry, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  return [e.name, e.customer, e.site].some((v) => v?.toLowerCase().includes(needle));
}

/**
 * A search spans every folder; otherwise All shows loose cards, a folder its own. With `folders`
 * given, a card whose folder is not among them counts as loose (main sends only existing ids, so
 * this only keeps a stale answer from hiding a card).
 */
export function visibleEntries(
  entries: readonly LibraryEntry[],
  place: LibraryPlace,
  query: string,
  folders?: readonly LibraryFolder[],
): LibraryEntry[] {
  if (query.trim()) return entries.filter((e) => matches(e, query));
  const known = folders ? new Set(folders.map((f) => f.id)) : null;
  const folderOf = (e: LibraryEntry) =>
    e.folderId !== undefined && (known === null || known.has(e.folderId)) ? e.folderId : null;
  if (place.kind === 'all') return entries.filter((e) => folderOf(e) === null);
  return entries.filter((e) => folderOf(e) === place.id);
}

/** A place whose folder is gone falls back to All. */
export function settlePlace(place: LibraryPlace, folders: readonly LibraryFolder[]): LibraryPlace {
  if (place.kind === 'all' || folders.some((f) => f.id === place.id)) return place;
  return { kind: 'all' };
}
