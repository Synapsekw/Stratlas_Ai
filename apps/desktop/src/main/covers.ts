/**
 * Library covers kept on this computer: userData `covers/<sha256(library key)>.jpg`, served as
 * `aio://cover/<hash>.jpg?v=<mtime>` (protocol/handler.ts). A cover set here overrides the
 * project's own `thumbnail.jpg` on the card. This file holds the read side; changing a cover
 * (`library:setThumbnail`) answers "not yet" until the write side lands.
 */
import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { notYet, type Handle } from './notYet';

/** sha256 hex of a library key: the cover's file name, safe for any path or demo id. */
export const coverHash = (key: string): string => createHash('sha256').update(key).digest('hex');

/** The cover file of a library key in `dir`. */
export const coverFile = (dir: string, key: string): string => join(dir, `${coverHash(key)}.jpg`);

/** Hash and modification time of the cover of `key`, or null when it has none. */
export async function coverStamp(
  dir: string,
  key: string,
): Promise<{ hash: string; mtimeMs: number } | null> {
  const hash = coverHash(key);
  try {
    const s = await stat(join(dir, `${hash}.jpg`));
    return s.isFile() ? { hash, mtimeMs: s.mtimeMs } : null;
  } catch {
    return null;
  }
}

export interface CoverDeps {
  handle: Handle;
  /** Where a library id points: a project folder or a `.aio` file. */
  projects: { path(id: string): string | undefined; package(id: string): unknown };
  /** Is this path one of the demo projects that ship with the app (or its working copy)? */
  isDemo: (path: string) => Promise<boolean>;
  /** userData `covers/`. */
  coversDir: () => string;
}

export function registerCoverIpc(d: CoverDeps): void {
  d.handle('library:setThumbnail', () => notYet('Changing the thumbnail'));
}
