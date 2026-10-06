/**
 * Binaries by content (M9 stream T6): status, fetch policies, downloads and indexing (`blobs:*`,
 * event `blobs:progress`); `aio://` answers a missing blob with `MISSING_BLOB_HEADER`. T0 stubs:
 * every channel answers "not available yet" until T6 fills it.
 */
import { notYet, type Handle } from './notYet';

export interface BlobsIpcDeps {
  handle: Handle;
}

export function registerBlobsIpc({ handle }: BlobsIpcDeps): void {
  const what = 'Files on demand';
  handle('blobs:status', () => notYet(what));
  handle('blobs:fetch', () => notYet(what));
  handle('blobs:cancel', () => ({ ok: false }));
  handle('blobs:policy', () => notYet(what));
  handle('blobs:index', () => notYet(what));
}
