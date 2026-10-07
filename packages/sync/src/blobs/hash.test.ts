import { createHash } from 'node:crypto';
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HashCache, cachedHash, hashFile, hashStream, stampOf } from './hash';

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aio-blobs-hash-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('streaming hash', () => {
  it('equals a one-shot sha256 and reports progress in chunks', async () => {
    const bytes = new Uint8Array(3 * 1024 * 1024 + 17).map((_, i) => (i * 31) % 251);
    const file = join(dir, 'a.bin');
    await writeFile(file, bytes);
    const seen: number[] = [];
    const out = await hashFile(file, { chunkBytes: 1024 * 1024, onProgress: (d) => seen.push(d) });
    expect(out).toEqual({ sha256: sha(bytes), size: bytes.length });
    expect(seen.length).toBeGreaterThanOrEqual(4);
    expect(seen.at(-1)).toBe(bytes.length);
  });

  it('hashes an empty file', async () => {
    const file = join(dir, 'empty');
    await writeFile(file, '');
    expect(await hashFile(file)).toEqual({ sha256: sha(new Uint8Array()), size: 0 });
  });

  it('stops when cancelled', async () => {
    const file = join(dir, 'b.bin');
    await writeFile(file, new Uint8Array(4 * 1024 * 1024));
    const ac = new AbortController();
    const run = hashFile(file, {
      chunkBytes: 64 * 1024,
      signal: ac.signal,
      onProgress: (d) => {
        if (d > 256 * 1024) ac.abort();
      },
    });
    await expect(run).rejects.toThrow(/cancelled/i);
  });

  it('caps the read rate', async () => {
    const parts = [new Uint8Array(100_000), new Uint8Array(100_000), new Uint8Array(100_000)];
    const started = Date.now();
    await hashStream(
      (async function* () {
        await Promise.resolve();
        yield* parts;
      })(),
      { maxBytesPerSecond: 1_000_000 },
    );
    // 300 kB at 1 MB/s takes at least about 0.2 s after the first part.
    expect(Date.now() - started).toBeGreaterThanOrEqual(180);
  });
});

describe('hash cache by size, mtime and inode', () => {
  it('hits while the stamp is unchanged and misses once the file changes', async () => {
    const file = join(dir, 'c.bin');
    await writeFile(file, 'one');
    const cache = new HashCache();
    const first = await cachedHash(cache, 'c.bin', file);
    expect(first).toMatchObject({ sha256: sha(Buffer.from('one')), size: 3, cached: false });
    expect(await cachedHash(cache, 'c.bin', file)).toMatchObject({ cached: true });

    // same size, new mtime: a miss
    await writeFile(file, 'two');
    const later = new Date(Date.now() + 5000);
    await utimes(file, later, later);
    const again = await cachedHash(cache, 'c.bin', file);
    expect(again).toMatchObject({ sha256: sha(Buffer.from('two')), cached: false });
  });

  it('round-trips through JSON and drops entries for files that are gone', async () => {
    const file = join(dir, 'd.bin');
    await writeFile(file, 'dd');
    const cache = new HashCache();
    await cachedHash(cache, 'd.bin', file);
    const copy = HashCache.from(JSON.parse(JSON.stringify(cache.toJSON())));
    const stamp = await stampOf(file);
    expect(stamp && copy.get('d.bin', stamp)).toBe(sha(Buffer.from('dd')));
    expect(HashCache.from({ x: { nonsense: true } }).size).toBe(0);
    copy.retain(new Set());
    expect(copy.size).toBe(0);
  });
});
