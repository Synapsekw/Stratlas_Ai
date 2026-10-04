import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAioHandler } from './protocol/handler';
import {
  cleanRel,
  findThumb,
  isJpeg,
  MAX_THUMB_BYTES,
  projectThumbPath,
  putThumb,
  thumbCacheFile,
} from './thumbs';

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

let base: string;
let root: string;
let cache: string;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'aio-thumbs-'));
  root = join(base, 'p1');
  cache = join(base, 'cache');
  await mkdir(join(root, 'photos', 'thumbs'), { recursive: true });
  await mkdir(join(root, 'panoramas'), { recursive: true });
  await writeFile(join(root, 'photos', 'a.jpg'), 'full a');
  await writeFile(join(root, 'photos', 'thumbs', 'a.jpg'), 'thumb a');
  await writeFile(join(root, 'photos', 'b.jpg'), 'full b, no thumb');
  await writeFile(join(root, 'panoramas', 'c.png'), 'pano');
  await writeFile(join(base, 'secret.jpg'), 'secret');
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('thumbnail paths', () => {
  it("finds the project's own thumbnail beside an image", () => {
    expect(projectThumbPath('photos/p001.jpg')).toBe('photos/thumbs/p001.jpg');
    expect(projectThumbPath('panoramas/x.PNG')).toBe('panoramas/thumbs/x.jpg');
    expect(projectThumbPath('photos/thumbs/p001.jpg')).toBe('photos/thumbs/p001.jpg');
    expect(projectThumbPath('models/a.glb')).toBeNull();
  });

  it('refuses paths that leave the project', () => {
    expect(cleanRel('photos/../../x.jpg')).toBeNull();
    expect(cleanRel('/abs.jpg')).toBeNull();
    expect(cleanRel('C:/x.jpg')).toBeNull();
    expect(cleanRel('photos\\a.jpg')).toBe('photos/a.jpg');
  });

  it('keys the cache by project, path, size and date', () => {
    const k = { where: root, rel: 'photos/b.jpg', size: 10, mtimeMs: 1000 };
    expect(thumbCacheFile(cache, k)).toBe(thumbCacheFile(cache, { ...k }));
    expect(thumbCacheFile(cache, k)).not.toBe(thumbCacheFile(cache, { ...k, size: 11 }));
    expect(thumbCacheFile(cache, k)).not.toBe(thumbCacheFile(cache, { ...k, mtimeMs: 2000 }));
    expect(thumbCacheFile(cache, k)).not.toBe(thumbCacheFile(cache, { ...k, where: 'other' }));
    expect(thumbCacheFile(cache, k).startsWith(cache)).toBe(true);
  });

  it('recognises JPEG bytes', () => {
    expect(isJpeg(JPEG)).toBe(true);
    expect(isJpeg(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe(false);
  });
});

describe('thumbnail cache', () => {
  it('serves the project thumbnail first, else a cached one, else nothing', async () => {
    expect(await findThumb({ root }, 'photos/a.jpg', cache)).toEqual({
      kind: 'file',
      path: expect.stringContaining(join('photos', 'thumbs', 'a.jpg')) as string,
    });
    expect(await findThumb({ root }, 'photos/b.jpg', cache)).toEqual({ kind: 'missing' });
    expect(await putThumb({ root }, 'photos/b.jpg', JPEG, cache)).toBe(true);
    const hit = await findThumb({ root }, 'photos/b.jpg', cache);
    expect(hit.kind).toBe('file');
    expect(hit.kind === 'file' && hit.path.startsWith(cache)).toBe(true);
    // The project folder is never written.
    expect((await readdir(join(root, 'photos'))).sort()).toEqual(['a.jpg', 'b.jpg', 'thumbs']);
  });

  it('makes a new thumbnail when the source image changes', async () => {
    await putThumb({ root }, 'panoramas/c.png', JPEG, cache);
    expect((await findThumb({ root }, 'panoramas/c.png', cache)).kind).toBe('file');
    await utimes(join(root, 'panoramas', 'c.png'), new Date(), new Date(Date.now() + 60_000));
    expect((await findThumb({ root }, 'panoramas/c.png', cache)).kind).toBe('missing');
  });

  it('refuses bad thumbnails and sources', async () => {
    expect(await putThumb({ root }, 'photos/b.jpg', new Uint8Array([1, 2, 3, 4]), cache)).toBe(
      false,
    );
    const big = new Uint8Array(MAX_THUMB_BYTES + 1);
    big.set(JPEG);
    expect(await putThumb({ root }, 'photos/b.jpg', big, cache)).toBe(false);
    expect(await putThumb({ root }, 'photos/missing.jpg', JPEG, cache)).toBe(false);
    expect(await putThumb({ root }, '../secret.jpg', JPEG, cache)).toBe(false);
    expect(await putThumb({ root }, 'models/a.glb', JPEG, cache)).toBe(false);
    expect((await findThumb({ root }, '../secret.jpg', cache)).kind).toBe('forbidden');
  });

  it('answers aio://thumb with the thumbnail or 404, never the full image', async () => {
    const handler = createAioHandler({
      projectRoot: (id) => (id === 'p1' ? root : undefined),
      packsDir: () => join(base, 'packs'),
      thumbsDir: () => cache,
    });
    const own = await handler(new Request('aio://thumb/p1/photos/a.jpg'));
    expect(own.status).toBe(200);
    expect(await own.text()).toBe('thumb a');
    expect(own.headers.get('cache-control')).toBe('max-age=3600');
    const none = await handler(new Request('aio://thumb/p1/photos/none.jpg'));
    expect(none.status).toBe(404);
    expect((await handler(new Request('aio://thumb/zz/photos/a.jpg'))).status).toBe(404);
  });
});
