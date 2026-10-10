/**
 * Online satellite tiles in main: the gate, the one host, the cache and the back-off, against a
 * fake fetcher that records every address (no network).
 */
import { ONLINE_SATELLITE, onlineSatelliteTileUrl } from '@aio/schema';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  createOnlineTiles,
  DEFAULT_CACHE_CAP_BYTES,
  fakeTileFetch,
  ONLINE_SATELLITE_HOST,
  ONLINE_SATELLITE_LAYER,
  parseTilePath,
  upstreamTileUrl,
  type OnlineTilesOptions,
  type TileFetch,
} from './onlineTiles';
import { createAioHandler } from './protocol/handler';
import { createOnlineSettingsStore, onlineSettingsPath } from './onlineSettings';
import { createSettingsStore, defaultSettings } from './settings';

/** A JPEG as far as the cache checks one: the SOI marker and `size` bytes in all. */
const jpeg = (size = 64, fill = 7) => {
  const b = Buffer.alloc(size, fill);
  b.set([0xff, 0xd8, 0xff, 0xe0]);
  return b;
};

interface Call {
  url: string;
  headers: Record<string, string>;
  redirect: string;
  credentials: string;
}

type Answer = () => Response | Promise<Response>;
const tile = (body = jpeg()): Answer => {
  return () =>
    new Response(new Uint8Array(body), { status: 200, headers: { 'Content-Type': 'image/jpeg' } });
};

/** A fetcher that records what it was asked and answers with `answer` (changeable). */
function recorder(first: Answer = tile()) {
  const calls: Call[] = [];
  const state = { answer: first };
  const fetch: TileFetch = (url, init) => {
    calls.push({
      url,
      headers: init.headers,
      redirect: init.redirect,
      credentials: init.credentials,
    });
    return Promise.resolve().then(() => state.answer());
  };
  return { calls, fetch, state };
}

let dir = '';
let flags: { satellite: boolean; offlineOnly: boolean };
let clock = 0;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aio-online-tiles-'));
  flags = { satellite: true, offlineOnly: false };
  clock = 1_000_000;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function service(fetch: TileFetch | null, extra: Partial<OnlineTilesOptions> = {}) {
  return createOnlineTiles({
    switches: () => flags,
    cacheDir: () => join(dir, 'cache'),
    fetch,
    userAgent: 'Quadrion AI/0.0.0 (test)',
    now: () => clock,
    ...extra,
  });
}

const ask = (s: ReturnType<typeof service>, path: string, method = 'GET') =>
  s.serve(path.split('/'), new Request(`aio://online/${path}`, { method }));

const ID = ONLINE_SATELLITE.id;
const cacheFile = (z: number, x: number, y: number) =>
  join(dir, 'cache', ID, String(z), String(x), `${String(y)}.jpg`);

describe('the address of the service', () => {
  it('is the one host over https, the 2016 layer, and z/y/x', () => {
    expect(upstreamTileUrl(12, 2234, 1420)).toBe(
      'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/GoogleMapsCompatible/12/1420/2234.jpg',
    );
    expect(ONLINE_SATELLITE_HOST).toBe('tiles.maps.eox.at');
    // 2016 is the layer without a year; the non-commercial years carry one
    expect(ONLINE_SATELLITE_LAYER).toBe('s2cloudless_3857');
    expect(ONLINE_SATELLITE_LAYER).not.toMatch(/20(1[7-9]|2\d)/);
  });

  it("the app's own address names no server and counts z/x/y", () => {
    expect(ONLINE_SATELLITE.tileUrl).toBe('aio://online/s2cloudless-2016/{z}/{x}/{y}.jpg');
    expect(onlineSatelliteTileUrl(12, 2234, 1420)).toBe(
      'aio://online/s2cloudless-2016/12/2234/1420.jpg',
    );
    expect(JSON.stringify(ONLINE_SATELLITE)).not.toContain(ONLINE_SATELLITE_HOST);
  });
});

describe('main owns the network', () => {
  const repo = join(import.meta.dirname, '..', '..', '..', '..');
  // .md too: the guide (docs/guide) is built into the renderer's help
  const SOURCE = /\.(tsx?|mjs|cjs|js|css|html|json|md)$/;
  function sources(folder: string): string[] {
    return readdirSync(folder, { withFileTypes: true }).flatMap((e) => {
      const p = join(folder, e.name);
      if (e.isDirectory()) return e.name === 'node_modules' ? [] : sources(p);
      return SOURCE.test(e.name) ? [p] : [];
    });
  }

  it('nothing the renderer is built from names the service', () => {
    const folders = [
      join(repo, 'apps', 'desktop', 'src', 'renderer'),
      join(repo, 'apps', 'desktop', 'src', 'preload'),
      join(repo, 'docs', 'guide'),
      ...readdirSync(join(repo, 'packages')).map((name) => join(repo, 'packages', name, 'src')),
    ].filter((f) => existsSync(f));
    expect(folders.length).toBeGreaterThan(10);
    const named = folders
      .flatMap(sources)
      .filter((file) => readFileSync(file, 'utf8').includes('eox.at'))
      .map((file) => relative(repo, file));
    expect(named).toEqual([]);
  });

  it('in main, only this module names it', () => {
    const main = join(repo, 'apps', 'desktop', 'src', 'main');
    const named = sources(main)
      .filter((file) => readFileSync(file, 'utf8').includes(ONLINE_SATELLITE_HOST))
      .map((file) => relative(main, file))
      .sort();
    expect(named).toEqual(['onlineTiles.test.ts', 'onlineTiles.ts']);
  });
});

describe('parseTilePath', () => {
  it('reads a tile of the one source', () => {
    expect(parseTilePath([ID, '12', '2234', '1420.jpg'])).toEqual({ z: 12, x: 2234, y: 1420 });
    expect(parseTilePath([ID, '0', '0', '0.jpg'])).toEqual({ z: 0, x: 0, y: 0 });
    expect(parseTilePath([ID, '14', '16383', '16383.jpg'])).toEqual({ z: 14, x: 16383, y: 16383 });
  });

  it('refuses anything else', () => {
    const bad = [
      ['s2cloudless-2018', '3', '4', '2.jpg'], // another year
      ['other', '3', '4', '2.jpg'],
      [ID, '15', '0', '0.jpg'], // deeper than the imagery: the client stretches zoom 14
      [ID, '3', '8', '2.jpg'], // x outside the zoom
      [ID, '3', '4', '8.jpg'], // y outside the zoom
      [ID, '-1', '0', '0.jpg'],
      [ID, '3', '04', '2.jpg'], // one spelling per tile
      [ID, '3', '4.5', '2.jpg'],
      [ID, '3', '4', '2.png'],
      [ID, '3', '4', '2'],
      [ID, '3', '4', '..jpg'],
      [ID, '3', '..', '2.jpg'],
      [ID, '3', '4'],
      [ID, '3', '4', '2.jpg', 'x'],
      [ID, '1e1', '0', '0.jpg'],
      [ID, '3', '99999999999', '2.jpg'],
    ];
    for (const segments of bad) expect(parseTilePath(segments), segments.join('/')).toBeNull();
  });
});

describe('the gate', () => {
  it('refuses while the switch is off: no request, nothing read or written', async () => {
    flags = { satellite: false, offlineOnly: false };
    const { calls, fetch } = recorder();
    // even a tile that is in the cache stays there
    await mkdir(join(dir, 'cache', ID, '3', '4'), { recursive: true });
    await writeFile(cacheFile(3, 4, 2), jpeg());
    const res = await ask(service(fetch), `${ID}/3/4/2.jpg`);
    expect(res.status).toBe(403);
    expect(res.headers.get('x-aio-online')).toBe('off');
    expect(await res.text()).toBe('');
    expect(calls).toEqual([]);
  });

  it('refuses when the switch is off and offline only is on', async () => {
    flags = { satellite: false, offlineOnly: true };
    const { calls, fetch } = recorder();
    expect((await ask(service(fetch), `${ID}/3/4/2.jpg`)).status).toBe(403);
    expect(calls).toEqual([]);
  });

  it('makes no request on an offline-only workstation', async () => {
    flags = { satellite: true, offlineOnly: true };
    const { calls, fetch } = recorder();
    const res = await ask(service(fetch), `${ID}/3/4/2.jpg`);
    expect(res.status).toBe(404);
    expect(res.headers.get('x-aio-online')).toBe('offline-only');
    expect(calls).toEqual([]);
    await expect(stat(join(dir, 'cache'))).rejects.toThrow();
  });

  it('serves the cache on an offline-only workstation, still without a request', async () => {
    const { calls, fetch } = recorder(tile(jpeg(80, 3)));
    const s = service(fetch);
    expect((await ask(s, `${ID}/3/4/2.jpg`)).status).toBe(200);
    expect(calls).toHaveLength(1);

    flags = { satellite: true, offlineOnly: true };
    const res = await ask(s, `${ID}/3/4/2.jpg`);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-aio-online')).toBe('cache');
    expect(Buffer.from(await res.arrayBuffer())).toEqual(jpeg(80, 3));
    // a tile never viewed stays unavailable
    expect((await ask(s, `${ID}/3/4/3.jpg`)).status).toBe(404);
    expect(calls).toHaveLength(1);
  });

  it('reads both switches at each tile, as main wires them', async () => {
    const settings = createSettingsStore(join(dir, 'settings.json'), defaultSettings(dir));
    const online = createOnlineSettingsStore(onlineSettingsPath(dir));
    await online.load();
    const { calls, fetch } = recorder();
    const s = service(fetch, {
      switches: () => ({
        satellite: online.satellite(),
        offlineOnly: settings.current().offlineOnly === true,
      }),
    });
    // off by default
    expect((await ask(s, `${ID}/3/4/2.jpg`)).status).toBe(403);
    expect(await online.set(true)).toEqual({ ok: true, satellite: true });
    expect((await ask(s, `${ID}/3/4/2.jpg`)).status).toBe(200);
    // offline only counts before the settings file is written
    void settings.set({ offlineOnly: true });
    expect((await ask(s, `${ID}/3/4/3.jpg`)).status).toBe(404);
    expect(calls).toHaveLength(1);
    await settings.settled();
    // switched off: refused from the moment it is asked for, before the file is written
    const off = online.set(false);
    expect((await ask(s, `${ID}/3/4/2.jpg`)).status).toBe(403);
    await off;
    expect(calls).toHaveLength(1);
    // the switch is not a settings.json field (older builds read that file with their own schema)
    expect(JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8'))).not.toHaveProperty(
      'onlineSatellite',
    );
  });

  it('never reaches the network without a fetcher (an e2e run)', async () => {
    const res = await ask(service(null), `${ID}/3/4/2.jpg`);
    expect(res.status).toBe(404);
    expect(res.headers.get('x-aio-online')).toBe('no-network');
  });

  it('answers 400 for a bad address and 405 for another method, without a request', async () => {
    const { calls, fetch } = recorder();
    const s = service(fetch);
    expect((await ask(s, `${ID}/15/0/0.jpg`)).status).toBe(400);
    expect((await ask(s, `${ID}/3/9/2.jpg`)).status).toBe(400);
    expect((await ask(s, 's2cloudless-2018/3/4/2.jpg')).status).toBe(400);
    expect((await ask(s, `${ID}/3/4/2.jpg`, 'POST')).status).toBe(405);
    expect(calls).toEqual([]);
  });
});

describe('a request to the service', () => {
  it('goes to the one host with the exact address, a User-Agent, no redirect, no cookie', async () => {
    const { calls, fetch } = recorder(tile(jpeg(100)));
    const res = await ask(service(fetch), `${ID}/12/2234/1420.jpg`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(res.headers.get('content-length')).toBe('100');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('x-aio-online')).toBe('network');
    expect(Buffer.from(await res.arrayBuffer())).toEqual(jpeg(100));
    expect(calls).toEqual([
      {
        // TileMatrix/TileRow/TileCol: z, then y, then x
        url: 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/GoogleMapsCompatible/12/1420/2234.jpg',
        headers: { 'User-Agent': 'Quadrion AI/0.0.0 (test)', Accept: 'image/jpeg' },
        redirect: 'error',
        // no cookies, in or out
        credentials: 'omit',
      },
    ]);
  });

  it('only ever names the one host, whatever is asked', async () => {
    const { calls, fetch } = recorder();
    const s = service(fetch);
    const paths = [
      `${ID}/0/0/0.jpg`,
      `${ID}/14/16383/0.jpg`,
      `${ID}/7/5/100.jpg`,
      `${ID}/7/5/%2e%2e.jpg`,
      `${ID}/3/4/2.jpg?host=example.com`,
      'evil.example/3/4/2.jpg',
    ];
    for (const p of paths) await ask(s, p);
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      const u = new URL(c.url);
      expect(u.protocol).toBe('https:');
      expect(u.host).toBe('tiles.maps.eox.at');
      expect(u.pathname).toMatch(
        /^\/wmts\/1\.0\.0\/s2cloudless_3857\/default\/GoogleMapsCompatible\/\d+\/\d+\/\d+\.jpg$/,
      );
      expect(u.search).toBe('');
    }
  });

  it('answers HEAD without a body', async () => {
    const { fetch } = recorder(tile(jpeg(50)));
    const res = await ask(service(fetch), `${ID}/3/4/2.jpg`, 'HEAD');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBe('50');
    expect(await res.text()).toBe('');
  });

  it('asks once for a tile several views want at the same moment', async () => {
    let release: (r: Response) => void = () => undefined;
    const { calls, fetch } = recorder(
      () =>
        new Promise<Response>((ok) => {
          release = ok;
        }),
    );
    const s = service(fetch);
    const both = Promise.all([ask(s, `${ID}/3/4/2.jpg`), ask(s, `${ID}/3/4/2.jpg`)]);
    await expect.poll(() => calls.length).toBe(1);
    release(await tile()());
    expect((await both).map((r) => r.status)).toEqual([200, 200]);
    expect(calls).toHaveLength(1);
  });

  it('keeps to a few requests at a time', async () => {
    const open: ((r: Response) => void)[] = [];
    let peak = 0;
    const { calls, fetch } = recorder(
      () =>
        new Promise<Response>((ok) => {
          open.push(ok);
          peak = Math.max(peak, open.length);
        }),
    );
    const s = service(fetch, { concurrency: 2 });
    const all = Promise.all([0, 1, 2, 3, 4].map((y) => ask(s, `${ID}/3/4/${String(y)}.jpg`)));
    await expect.poll(() => calls.length).toBe(2);
    while (calls.length < 5 || open.length > 0) {
      const next = open.shift();
      if (next) next(await tile()());
      await new Promise((ok) => setTimeout(ok, 1));
    }
    expect((await all).map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    expect(peak).toBe(2);
  });

  it('does not keep an answer that is not a JPEG tile', async () => {
    const html = () =>
      new Response('<html>busy</html>', { status: 200, headers: { 'Content-Type': 'text/html' } });
    const { fetch, state } = recorder(html);
    const s = service(fetch);
    expect((await ask(s, `${ID}/3/4/2.jpg`)).status).toBe(404);
    // the right type with the wrong bytes
    clock += BACKOFF_MAX_MS;
    state.answer = () =>
      new Response('not a jpeg', { status: 200, headers: { 'Content-Type': 'image/jpeg' } });
    expect((await ask(s, `${ID}/3/4/2.jpg`)).status).toBe(404);
    expect((await s.cache()).tiles).toBe(0);
  });
});

describe('the cache', () => {
  it('fetches once, then serves the file: a repeat view costs the service nothing', async () => {
    const { calls, fetch } = recorder(tile(jpeg(120, 9)));
    const s = service(fetch);
    const first = await ask(s, `${ID}/5/17/11.jpg`);
    expect(first.headers.get('x-aio-online')).toBe('network');
    expect(await readFile(cacheFile(5, 17, 11))).toEqual(jpeg(120, 9));

    const again = await ask(s, `${ID}/5/17/11.jpg`);
    expect(again.status).toBe(200);
    expect(again.headers.get('x-aio-online')).toBe('cache');
    expect(Buffer.from(await again.arrayBuffer())).toEqual(jpeg(120, 9));
    expect(calls).toHaveLength(1);
    expect(await s.cache()).toEqual({ bytes: 120, tiles: 1, capBytes: DEFAULT_CACHE_CAP_BYTES });
  });

  it('is found again after a restart', async () => {
    const a = recorder(tile(jpeg(90)));
    await ask(service(a.fetch), `${ID}/5/17/11.jpg`);
    const b = recorder();
    const s = service(b.fetch);
    expect(await s.cache()).toMatchObject({ bytes: 90, tiles: 1 });
    expect((await ask(s, `${ID}/5/17/11.jpg`)).headers.get('x-aio-online')).toBe('cache');
    expect(b.calls).toEqual([]);
  });

  it('gives up the tiles used longest ago when it is over its cap', async () => {
    const { calls, fetch } = recorder(tile(jpeg(100)));
    const s = service(fetch, { capBytes: 450 });
    for (const y of [0, 1, 2, 3]) await ask(s, `${ID}/3/0/${String(y)}.jpg`);
    expect(await s.cache()).toEqual({ bytes: 400, tiles: 4, capBytes: 450 });
    // tile 0 is used again, so tile 1 is now the one used longest ago
    expect((await ask(s, `${ID}/3/0/0.jpg`)).headers.get('x-aio-online')).toBe('cache');
    await ask(s, `${ID}/3/0/4.jpg`);
    // 500 bytes is over 450: down to nine tenths (405), so one tile goes
    expect(await s.cache()).toEqual({ bytes: 400, tiles: 4, capBytes: 450 });
    expect((await readdir(join(dir, 'cache', ID, '3', '0'))).sort()).toEqual([
      '0.jpg',
      '2.jpg',
      '3.jpg',
      '4.jpg',
    ]);
    // the evicted tile is asked for again when a view wants it
    const before = calls.length;
    expect((await ask(s, `${ID}/3/0/1.jpg`)).headers.get('x-aio-online')).toBe('network');
    expect(calls).toHaveLength(before + 1);
  });

  it('orders by the dates of the files after a restart', async () => {
    const a = recorder(tile(jpeg(100)));
    const first = service(a.fetch, { capBytes: 10_000 });
    for (const y of [0, 1, 2]) await ask(first, `${ID}/3/0/${String(y)}.jpg`);
    // dates set by hand, a minute apart (no reliance on the clock or the file system's precision):
    // tile 1 was used longest ago, then 0, then 2
    const used = new Map([
      [1, 1_700_000_000],
      [0, 1_700_000_060],
      [2, 1_700_000_120],
    ]);
    for (const [y, at] of used) await utimes(cacheFile(3, 0, y), at, at);
    const s = service(a.fetch, { capBytes: 250 });
    await ask(s, `${ID}/3/0/3.jpg`);
    // 400 over 250: down to 225, the two files used longest ago go
    expect((await readdir(join(dir, 'cache', ID, '3', '0'))).sort()).toEqual(['2.jpg', '3.jpg']);
  });

  it('is emptied by clear, and fills again afterwards', async () => {
    const { calls, fetch } = recorder(tile(jpeg(100)));
    const s = service(fetch);
    await ask(s, `${ID}/3/4/2.jpg`);
    await ask(s, `${ID}/4/1/1.jpg`);
    expect(await s.clear()).toEqual({ bytes: 0, tiles: 0, capBytes: DEFAULT_CACHE_CAP_BYTES });
    await expect(stat(join(dir, 'cache', ID))).rejects.toThrow();
    expect((await ask(s, `${ID}/3/4/2.jpg`)).headers.get('x-aio-online')).toBe('network');
    expect(calls).toHaveLength(3);
    expect(await s.cache()).toMatchObject({ bytes: 100, tiles: 1 });
  });

  it('drops a cached file that is not a JPEG and asks again', async () => {
    await mkdir(join(dir, 'cache', ID, '3', '4'), { recursive: true });
    await writeFile(cacheFile(3, 4, 2), 'half a tile');
    const { calls, fetch } = recorder(tile(jpeg(70)));
    const res = await ask(service(fetch), `${ID}/3/4/2.jpg`);
    expect(res.headers.get('x-aio-online')).toBe('network');
    expect(calls).toHaveLength(1);
    expect(await readFile(cacheFile(3, 4, 2))).toEqual(jpeg(70));
  });
});

describe('when the service fails', () => {
  const down = () => Promise.reject(new TypeError('fetch failed'));

  it('answers 404 quietly and waits before it asks again', async () => {
    const { calls, fetch, state } = recorder(down);
    const s = service(fetch);
    const res = await ask(s, `${ID}/3/4/2.jpg`);
    expect(res.status).toBe(404);
    expect(res.headers.get('x-aio-online')).toBe('backoff');
    expect(calls).toHaveLength(1);

    // inside the wait: no request, for this tile or another
    clock += BACKOFF_BASE_MS - 1;
    expect((await ask(s, `${ID}/3/4/2.jpg`)).status).toBe(404);
    expect((await ask(s, `${ID}/3/4/3.jpg`)).status).toBe(404);
    expect(calls).toHaveLength(1);

    // after it: one more try; a second failure doubles the wait
    clock += 1;
    expect((await ask(s, `${ID}/3/4/2.jpg`)).status).toBe(404);
    expect(calls).toHaveLength(2);
    clock += BACKOFF_BASE_MS;
    expect((await ask(s, `${ID}/3/4/2.jpg`)).status).toBe(404);
    expect(calls).toHaveLength(2);
    clock += BACKOFF_BASE_MS;

    // back again: the tile is served and the wait is forgotten
    state.answer = tile();
    expect((await ask(s, `${ID}/3/4/2.jpg`)).status).toBe(200);
    expect(calls).toHaveLength(3);
    state.answer = down;
    await ask(s, `${ID}/3/4/3.jpg`);
    clock += BACKOFF_BASE_MS;
    state.answer = tile();
    expect((await ask(s, `${ID}/3/4/3.jpg`)).status).toBe(200);
  });

  it('never waits longer than the longest wait', async () => {
    const { calls, fetch } = recorder(down);
    const s = service(fetch);
    for (let i = 0; i < 12; i += 1) {
      await ask(s, `${ID}/3/4/2.jpg`);
      clock += BACKOFF_MAX_MS;
    }
    expect(calls).toHaveLength(12);
  });

  it('treats a server error as a failure and honours Retry-After', async () => {
    const busy = () => new Response('slow down', { status: 429, headers: { 'Retry-After': '60' } });
    const { calls, fetch } = recorder(busy);
    const s = service(fetch);
    expect((await ask(s, `${ID}/3/4/2.jpg`)).status).toBe(404);
    clock += 59_000;
    await ask(s, `${ID}/3/4/2.jpg`);
    expect(calls).toHaveLength(1);
    clock += 1_000;
    await ask(s, `${ID}/3/4/2.jpg`);
    expect(calls).toHaveLength(2);
  });

  it('tries one tile at a time until the service answers again', async () => {
    const { calls, fetch, state } = recorder(down);
    const s = service(fetch, { concurrency: 4 });
    await ask(s, `${ID}/3/4/2.jpg`);
    clock += BACKOFF_BASE_MS;
    const open: ((r: Response) => void)[] = [];
    state.answer = () =>
      new Promise<Response>((ok) => {
        open.push(ok);
      });
    const all = Promise.all([0, 1, 2].map((y) => ask(s, `${ID}/3/0/${String(y)}.jpg`)));
    await expect.poll(() => calls.length).toBe(2);
    await new Promise((ok) => setTimeout(ok, 5));
    expect(open).toHaveLength(1); // one probe, the others wait
    open.shift()?.(await tile()());
    await expect.poll(() => open.length).toBe(2); // the service is back: the rest go together
    for (const ok of open.splice(0)) ok(await tile()());
    expect((await all).map((r) => r.status)).toEqual([200, 200, 200]);
  });

  it('gives up the tiles that were waiting when it fails', async () => {
    const open: ((r: Response | Promise<Response>) => void)[] = [];
    const { calls, fetch } = recorder(
      () =>
        new Promise<Response>((ok) => {
          open.push(ok);
        }),
    );
    const s = service(fetch, { concurrency: 1 });
    const all = Promise.all([0, 1, 2].map((y) => ask(s, `${ID}/3/0/${String(y)}.jpg`)));
    await expect.poll(() => open.length).toBe(1);
    open.shift()?.(Promise.reject(new TypeError('fetch failed')));
    expect((await all).map((r) => r.status)).toEqual([404, 404, 404]);
    expect(calls).toHaveLength(1);
  });

  it('remembers a tile the service does not have, without backing off', async () => {
    const { calls, fetch, state } = recorder(() => new Response('', { status: 404 }));
    const s = service(fetch);
    const res = await ask(s, `${ID}/3/4/2.jpg`);
    expect(res.status).toBe(404);
    expect(res.headers.get('x-aio-online')).toBe('missing');
    await ask(s, `${ID}/3/4/2.jpg`);
    expect(calls).toHaveLength(1);
    // another tile is asked for at once: a missing tile is not a failure of the service
    state.answer = tile();
    expect((await ask(s, `${ID}/3/4/3.jpg`)).status).toBe(200);
    expect(calls).toHaveLength(2);
  });

  it('a redirect is a failure, never followed', async () => {
    // `redirect: 'error'` makes fetch reject; a fetcher that hands the redirect back is refused too
    const moved = () =>
      new Response(null, { status: 302, headers: { Location: 'https://example.invalid/t.jpg' } });
    const { calls, fetch } = recorder(moved);
    const s = service(fetch);
    expect((await ask(s, `${ID}/3/4/2.jpg`)).status).toBe(404);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.redirect).toBe('error');
    expect((await s.cache()).tiles).toBe(0);
  });
});

describe('through the aio:// handler', () => {
  const handler = (onlineTile?: ReturnType<typeof service>) =>
    createAioHandler({
      projectRoot: () => undefined,
      packsDir: () => join(dir, 'packs'),
      ...(onlineTile ? { onlineTile: (segments, req) => onlineTile.serve(segments, req) } : {}),
    });

  it('serves aio://online/<id>/<z>/<x>/<y>.jpg', async () => {
    const log: string[] = [];
    const h = handler(service(fakeTileFetch(() => jpeg(60), log)));
    const res = await h(new Request(onlineSatelliteTileUrl(11, 1117, 710)));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(log).toEqual([
      'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/GoogleMapsCompatible/11/710/1117.jpg',
    ]);
  });

  it('is off by default, and absent without the service', async () => {
    flags = { satellite: false, offlineOnly: false };
    const log: string[] = [];
    const h = handler(service(fakeTileFetch(() => jpeg(), log)));
    expect((await h(new Request(onlineSatelliteTileUrl(3, 4, 2)))).status).toBe(403);
    expect(log).toEqual([]);
    expect((await handler()(new Request(onlineSatelliteTileUrl(3, 4, 2)))).status).toBe(404);
  });
});
