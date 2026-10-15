import type { LibraryEntry } from '@aio/schema';
import type { MessageKey } from '@aio/ui';

/**
 * What the delete confirm says moves to the recycle bin, by kind of card. A demo shows its own text
 * even when no working copy exists: only the main process knows, and it answers `nothing` silently.
 */
export function deleteText(entry: LibraryEntry): { text: MessageKey; label: MessageKey } {
  if (entry.package) return { text: 'library.delete.text.package', label: 'library.delete.file' };
  if (entry.demo) return { text: 'library.delete.text.demo', label: 'library.delete.folder' };
  if (entry.kind !== 'native') {
    return { text: 'library.delete.text.kit', label: 'library.delete.folder' };
  }
  return { text: 'library.delete.text', label: 'library.delete.folder' };
}
