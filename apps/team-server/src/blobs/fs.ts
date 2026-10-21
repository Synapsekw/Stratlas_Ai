/**
 * Blobs on the server's file system (the default): `<root>/<aa>/<sha256>` for complete blobs and
 * `<root>/partial/<device>/<sha256>.part` while a device uploads one. A finished upload is hashed,
 * then renamed into place, so a reader never sees half a blob. Each device has its own unfinished
 * uploads (nobody can add bytes to another device's), a quota for them, and an unfinished upload
 * left alone longer than `partialTtlMs` is deleted.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { BlobHashError, BlobOffsetError, BlobQuotaError, type BlobStore } from './blobStore';

const SHA = /^[a-f0-9]{64}$/;
const DEVICE = /^d_[a-z2-7]{52}$/;

/** Unfinished uploads per device: 64 GB by default. */
export const DEFAULT_PARTIAL_QUOTA_BYTES = 64 * 1024 ** 3;
/** An unfinished upload nobody touched for 7 days is deleted. */
export const DEFAULT_PARTIAL_TTL_MS = 7 * 86_400_000;
const SWEEP_EVERY_MS = 3_600_000;

export interface FsBlobOptions {
  partialQuotaBytes?: number;
  partialTtlMs?: number;
  now?: () => number;
}

export interface FsBlobStore extends BlobStore {
  /** Delete unfinished uploads older than the time to live; returns how many. */
  sweep(): Promise<number>;
}

function check(sha256: string): string {
  if (!SHA.test(sha256)) throw new Error('Not a SHA-256.');
  return sha256;
}

function checkDevice(device: string): string {
  if (!DEVICE.test(device)) throw new Error('Not a device id.');
  return device;
}

async function size(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size;
  } catch {
    return null;
  }
}

async function hashFile(path: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(path) as AsyncIterable<Buffer>) h.update(chunk);
  return h.digest('hex');
}

async function list(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

export function createFsBlobStore(root: string, options: FsBlobOptions = {}): FsBlobStore {
  const quota = options.partialQuotaBytes ?? DEFAULT_PARTIAL_QUOTA_BYTES;
  const ttl = options.partialTtlMs ?? DEFAULT_PARTIAL_TTL_MS;
  const now = options.now ?? (() => Date.now());
  const final = (sha: string) => join(root, sha.slice(0, 2), sha);
  const partialDir = (device: string) => join(root, 'partial', device);
  const partial = (sha: string, device: string) => join(partialDir(device), `${sha}.part`);
  /** One upload per device and blob at a time. */
  const busy = new Map<string, Promise<unknown>>();
  let lastSweep = now();

  const serial = <T>(key: string, work: () => Promise<T>): Promise<T> => {
    const before = busy.get(key) ?? Promise.resolve();
    const next = before.then(work, work);
    const tail = next.catch(() => undefined);
    busy.set(key, tail);
    void tail.then(() => {
      if (busy.get(key) === tail) busy.delete(key);
    });
    return next;
  };

  async function sweep(): Promise<number> {
    lastSweep = now();
    let removed = 0;
    for (const device of await list(join(root, 'partial'))) {
      for (const file of await list(partialDir(device))) {
        const path = join(partialDir(device), file);
        try {
          if (now() - (await stat(path)).mtimeMs > ttl) {
            await rm(path, { force: true });
            removed++;
          }
        } catch {
          // gone already
        }
      }
    }
    return removed;
  }

  async function unfinishedBytes(device: string, except: string): Promise<number> {
    let total = 0;
    for (const file of await list(partialDir(device))) {
      if (file === `${except}.part`) continue;
      total += (await size(join(partialDir(device), file))) ?? 0;
    }
    return total;
  }

  return {
    kind: 'fs',
    sweep,
    async stat(sha256) {
      const s = await size(final(check(sha256)));
      return s === null ? null : { size: s };
    },
    async received(sha256, uploader) {
      return (await size(partial(check(sha256), checkDevice(uploader)))) ?? 0;
    },
    write(sha256, start, total, data, uploader) {
      check(sha256);
      checkDevice(uploader);
      if (now() - lastSweep > SWEEP_EVERY_MS) void sweep().catch(() => undefined);
      const part = partial(sha256, uploader);
      return serial(`${uploader} ${sha256}`, async () => {
        const have = (await size(part)) ?? 0;
        if (start !== have) throw new BlobOffsetError(have);
        if (start + data.length > total) throw new BlobOffsetError(have);
        if (have === 0 && (await unfinishedBytes(uploader, sha256)) + total > quota)
          throw new BlobQuotaError(quota);
        await mkdir(partialDir(uploader), { recursive: true });
        const fh = await open(part, have === 0 ? 'w' : 'r+');
        try {
          await fh.write(data, 0, data.length, start);
          await fh.sync();
        } finally {
          await fh.close();
        }
        const received = start + data.length;
        if (received < total) return { received, complete: false };
        if ((await hashFile(part)) !== sha256) {
          await rm(part, { force: true });
          throw new BlobHashError();
        }
        if ((await size(final(sha256))) !== null) {
          // the store had it already: this device proved it has the bytes too
          await rm(part, { force: true });
          return { received, complete: true };
        }
        await mkdir(join(root, sha256.slice(0, 2)), { recursive: true });
        try {
          await rename(part, final(sha256));
        } catch (e) {
          // another device finished the same blob at the same moment
          if ((await size(final(sha256))) === null) throw e;
          await rm(part, { force: true });
        }
        return { received, complete: true };
      });
    },
    async read(sha256, range): Promise<Readable | null> {
      const path = final(check(sha256));
      const s = await size(path);
      if (s === null) return null;
      return range
        ? createReadStream(path, { start: range.start, end: Math.max(range.start, range.end - 1) })
        : createReadStream(path);
    },
  };
}
