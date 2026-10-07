import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBlobStore, type BlobStore } from './store';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

let dir: string;
let store: BlobStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aio-blobs-store-'));
  store = createBlobStore(join(dir, 'blobs'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function put(content: string): Promise<string> {
  const h = sha(content);
  const part = store.partPath(h);
  await mkdir(dirname(part), { recursive: true });
  await writeFile(part, content);
  await store.commit(h, content.length);
  return h;
}

describe('blob store (userData blobs/)', () => {
  it('lays blobs out by hash and stores each once', async () => {
    const h = await put('hello');
    expect(store.path(h).replaceAll('\\', '/')).toMatch(new RegExp(`blobs/${h.slice(0, 2)}/${h}$`));
    expect(await store.check(h, 5)).toBe('ok');
    expect(await store.check(h, 6)).toBe('damaged');
    expect(await store.check(sha('nope'), 1)).toBe('absent');
    // a second commit of the same hash replaces nothing and keeps one copy
    await put('hello');
    expect((await store.list()).map((e) => e.sha256)).toEqual([h]);
    expect(await store.usage()).toBe(5);
  });

  it('finds a blob changed after it was verified', async () => {
    const h = await put('verified');
    await writeFile(store.path(h), 'tampered'); // same size, new mtime
    await new Promise((r) => setTimeout(r, 20));
    await writeFile(store.path(h), 'tamperex');
    expect(await store.check(h, 8)).toBe('damaged');
    await store.markVerified(h);
    expect(await store.check(h, 8)).toBe('ok');
  });

  it('keeps partial downloads for resume and moves bad files to quarantine', async () => {
    const h = sha('abc');
    await mkdir(dirname(store.partPath(h)), { recursive: true });
    await writeFile(store.partPath(h), 'ab');
    expect(await store.partialBytes(h)).toBe(2);
    const moved = await store.quarantine(h, store.partPath(h));
    expect(await store.partialBytes(h)).toBe(0);
    expect(moved.replaceAll('\\', '/')).toContain('/quarantine/');
    expect(await readdir(join(dir, 'blobs', 'quarantine'))).toHaveLength(1);
  });

  it('frees space only on request, and never removes a blob held nowhere else', async () => {
    const a = await put('a-is-elsewhere');
    const b = await put('b-only-here');
    const c = await put('c-open-project');
    const result = await store.freeSpace({
      keep: new Set([c]),
      elsewhere: (shas) => Promise.resolve(new Set(shas.filter((s) => s === a || s === c))),
    });
    expect(result.removed).toEqual([a]);
    expect(result.freed).toBe('a-is-elsewhere'.length);
    expect(await store.check(a, 14)).toBe('absent');
    expect(await store.check(b, 11)).toBe('ok');
    expect(await store.check(c, 14)).toBe('ok');
  });

  it('frees only down to a target size, oldest first', async () => {
    const a = await put('first-blob');
    await new Promise((r) => setTimeout(r, 20));
    const b = await put('second-blob');
    await store.touch(b);
    const result = await store.freeSpace({
      keep: new Set(),
      elsewhere: (shas) => Promise.resolve(new Set(shas)),
      targetBytes: 11,
    });
    expect(result.removed).toEqual([a]);
  });
});
