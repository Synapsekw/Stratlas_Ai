/**
 * Library covers kept on this computer: userData `covers/<sha256(library key)>.jpg`, served as
 * `aio://cover/<hash>.jpg?v=<mtime>` (protocol/handler.ts). A cover set here overrides the
 * project's own `thumbnail.jpg` on the card. `setCover` is the write side of
 * `library:setThumbnail`. The journal does not track `thumbnail.jpg`, so it needs no wrapping.
 */
import type { IpcResponse } from '@aio/schema';
import { createHash, randomBytes } from 'node:crypto';
import { lstat, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { detectFolder } from './library';
import { libraryKey } from './libraryView';
import type { Handle } from './notYet';
import { assertWritable } from './realDataGuard';

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

const isJpeg = (b: Uint8Array): boolean => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;

/** Write `data` to `file` through a temp file in the same folder, then rename it into place. */
async function writeAtomic(file: string, data: Uint8Array): Promise<void> {
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, data);
    await rename(tmp, file);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

const stampOf = (ms: number): string => `?v=${String(Math.round(ms))}`;

/** The project's own picture, as the card shows it, or null when it has none. */
async function ownThumbnail(id: string, path: string, isPackage: boolean): Promise<string | null> {
  if (isPackage) return null;
  try {
    const s = await stat(join(path, 'thumbnail.jpg'));
    return s.isFile() ? `aio://project/${id}/thumbnail.jpg${stampOf(s.mtimeMs)}` : null;
  } catch {
    return null;
  }
}

/**
 * Set (JPEG bytes) or clear (null) the card picture of one project. A native project folder keeps
 * its picture as `thumbnail.jpg`; a package, kit export, demo or linked folder keeps it in the
 * covers folder, so nothing outside the app's own data is ever written for them. Clearing removes
 * the custom cover only: the folder's own `thumbnail.jpg` is never removed.
 */
export async function setCover(o: {
  id: string;
  path: string;
  isPackage: boolean;
  demo: boolean;
  coversDir: string;
  data: Uint8Array | null;
}): Promise<IpcResponse<'library:setThumbnail'>> {
  const key = libraryKey(o.path, o.demo);
  const custom = coverFile(o.coversDir, key);
  if (o.data === null) {
    await rm(custom, { force: true });
    return { ok: true, thumbnail: await ownThumbnail(o.id, o.path, o.isPackage) };
  }
  if (!isJpeg(o.data)) return { ok: false, error: 'A cover must be a JPEG image.' };
  const link = await lstat(o.path)
    .then((s) => s.isSymbolicLink())
    .catch(() => false);
  const inFolder =
    !o.isPackage && !o.demo && !link && (await detectFolder(o.path).catch(() => null)) === 'native';
  if (inFolder) {
    const file = join(o.path, 'thumbnail.jpg');
    assertWritable(file, 'change the project thumbnail');
    await writeAtomic(file, o.data);
    // the folder picture wins from now on
    await rm(custom, { force: true });
    return {
      ok: true,
      thumbnail: `aio://project/${o.id}/thumbnail.jpg${stampOf((await stat(file)).mtimeMs)}`,
    };
  }
  await mkdir(o.coversDir, { recursive: true });
  await writeAtomic(custom, o.data);
  const hash = coverHash(key);
  return {
    ok: true,
    thumbnail: `aio://cover/${hash}.jpg${stampOf((await stat(custom)).mtimeMs)}`,
  };
}

export function registerCoverIpc(d: CoverDeps): void {
  d.handle('library:setThumbnail', async (req) => {
    const path = d.projects.path(req.projectId);
    if (path === undefined)
      return { ok: false, error: 'There is no such project. Reload the library.' };
    const isPackage = d.projects.package(req.projectId) !== undefined || /\.aio$/i.test(path);
    return setCover({
      id: req.projectId,
      path,
      isPackage,
      demo: await d.isDemo(path),
      coversDir: d.coversDir(),
      data: req.data,
    });
  });
}
