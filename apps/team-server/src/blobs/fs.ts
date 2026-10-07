/**
 * Blobs on the server's file system (the default): `<root>/<aa>/<sha256>` for complete blobs and
 * `<root>/partial/<sha256>.part` while an upload is in progress. A finished upload is hashed,
 * then renamed into place, so a reader never sees half a blob.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { BlobHashError, BlobOffsetError, type BlobStore } from './blobStore';

const SHA = /^[a-f0-9]{64}$/;

function check(sha256: string): string {
  if (!SHA.test(sha256)) throw new Error('Not a SHA-256.');
  return sha256;
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

export function createFsBlobStore(root: string): BlobStore {
  const final = (sha: string) => join(root, sha.slice(0, 2), sha);
  const partial = (sha: string) => join(root, 'partial', `${sha}.part`);
  /** One upload per blob at a time. */
  const busy = new Map<string, Promise<unknown>>();

  const serial = <T>(sha: string, work: () => Promise<T>): Promise<T> => {
    const before = busy.get(sha) ?? Promise.resolve();
    const next = before.then(work, work);
    busy.set(
      sha,
      next.catch(() => undefined),
    );
    return next;
  };

  return {
    kind: 'fs',
    async stat(sha256) {
      const s = await size(final(check(sha256)));
      return s === null ? null : { size: s };
    },
    async received(sha256) {
      return (await size(partial(check(sha256)))) ?? 0;
    },
    write(sha256, start, total, data) {
      check(sha256);
      return serial(sha256, async () => {
        const done = await size(final(sha256));
        if (done !== null) return { received: done, complete: true };
        const have = (await size(partial(sha256))) ?? 0;
        if (start !== have) throw new BlobOffsetError(have);
        if (start + data.length > total) throw new BlobOffsetError(have);
        await mkdir(join(root, 'partial'), { recursive: true });
        const fh = await open(partial(sha256), have === 0 ? 'w' : 'r+');
        try {
          await fh.write(data, 0, data.length, start);
          await fh.sync();
        } finally {
          await fh.close();
        }
        const received = start + data.length;
        if (received < total) return { received, complete: false };
        if ((await hashFile(partial(sha256))) !== sha256) {
          await rm(partial(sha256), { force: true });
          throw new BlobHashError();
        }
        await mkdir(join(root, sha256.slice(0, 2)), { recursive: true });
        await rename(partial(sha256), final(sha256));
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
