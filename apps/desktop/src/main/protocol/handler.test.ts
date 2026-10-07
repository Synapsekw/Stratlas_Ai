import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAioHandler } from './handler';
import { LEGACY_CSP } from './legacy';
import { mimeFor } from './mime';

let base: string;
const BODY = '0123456789abcdef';

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'aio-proto-'));
  await mkdir(join(base, 'p1', 'video'), { recursive: true });
  await writeFile(join(base, 'p1', 'video', 'clip 1.mp4'), BODY);
  await writeFile(join(base, 'p1', 'model.glb'), 'glTF');
  await mkdir(join(base, 'p1', 'legacy', 'data'), { recursive: true });
  await writeFile(
    join(base, 'p1', 'legacy', 'Old Review.html'),
    '<!doctype html><html><head><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Nunito">' +
      '<script src="data/site.js"></script></head><body>review</body></html>',
  );
  await writeFile(join(base, 'p1', 'legacy', 'data', 'site.js'), 'window.SITE=1;');
  await writeFile(join(base, 'p1', 'report.html'), '<html><head></head></html>');
  await writeFile(join(base, 'secret.txt'), 'secret');
  await mkdir(join(base, 'packs'));
  await writeFile(join(base, 'packs', 'gcc.pmtiles'), 'PMTiles');
  await mkdir(join(base, 'packs', 'imagery'));
  await writeFile(join(base, 'packs', 'imagery', 'site.pmtiles'), 'RasterPM');
  await writeFile(join(base, 'packs', 'imagery', 'site.json'), '{}');
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

function handler() {
  return createAioHandler({
    projectRoot: (id) => (id === 'p1' ? join(base, 'p1') : undefined),
    packsDir: () => join(base, 'packs'),
  });
}

const get = (url: string, headers: Record<string, string> = {}, method = 'GET') =>
  handler()(new Request(url, { method, headers }));

describe('aio:// handler', () => {
  it('serves a whole project file with length, type and Accept-Ranges', async () => {
    const res = await get('aio://project/p1/video/clip%201.mp4');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('video/mp4');
    expect(res.headers.get('content-length')).toBe(String(BODY.length));
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(await res.text()).toBe(BODY);
  });

  it('answers a Range request with 206 and the exact slice', async () => {
    const res = await get('aio://project/p1/video/clip%201.mp4', { Range: 'bytes=2-5' });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe(`bytes 2-5/${BODY.length}`);
    expect(res.headers.get('content-length')).toBe('4');
    expect(await res.text()).toBe('2345');
  });

  it('answers an open-ended Range to the end of the file', async () => {
    const res = await get('aio://project/p1/video/clip%201.mp4', { Range: 'bytes=10-' });
    expect(res.status).toBe(206);
    expect(await res.text()).toBe('abcdef');
  });

  it('answers 416 for an unsatisfiable range', async () => {
    const res = await get('aio://project/p1/video/clip%201.mp4', { Range: 'bytes=99-' });
    expect(res.status).toBe(416);
    expect(res.headers.get('content-range')).toBe(`bytes */${BODY.length}`);
  });

  it('answers HEAD without a body', async () => {
    const res = await get('aio://project/p1/model.glb', {}, 'HEAD');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('model/gltf-binary');
    expect(await res.text()).toBe('');
  });

  it('refuses other methods', async () => {
    const res = await get('aio://project/p1/model.glb', {}, 'POST');
    expect(res.status).toBe(405);
  });

  it('answers 404 for an unknown project', async () => {
    expect((await get('aio://project/nope/model.glb')).status).toBe(404);
  });

  it('never serves files outside the project root', async () => {
    expect((await get('aio://project/p1/..%2Fsecret.txt')).status).toBe(403);
    expect((await get('aio://project/p1/video%5C..%5C..%5Csecret.txt')).status).toBe(403);
    expect((await get('aio://project/../secret.txt')).status).toBe(404);
    expect((await get('aio://project/p1/%2E%2E/secret.txt')).status).toBe(404);
  });

  it('serves map packs by id', async () => {
    const res = await get('aio://packs/gcc.pmtiles', { Range: 'bytes=0-1' });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-type')).toBe('application/vnd.pmtiles');
    expect(await res.text()).toBe('PM');
  });

  it('serves imagery and terrain packs from their folders (M10 G7)', async () => {
    const res = await get('aio://packs/imagery/site.pmtiles', { Range: 'bytes=0-5' });
    expect(res.status).toBe(206);
    expect(await res.text()).toBe('Raster');
    expect((await get('aio://packs/imagery/site.json')).status).toBe(404);
    expect((await get('aio://packs/terrain/site.pmtiles')).status).toBe(404);
    expect((await get('aio://packs/other/site.pmtiles')).status).toBe(404);
  });

  it('refuses pack names that are not plain ids', async () => {
    expect((await get('aio://packs/GCC.pmtiles')).status).toBe(404);
    expect((await get('aio://packs/..%2Fsecret.txt')).status).toBe(404);
    expect((await get('aio://packs/gcc.json')).status).toBe(404);
  });

  it('serves a legacy viewer document with the shims first and the legacy CSP', async () => {
    const res = await get('aio://project/p1/legacy/Old%20Review.html', { Range: 'bytes=0-3' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('content-security-policy')).toBe(LEGACY_CSP);
    const html = await res.text();
    expect(res.headers.get('content-length')).toBe(String(Buffer.byteLength(html)));
    const shim = html.indexOf('"projectId":"p1"');
    expect(shim).toBeGreaterThan(-1);
    expect(shim).toBeLessThan(html.indexOf('<script src="data/site.js">'));
    expect(html).not.toContain('fonts.googleapis.com');
    expect(html).toContain('<body>review</body>');
  });

  it('answers HEAD on a legacy document without a body', async () => {
    const res = await get('aio://project/p1/legacy/Old%20Review.html', {}, 'HEAD');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
  });

  it('serves the files next to a legacy viewer unchanged', async () => {
    const res = await get('aio://project/p1/legacy/data/site.js');
    expect(res.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(res.headers.get('content-security-policy')).toBeNull();
    expect(await res.text()).toBe('window.SITE=1;');
  });

  it('does not touch HTML outside legacy/', async () => {
    const res = await get('aio://project/p1/report.html');
    expect(await res.text()).toBe('<html><head></head></html>');
  });

  it('answers 404 for unknown hosts', async () => {
    expect((await get('aio://elsewhere/x')).status).toBe(404);
  });
});

describe('mimeFor', () => {
  it.each([
    ['a.mp4', 'video/mp4'],
    ['a.GLB', 'model/gltf-binary'],
    ['a.json', 'application/json'],
    ['a.jpg', 'image/jpeg'],
    ['a.jpeg', 'image/jpeg'],
    ['a.png', 'image/png'],
    ['a.webp', 'image/webp'],
    ['a.pmtiles', 'application/vnd.pmtiles'],
    ['a.pdf', 'application/pdf'],
    ['a.bin', 'application/octet-stream'],
    ['a.htm', 'text/html; charset=utf-8'],
    ['a.mjs', 'text/javascript; charset=utf-8'],
    ['a.woff2', 'font/woff2'],
    ['a.woff', 'font/woff'],
    ['a.ttf', 'font/ttf'],
    ['a.gif', 'image/gif'],
    ['a.zip', 'application/zip'],
    ['a.xml', 'application/xml'],
    ['a.ico', 'image/x-icon'],
    ['a.avif', 'image/avif'],
    ['a.unknown', 'application/octet-stream'],
  ])('%s is %s', (file, type) => {
    expect(mimeFor(file)).toBe(type);
  });
});
