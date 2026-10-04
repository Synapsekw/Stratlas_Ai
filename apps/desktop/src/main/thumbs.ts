/**
 * Thumbnails of project images for grids (Media). `aio://thumb/<id>/<path>` answers with, in
 * order: the thumbnail the project carries (`<dir>/thumbs/<name>.jpg`, data-conventions section
 * 2), a thumbnail cached in userData `cache/thumbs/`, or 404. On a 404 the renderer makes the
 * thumbnail off its main thread (a worker) and stores it with IPC `thumbs:put`. Delivered project
 * files are never written.
 */
import type { ZipArchive } from '@aio/project/package';
import { createHash } from 'node:crypto';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { resolveInside } from './protocol/paths';

const IMAGE = /\.(jpe?g|png|webp)$/i;
/** Largest thumbnail the cache accepts (the renderer makes about 320 px JPEGs of 20 to 40 KB). */
export const MAX_THUMB_BYTES = 512 * 1024;

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** A clean project-relative path (forward slashes, no parent or empty segments), or null. */
export function cleanRel(rel: string): string | null {
  const parts = rel.replace(/\\/g, '/').split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..' || p.includes('\0'))) return null;
  if (/^[a-z]:$/i.test(parts[0] ?? '')) return null;
  return parts.join('/');
}

/**
 * The thumbnail a project may carry for an image: `photos/p001.jpg` has `photos/thumbs/p001.jpg`.
 * Null for files that are not images.
 */
export function projectThumbPath(rel: string): string | null {
  if (!IMAGE.test(rel)) return null;
  const parts = rel.split('/');
  const name = parts.pop() ?? '';
  if (parts.at(-1) === 'thumbs') return rel;
  return [...parts, 'thumbs', name.replace(IMAGE, '.jpg')].join('/');
}

/**
 * Cache file of the generated thumbnail of one source image. The key holds the project's
 * location and the source's size and date, so a changed or replaced image gets a new thumbnail.
 */
export function thumbCacheFile(
  cacheDir: string,
  source: { where: string; rel: string; size: number; mtimeMs: number },
): string {
  const folder = sha(source.where).slice(0, 16);
  const key = sha(`${source.rel}|${String(source.size)}|${String(Math.round(source.mtimeMs))}`);
  return join(cacheDir, folder, `${key.slice(0, 40)}.jpg`);
}

/** True for JPEG bytes (SOI marker). */
export function isJpeg(data: Uint8Array): boolean {
  return data.length > 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
}

export interface ThumbSource {
  /** Folder project root, or undefined for a package. */
  root?: string;
  archive?: ZipArchive;
}

export type ThumbLookup =
  | { kind: 'file'; path: string }
  | { kind: 'member'; archive: ZipArchive; name: string }
  | { kind: 'missing' }
  | { kind: 'forbidden' };

/** Identity of the source image for the cache key, or null when it does not exist. */
async function sourceKey(
  src: ThumbSource,
  rel: string,
): Promise<{ where: string; rel: string; size: number; mtimeMs: number } | 'forbidden' | null> {
  if (src.archive) {
    const e = src.archive.entries.get(rel);
    if (!e) return null;
    return { where: `package:${src.archive.file}`, rel, size: e.size, mtimeMs: 0 };
  }
  if (src.root === undefined) return null;
  const r = await resolveInside(src.root, rel);
  if (!r.ok) return r.status === 403 ? 'forbidden' : null;
  const s = await stat(r.path);
  return { where: src.root, rel, size: s.size, mtimeMs: s.mtimeMs };
}

/** Where the thumbnail of `rel` is, if it exists yet. */
export async function findThumb(
  src: ThumbSource,
  rawRel: string,
  cacheDir: string,
): Promise<ThumbLookup> {
  const rel = cleanRel(rawRel);
  if (!rel) return { kind: 'forbidden' };
  const own = projectThumbPath(rel);
  if (!own) return { kind: 'missing' };
  if (src.archive) {
    if (src.archive.entries.has(own)) return { kind: 'member', archive: src.archive, name: own };
  } else if (src.root !== undefined) {
    const r = await resolveInside(src.root, own);
    if (r.ok) return { kind: 'file', path: r.path };
    if (r.status === 403) return { kind: 'forbidden' };
  }
  const key = await sourceKey(src, rel);
  if (key === 'forbidden') return { kind: 'forbidden' };
  if (!key) return { kind: 'missing' };
  const file = thumbCacheFile(cacheDir, key);
  try {
    if ((await stat(file)).isFile()) return { kind: 'file', path: file };
  } catch {
    // not generated yet
  }
  return { kind: 'missing' };
}

/** Store a generated thumbnail for `rel` in the cache. False when the request is not valid. */
export async function putThumb(
  src: ThumbSource,
  rawRel: string,
  data: Uint8Array,
  cacheDir: string,
): Promise<boolean> {
  const rel = cleanRel(rawRel);
  if (!rel || !IMAGE.test(rel)) return false;
  if (data.byteLength > MAX_THUMB_BYTES || !isJpeg(data)) return false;
  const key = await sourceKey(src, rel);
  if (!key || key === 'forbidden') return false;
  const file = thumbCacheFile(cacheDir, key);
  const part = `${file}.${String(process.pid)}.part`;
  try {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(part, data);
    await rename(part, file);
    return true;
  } catch {
    await rm(part, { force: true });
    return false;
  }
}
