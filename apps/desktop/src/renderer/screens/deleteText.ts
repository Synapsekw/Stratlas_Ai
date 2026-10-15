import type { LibraryEntry } from '@aio/schema';
import type { MessageKey } from '@aio/ui';

/**
 * What the delete confirm says moves to the recycle bin, by kind of card, and the path it names
 * (null: nothing on disk is deleted). A demo names its working copy (`demo.copy`, the folder the
 * main process trashes), never the folder that ships with the app.
 */
export function deleteText(entry: LibraryEntry): {
  text: MessageKey;
  label: MessageKey;
  path: string | null;
} {
  const path = entry.path;
  if (entry.package)
    return { text: 'library.delete.text.package', label: 'library.delete.file', path };
  if (entry.demo) {
    const copy = entry.demo.copy;
    return copy === undefined
      ? { text: 'library.delete.text.demoNone', label: 'library.delete.folder', path: null }
      : { text: 'library.delete.text.demo', label: 'library.delete.folder', path: copy };
  }
  if (entry.kind !== 'native') {
    return { text: 'library.delete.text.kit', label: 'library.delete.folder', path };
  }
  return { text: 'library.delete.text', label: 'library.delete.folder', path };
}
