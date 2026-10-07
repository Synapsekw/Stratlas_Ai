import { blobPath, type ByteRange } from '@aio/schema';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMemoryTransport } from '../memory';
import {
  createFetchQueue,
  defaultFetchPolicy,
  fetchBlob,
  fetchesWithoutClick,
  folderBlobSource,
  policyFor,
  transportSource,
  type BlobSource,
} from './fetch';
import { createBlobStore, type BlobStore } from './store';

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const bytes = (n: number, seed = 7) => new Uint8Array(n).map((_, i) => (i * seed + 3) % 256);

let dir: string;
let store: BlobStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aio-blobs-fetch-'));
  store = createBlobStore(join(dir, 'cache'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function memorySource(...blobs: Uint8Array[]): Promise<BlobSource> {
  const t = createMemoryTransport();
  for (const b of blobs)
    await t.putBlob(
      { sha256: sha(b), size: b.length, path: 'x.bin', role: 'source' },
      (async function* () {
        await Promise.resolve();
        yield b;
      })(),
    );
  return transportSource(t, 'hub');
}

/** A source that serves `data` in parts, recording each range asked for. */
function partsSource(
  data: Uint8Array,
  o: { part?: number; failAfter?: number; corruptFirst?: boolean } = {},
): BlobSource & { ranges: (ByteRange | undefined)[] } {
  const ranges: (ByteRange | undefined)[] = [];
  let calls = 0;
  return {
    label: 'test source',
    ranges,
    hasBlobs: (s) => Promise.resolve(new Set(s.filter((x) => x === sha(data)))),
    getBlob(_s, range) {
      ranges.push(range);
      calls++;
      const corrupt = o.corruptFirst && calls === 1;
      const start = range?.start ?? 0;
      const end = range?.end ?? data.length;
      const part = o.part ?? 1024;
      return Promise.resolve(
        (async function* () {
          for (let at = start; at < end; at += part) {
            await Promise.resolve();
            if (o.failAfter !== undefined && calls === 1 && at - start >= o.failAfter)
              throw new Error('Connection lost');
            const chunk = data.slice(at, Math.min(end, at + part));
            if (corrupt) chunk[0] = (chunk[0] ?? 0) ^ 0xff;
            yield chunk;
          }
        })(),
      );
    },
  };
}

describe('fetch policies', () => {
  it('defaults by size and kind, and the person can override per layer', () => {
    expect(defaultFetchPolicy('pointcloud', 3e9)).toBe('on-demand');
    expect(defaultFetchPolicy('video', 250 * 1024 * 1024)).toBe('on-demand');
    expect(defaultFetchPolicy('mesh', 60 * 1024 * 1024)).toBe('on-demand');
    expect(defaultFetchPolicy('mesh', 1e6)).toBe('always');
    expect(defaultFetchPolicy('raster', 1e6)).toBe('always');
    expect(defaultFetchPolicy('vector', 1e3)).toBe('always');
    expect(defaultFetchPolicy('photos', 1e6)).toBe('on-open');
    expect(policyFor({ id: 'v', kind: 'video' }, 3e9, { v: 'stream' })).toBe('stream');
    expect(policyFor({ id: 'v', kind: 'video' }, 3e9, { other: 'always' })).toBe('on-demand');
  });

  it('copies without a click only for always and on-open', () => {
    expect(fetchesWithoutClick('always', 'sync')).toBe(true);
    expect(fetchesWithoutClick('on-open', 'open')).toBe(true);
    expect(fetchesWithoutClick('on-open', 'sync')).toBe(false);
    expect(fetchesWithoutClick('on-demand', 'open')).toBe(false);
    expect(fetchesWithoutClick('stream', 'open')).toBe(false);
  });
});

describe('fetching a blob', () => {
  it('copies from a transport, verifies it and stores it once', async () => {
    const data = bytes(10_000);
    const want = { sha256: sha(data), size: data.length };
    const out = await fetchBlob(want, [await memorySource(data)], store);
    expect(out).toMatchObject({ status: 'fetched', source: 'hub', resumedFrom: 0 });
    expect(sha(await readFile(store.path(want.sha256)))).toBe(want.sha256);
    expect(await fetchBlob(want, [], store)).toMatchObject({ status: 'present' });
  });

  it('reads from a hub folder laid out blobs/<aa>/<sha256>', async () => {
    const data = bytes(5000, 3);
    const h = sha(data);
    const hub = join(dir, 'hub', 'projects', 't_x', 'blobs');
    const file = join(hub, blobPath(h).slice('blobs/'.length));
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, data);
    const src = folderBlobSource(hub);
    expect(await src.hasBlobs([h, 'f'.repeat(64)])).toEqual(new Set([h]));
    const out = await fetchBlob({ sha256: h, size: data.length }, [src], store);
    expect(out.status).toBe('fetched');
    expect(await store.check(h, data.length)).toBe('ok');
  });

  it('resumes after an interruption from the byte offset', async () => {
    const data = bytes(64 * 1024);
    const want = { sha256: sha(data), size: data.length };
    const src = partsSource(data, { part: 4096, failAfter: 20_000 });
    await expect(fetchBlob(want, [src], store, { attempts: 1 })).rejects.toThrow(/Connection lost/);
    const kept = await store.partialBytes(want.sha256);
    expect(kept).toBeGreaterThanOrEqual(20_000);

    const out = await fetchBlob(want, [src], store);
    expect(out).toMatchObject({ status: 'fetched', resumedFrom: kept });
    expect(src.ranges.at(-1)).toEqual({ start: kept, end: data.length });
    expect(sha(await readFile(store.path(want.sha256)))).toBe(want.sha256);
  });

  it('resumes after a cancel and keeps the partial file', async () => {
    const data = bytes(64 * 1024, 5);
    const want = { sha256: sha(data), size: data.length };
    const src = partsSource(data, { part: 2048 });
    const ac = new AbortController();
    const run = fetchBlob(want, [src], store, {
      signal: ac.signal,
      onBytes: (n) => {
        if (n >= 16 * 1024) ac.abort();
      },
    });
    await expect(run).rejects.toThrow(/cancelled/i);
    expect(await store.partialBytes(want.sha256)).toBeGreaterThan(0);
    const out = await fetchBlob(want, [src], store);
    expect(out.resumedFrom).toBeGreaterThan(0);
    expect(await store.check(want.sha256, want.size)).toBe('ok');
  });

  it('detects a corrupt download, quarantines it and fetches it again', async () => {
    const data = bytes(8192, 11);
    const want = { sha256: sha(data), size: data.length };
    const src = partsSource(data, { corruptFirst: true });
    const out = await fetchBlob(want, [src], store);
    expect(out.status).toBe('fetched');
    expect(out.quarantined).toHaveLength(1);
    expect(await readdir(join(store.dir, 'quarantine'))).toHaveLength(1);
    expect(sha(await readFile(store.path(want.sha256)))).toBe(want.sha256);
  });

  it('gives up with an exact error when every copy is wrong', async () => {
    const data = bytes(4096);
    const want = { sha256: sha(data), size: data.length };
    const bad: BlobSource = {
      label: 'hub',
      hasBlobs: (s) => Promise.resolve(new Set(s)),
      getBlob: () =>
        Promise.resolve(
          (async function* () {
            await Promise.resolve();
            yield bytes(4096, 13);
          })(),
        ),
    };
    await expect(fetchBlob(want, [bad], store)).rejects.toThrow(/does not match its fingerprint/);
    expect(await readdir(join(store.dir, 'quarantine'))).toHaveLength(2);
    expect(await store.check(want.sha256, want.size)).toBe('absent');
  });

  it('finds a damaged copy in the cache and fetches it again', async () => {
    const data = bytes(6000, 9);
    const want = { sha256: sha(data), size: data.length };
    const src = await memorySource(data);
    await fetchBlob(want, [src], store);
    const damaged = Buffer.from(data);
    damaged[10] = (damaged[10] ?? 0) ^ 1;
    await new Promise((r) => setTimeout(r, 20));
    await writeFile(store.path(want.sha256), damaged);
    expect(await store.check(want.sha256, want.size)).toBe('damaged');
    const out = await fetchBlob(want, [src], store);
    expect(out).toMatchObject({ status: 'fetched' });
    expect(out.quarantined).toHaveLength(1);
    expect(sha(await readFile(store.path(want.sha256)))).toBe(want.sha256);
  });

  it('says no source has the file', async () => {
    await expect(
      fetchBlob({ sha256: 'a'.repeat(64), size: 3 }, [await memorySource()], store),
    ).rejects.toThrow(/No shared folder, bundle or server has this file/);
  });
});

describe('fetch queue', () => {
  it('reports progress over the job, cancels and resumes', async () => {
    const a = bytes(32 * 1024, 3);
    const b = bytes(32 * 1024, 5);
    const src = partsSource(a, { part: 1024 });
    const both: BlobSource = {
      label: 'hub',
      hasBlobs: (s) => Promise.resolve(new Set(s)),
      getBlob: (s, r) => (s === sha(a) ? src.getBlob(s, r) : partsSource(b).getBlob(s, r)),
    };
    const q = createFetchQueue(store);
    const wants = [
      { sha256: sha(a), size: a.length },
      { sha256: sha(b), size: b.length },
      { sha256: sha(a), size: a.length }, // the same file in two layers: fetched once
    ];
    const seen: number[] = [];
    const first = q.run('j1', wants, [both], (p) => {
      seen.push(p.done);
      expect(p.total).toBe(64 * 1024);
      if (p.done > 8 * 1024) q.cancel('j1');
    });
    expect(await first).toMatchObject({ state: 'cancelled' });
    expect(q.running()).toEqual([]);
    const done = await q.run('j2', wants, [both]);
    expect(done).toEqual({ state: 'done', fetched: 2, present: 0 });
    expect(seen.length).toBeGreaterThan(1);
  });

  it('fails a job with the readable reason', async () => {
    const q = createFetchQueue(store);
    const out = await q.run('j', [{ sha256: 'b'.repeat(64), size: 1 }], []);
    expect(out.state).toBe('failed');
    expect(out.error).toMatch(/No shared folder/);
    expect(q.cancel('j')).toBe(false);
  });
});
