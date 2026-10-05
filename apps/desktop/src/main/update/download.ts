import { createHash, type Hash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<Response>;

export interface DownloadRequest {
  url: string;
  /** Expected SHA-256, lowercase hex. */
  sha256: string;
  size: number;
  /** Final path; the bytes land in `<dest>.partial` until size and hash match. */
  dest: string;
  fetch: FetchLike;
  onProgress?: (received: number, total: number) => void;
  signal?: AbortSignal;
}

async function sizeOf(path: string): Promise<number | null> {
  try {
    const s = await stat(path);
    return s.isFile() ? s.size : null;
  } catch {
    return null;
  }
}

function hashInto(h: Hash, path: string): Promise<void> {
  return new Promise((ok, fail) => {
    createReadStream(path)
      .on('data', (c) => h.update(c))
      .on('error', fail)
      .on('end', () => {
        ok();
      });
  });
}

/** SHA-256 (hex) of a whole file. */
export async function sha256Of(path: string): Promise<string> {
  const h = createHash('sha256');
  await hashInto(h, path);
  return h.digest('hex');
}

/**
 * Download a file whose size and SHA-256 are known in advance (the update feed says them).
 * Interrupted downloads continue from `<dest>.partial` with an HTTP range request; a server that
 * ignores the range starts it over. Nothing is ever renamed to `dest` unless both size and hash
 * match, so a half-written or tampered file can never be taken for the installer.
 */
export async function downloadVerified(r: DownloadRequest): Promise<void> {
  const expected = r.sha256.toLowerCase();
  if ((await sizeOf(r.dest)) === r.size && (await sha256Of(r.dest)) === expected) {
    r.onProgress?.(r.size, r.size);
    return;
  }
  await mkdir(dirname(r.dest), { recursive: true });
  const partial = `${r.dest}.partial`;
  let have = (await sizeOf(partial)) ?? 0;
  if (have >= r.size) {
    await rm(partial, { force: true });
    have = 0;
  }
  const headers: Record<string, string> = have > 0 ? { Range: `bytes=${String(have)}-` } : {};
  const res = await r.fetch(r.url, { headers, ...(r.signal ? { signal: r.signal } : {}) });
  if (res.status === 404)
    throw new Error(`The update file was not found on the server (HTTP 404).`);
  if (res.status !== 200 && res.status !== 206) {
    await res.body?.cancel();
    throw new Error(`The server answered HTTP ${String(res.status)} for the update file.`);
  }
  if (res.status === 206) {
    const m = /^bytes (\d+)-/.exec(res.headers.get('content-range') ?? '');
    if (Number(m?.[1]) !== have) {
      await res.body?.cancel();
      throw new Error('The server sent the wrong part of the update file. Try again.');
    }
  } else {
    have = 0; // a full answer: start over
  }
  const hash = createHash('sha256');
  if (have > 0) await hashInto(hash, partial);
  const file = await open(partial, have > 0 ? 'a' : 'w');
  let received = have;
  let oversized = false;
  r.onProgress?.(received, r.size);
  try {
    if (!res.body) throw new Error('The server sent no data.');
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > r.size) {
        oversized = true;
        await reader.cancel();
        throw new Error('The update file is larger than the feed says.');
      }
      hash.update(value);
      await file.write(value);
      r.onProgress?.(received, r.size);
    }
    // On disk before the rename, so a power cut cannot leave a verified name on missing bytes.
    await file.sync();
  } finally {
    await file.close();
    if (oversized) await rm(partial, { force: true });
  }
  if (received !== r.size) {
    throw new Error(
      `The download stopped at ${String(received)} of ${String(r.size)} bytes. Check now again to continue.`,
    );
  }
  if (hash.digest('hex') !== expected) {
    await rm(partial, { force: true });
    throw new Error('The downloaded file does not match the feed (SHA-256). It was deleted.');
  }
  await rename(partial, r.dest);
}
