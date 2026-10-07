/**
 * Streaming SHA-256 of large binaries (M9 T6). Files reach many gigabytes, so nothing reads a whole
 * file into memory: bytes stream through the hash in chunks, with progress, cancel and an optional
 * read-rate cap so background indexing never starves playback. Results are cached by size, mtime
 * and inode, so a file is hashed again only after it changed.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';

export interface HashOptions {
  signal?: AbortSignal;
  /** Bytes hashed so far. */
  onProgress?: (done: number) => void;
  /** Read size; 1 MB by default. */
  chunkBytes?: number;
  /** Cap on the read rate (bytes per second); none by default. */
  maxBytesPerSecond?: number;
}

export interface Hashed {
  sha256: string;
  size: number;
}

/** The error a cancelled hash or transfer rejects with. */
export class CancelledError extends Error {
  constructor() {
    super('Cancelled.');
    this.name = 'CancelledError';
  }
}

export function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new CancelledError();
}

/**
 * Wait as long as needed to keep `done` bytes since `started` under `maxBytesPerSecond`. Shared by
 * hashing and transfers.
 */
export async function pace(
  done: number,
  started: number,
  maxBytesPerSecond: number | undefined,
  signal?: AbortSignal,
): Promise<void> {
  if (!maxBytesPerSecond || maxBytesPerSecond <= 0) return;
  const due = started + (done / maxBytesPerSecond) * 1000;
  const wait = due - Date.now();
  if (wait > 0) await sleep(wait, undefined, signal ? { signal } : {}).catch(() => undefined);
  throwIfCancelled(signal);
}

/** Hash a byte stream (a file, a transfer) without holding it in memory. */
export async function hashStream(
  source: AsyncIterable<Uint8Array>,
  o: HashOptions = {},
): Promise<Hashed> {
  const hash = createHash('sha256');
  let size = 0;
  const started = Date.now();
  throwIfCancelled(o.signal);
  for await (const chunk of source) {
    throwIfCancelled(o.signal);
    hash.update(chunk);
    size += chunk.byteLength;
    o.onProgress?.(size);
    await pace(size, started, o.maxBytesPerSecond, o.signal);
  }
  return { sha256: hash.digest('hex'), size };
}

/** Hash a file by streaming it, `chunkBytes` at a time. */
export async function hashFile(file: string, o: HashOptions = {}): Promise<Hashed> {
  const stream = createReadStream(file, { highWaterMark: o.chunkBytes ?? 1024 * 1024 });
  try {
    return await hashStream(stream, o);
  } catch (e) {
    if (e instanceof CancelledError || o.signal?.aborted) throw new CancelledError();
    throw e;
  } finally {
    stream.destroy();
  }
}

/** What identifies a file version without reading it. */
export interface FileStamp {
  size: number;
  mtimeMs: number;
  ino: number;
}

export interface HashCacheEntry extends FileStamp {
  sha256: string;
}

export async function stampOf(file: string): Promise<FileStamp | null> {
  try {
    const s = await stat(file);
    if (!s.isFile()) return null;
    return { size: s.size, mtimeMs: Math.round(s.mtimeMs), ino: s.ino };
  } catch {
    return null;
  }
}

const sameStamp = (a: FileStamp, b: FileStamp) =>
  a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino;

const isEntry = (v: unknown): v is HashCacheEntry => {
  if (!v || typeof v !== 'object') return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.sha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(e.sha256) &&
    typeof e.size === 'number' &&
    typeof e.mtimeMs === 'number' &&
    typeof e.ino === 'number'
  );
};

/** Hashes by project-relative path, valid while size, mtime and inode are unchanged. */
export class HashCache {
  private readonly entries = new Map<string, HashCacheEntry>();

  /** Rebuild from `toJSON()`; anything malformed is dropped (the cache is rebuildable). */
  static from(json: unknown): HashCache {
    const cache = new HashCache();
    if (json && typeof json === 'object') {
      for (const [k, v] of Object.entries(json as Record<string, unknown>)) {
        if (isEntry(v))
          cache.entries.set(k, { sha256: v.sha256, size: v.size, mtimeMs: v.mtimeMs, ino: v.ino });
      }
    }
    return cache;
  }

  get size(): number {
    return this.entries.size;
  }

  get(path: string, stamp: FileStamp): string | undefined {
    const e = this.entries.get(path);
    return e && sameStamp(e, stamp) ? e.sha256 : undefined;
  }

  set(path: string, stamp: FileStamp, sha256: string): void {
    this.entries.set(path, { ...stamp, sha256 });
  }

  /** Keep only these paths. */
  retain(paths: ReadonlySet<string>): void {
    for (const k of [...this.entries.keys()]) if (!paths.has(k)) this.entries.delete(k);
  }

  toJSON(): Record<string, HashCacheEntry> {
    return Object.fromEntries(this.entries);
  }
}

/** The file's hash from the cache when its stamp is unchanged, else hashed (and cached). */
export async function cachedHash(
  cache: HashCache,
  key: string,
  file: string,
  o: HashOptions = {},
): Promise<Hashed & { cached: boolean }> {
  const stamp = await stampOf(file);
  if (!stamp) throw new Error(`${key} is not a file.`);
  const hit = cache.get(key, stamp);
  if (hit) return { sha256: hit, size: stamp.size, cached: true };
  const out = await hashFile(file, o);
  // A file that changed while it was read is not cached; the next index reads it again.
  const after = await stampOf(file);
  if (after && sameStamp(after, stamp) && out.size === stamp.size)
    cache.set(key, stamp, out.sha256);
  return { ...out, cached: false };
}
