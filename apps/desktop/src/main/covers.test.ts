import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { coverFile, coverHash, coverStamp, registerCoverIpc, setCover } from './covers';
import { libraryKey } from './libraryView';
import { collectHandlers } from './notYet';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aio-covers-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('covers (read side)', () => {
  it('names a cover by the sha256 hex of its library key', () => {
    expect(coverHash('demo:survey-demo')).toMatch(/^[0-9a-f]{64}$/);
    expect(coverHash('a')).toBe('ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb');
    expect(coverFile(dir, 'a')).toBe(join(dir, `${coverHash('a')}.jpg`));
  });

  it('has no stamp when the key has no cover', async () => {
    expect(await coverStamp(dir, 'k')).toBeNull();
    expect(await coverStamp(join(dir, 'missing'), 'k')).toBeNull();
  });

  it('stamps a cover with its hash and modification time', async () => {
    await writeFile(coverFile(dir, 'k'), 'jpeg');
    const { mtimeMs } = await stat(coverFile(dir, 'k'));
    expect(await coverStamp(dir, 'k')).toEqual({ hash: coverHash('k'), mtimeMs });
  });

  it('fails library:setThumbnail for an unknown id', async () => {
    const h = collectHandlers((handle) => {
      registerCoverIpc({
        handle,
        projects: { path: () => undefined, package: () => undefined },
        isDemo: () => Promise.resolve(false),
        coversDir: () => dir,
      });
    });
    expect(await h.call('library:setThumbnail', { projectId: 'a', data: null })).toMatchObject({
      ok: false,
      error: expect.stringContaining('Reload the library') as unknown,
    });
  });
});

const JPEG = (n: number): Uint8Array => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, n, n, n]);

describe('setCover', () => {
  let proj: string;
  let covers: string;
  const base = () => ({
    id: 'p1',
    path: proj,
    isPackage: false,
    demo: false,
    coversDir: covers,
  });

  beforeEach(async () => {
    proj = join(dir, 'proj');
    covers = join(dir, 'covers');
    await mkdir(proj, { recursive: true });
    await writeFile(join(proj, 'manifest.json'), '{}');
  });

  it('writes thumbnail.jpg into a native project folder and answers a fresh URL', async () => {
    const r = await setCover({ ...base(), data: JPEG(1) });
    expect(r).toMatchObject({ ok: true });
    expect(new Uint8Array(await readFile(join(proj, 'thumbnail.jpg')))).toEqual(JPEG(1));
    const { mtimeMs } = await stat(join(proj, 'thumbnail.jpg'));
    expect(r).toEqual({
      ok: true,
      thumbnail: `aio://project/p1/thumbnail.jpg?v=${String(Math.round(mtimeMs))}`,
    });
    expect((await readdir(proj)).sort()).toEqual(['manifest.json', 'thumbnail.jpg']);
  });

  it('writes a package cover into the covers folder, never into the package', async () => {
    const pkg = join(dir, 'a.aio');
    await writeFile(pkg, 'package-bytes');
    const r = await setCover({ ...base(), path: pkg, isPackage: true, data: JPEG(2) });
    const key = libraryKey(pkg, false);
    expect(new Uint8Array(await readFile(coverFile(covers, key)))).toEqual(JPEG(2));
    expect(await readFile(pkg, 'utf8')).toBe('package-bytes');
    expect(r).toMatchObject({
      ok: true,
      thumbnail: expect.stringContaining(`aio://cover/${coverHash(key)}.jpg?v=`) as unknown,
    });
  });

  it('writes a kit export and a demo cover into the covers folder', async () => {
    const kit = join(dir, 'kit');
    await mkdir(kit);
    await setCover({ ...base(), path: kit, data: JPEG(3) });
    expect(await readdir(kit)).toEqual([]);
    expect((await stat(coverFile(covers, libraryKey(kit, false)))).isFile()).toBe(true);
    const demo = join(dir, 'survey-demo');
    await mkdir(demo);
    await writeFile(join(demo, 'manifest.json'), '{}');
    await setCover({ ...base(), path: demo, demo: true, data: JPEG(4) });
    expect(await readdir(demo)).toEqual(['manifest.json']);
    expect((await stat(coverFile(covers, 'demo:survey-demo'))).isFile()).toBe(true);
  });

  it('answers a different URL after a second write', async () => {
    const a = await setCover({ ...base(), data: JPEG(1) });
    // push the mtime back so the second write is certain to differ
    const old = new Date(Date.now() - 60_000);
    await utimes(join(proj, 'thumbnail.jpg'), old, old);
    const b = await setCover({ ...base(), data: JPEG(5) });
    expect(a).toMatchObject({ ok: true });
    expect(b).toMatchObject({ ok: true });
    expect((a as { thumbnail: string }).thumbnail).not.toBe((b as { thumbnail: string }).thumbnail);
  });

  it('answers a different cover URL after a second write', async () => {
    const pkg = join(dir, 'a.aio');
    await writeFile(pkg, 'x');
    const o = { ...base(), path: pkg, isPackage: true };
    const a = await setCover({ ...o, data: JPEG(1) });
    const old = new Date(Date.now() - 60_000);
    await utimes(coverFile(covers, libraryKey(pkg, false)), old, old);
    const b = await setCover({ ...o, data: JPEG(2) });
    expect((a as { thumbnail: string }).thumbnail).not.toBe((b as { thumbnail: string }).thumbnail);
  });

  it('refuses bytes that are not a JPEG', async () => {
    const r = await setCover({ ...base(), data: new Uint8Array([1, 2, 3, 4]) });
    expect(r).toEqual({ ok: false, error: 'A cover must be a JPEG image.' });
    expect(await readdir(proj)).toEqual(['manifest.json']);
  });

  it('null removes the custom cover and leaves thumbnail.jpg alone', async () => {
    await writeFile(join(proj, 'thumbnail.jpg'), JPEG(9));
    const key = libraryKey(proj, false);
    await mkdir(covers);
    await writeFile(coverFile(covers, key), JPEG(8));
    const r = await setCover({ ...base(), data: null });
    await expect(stat(coverFile(covers, key))).rejects.toThrow();
    expect((await readFile(join(proj, 'thumbnail.jpg'))).length).toBe(JPEG(9).length);
    expect(r).toMatchObject({
      ok: true,
      thumbnail: expect.stringContaining('aio://project/p1/thumbnail.jpg?v=') as unknown,
    });
  });

  it('null answers null when the project has no picture of its own', async () => {
    expect(await setCover({ ...base(), data: null })).toEqual({ ok: true, thumbnail: null });
  });

  it("keeps the project's own picture once before a cover replaces it", async () => {
    await writeFile(join(proj, 'thumbnail.jpg'), JPEG(9));
    await setCover({ ...base(), data: JPEG(1) });
    await setCover({ ...base(), data: JPEG(2) });
    expect(new Uint8Array(await readFile(join(proj, 'thumbnail.original.jpg')))).toEqual(JPEG(9));
    expect(new Uint8Array(await readFile(join(proj, 'thumbnail.jpg')))).toEqual(JPEG(2));
  });

  it("null puts the project's own picture back from the copy kept", async () => {
    await writeFile(join(proj, 'thumbnail.jpg'), JPEG(9));
    await setCover({ ...base(), data: JPEG(1) });
    const r = await setCover({ ...base(), data: null });
    expect(new Uint8Array(await readFile(join(proj, 'thumbnail.jpg')))).toEqual(JPEG(9));
    expect((await readdir(proj)).sort()).toEqual(['manifest.json', 'thumbnail.jpg']);
    expect(r).toMatchObject({
      ok: true,
      thumbnail: expect.stringContaining('aio://project/p1/thumbnail.jpg?v=') as unknown,
    });
  });

  it('a folder cover removes an older custom cover of the same key', async () => {
    const key = libraryKey(proj, false);
    await mkdir(covers);
    await writeFile(coverFile(covers, key), JPEG(8));
    await setCover({ ...base(), data: JPEG(1) });
    await expect(stat(coverFile(covers, key))).rejects.toThrow();
  });
});
