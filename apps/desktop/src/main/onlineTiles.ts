/**
 * Online satellite imagery (ADR 0007, amendment of 10 Oct 2026, founder: "not everybody wants to
 * work completely offline"). One named, keyless, openly licensed source, off by default:
 * Sentinel-2 cloudless 2016 by EOX (CC BY 4.0).
 *
 * Main owns the network. The renderer asks the app's own protocol,
 * `aio://online/s2cloudless-2016/{z}/{x}/{y}.jpg` (`ONLINE_SATELLITE.tileUrl`), and never names
 * the service. For every tile this module:
 *
 * - refuses with 403, without touching the disk or the network, unless the person switched
 *   **Online satellite** on (userData `online.json`, `onlineSettings.ts`);
 * - checks the address: the one source id, whole numbers, zoom 0 to 14, x and y inside the zoom;
 * - answers from the cache on this computer when the tile is there (a local file, so also on an
 *   offline-only workstation);
 * - asks the service only when the workstation is not offline-only: the one host below over
 *   https, no redirect followed, a few requests at a time, a User-Agent that names the app;
 * - keeps what it fetched in a bounded cache (the tiles used longest ago go first), so areas
 *   already viewed stay available and cost the service nothing the second time;
 * - backs off when the service fails, and answers 404 meanwhile so the map falls back to the
 *   coarser tiles it has, quietly.
 *
 * Nothing is fetched ahead of a view: a tile is requested only because a view asked for it.
 */
import { ONLINE_SATELLITE, onlineSatelliteAvailability, type OnlineTileCache } from '@aio/schema';
import { mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** The one server this module ever asks. */
export const ONLINE_SATELLITE_HOST = 'tiles.maps.eox.at';

/**
 * The WMTS layer: Sentinel-2 cloudless **2016** in Web Mercator. In the service's capabilities
 * document (`https://tiles.maps.eox.at/wmts/1.0.0/WMTSCapabilities.xml`, read 10 Oct 2026) the
 * 2016 layer is the one without a year in its identifier; `s2cloudless-2016_3857` does not exist.
 *
 * 2016 only, on purpose: it is released under CC BY 4.0 (commercial use, use of the hosted tiles
 * in applications and keeping tiles are allowed, with attribution). The 2018 to 2025 layers
 * (`s2cloudless-<year>_3857`) are CC BY-NC-SA 4.0, non-commercial, and must never be used here;
 * 2017 is not cleared for use either. Do not change this id without the founder's decision and
 * an amendment to ADR 0007.
 */
export const ONLINE_SATELLITE_LAYER = 's2cloudless_3857';

/** Web Mercator tiles, 256 px, zoom 0 at the top (the service's `GoogleMapsCompatible` set). */
const MATRIX_SET = 'GoogleMapsCompatible';

/**
 * The service's address of a tile. WMTS REST counts TileMatrix, TileRow, TileCol, so the path is
 * z/y/x (the app's own address is z/x/y).
 */
export function upstreamTileUrl(z: number, x: number, y: number): string {
  return `https://${ONLINE_SATELLITE_HOST}/wmts/1.0.0/${ONLINE_SATELLITE_LAYER}/default/${MATRIX_SET}/${String(z)}/${String(y)}/${String(x)}.jpg`;
}

/** 300 MB: about 15 000 tiles, a few towns at full detail or a country at overview. */
export const DEFAULT_CACHE_CAP_BYTES = 300 * 2 ** 20;
/** Requests to the service at one time. */
export const DEFAULT_CONCURRENCY = 4;
/** Tiles waiting for a free request; beyond it the one waiting longest is given up. */
const MAX_WAITING = 64;
const DEFAULT_TIMEOUT_MS = 15_000;
/** The wait after a first failure; doubled for each further one, up to `BACKOFF_MAX_MS`. */
export const BACKOFF_BASE_MS = 5_000;
export const BACKOFF_MAX_MS = 5 * 60_000;
/** A tile the service says it does not have is not asked for again for this long. */
const MISSING_TTL_MS = 60 * 60_000;
const MAX_MISSING = 4_000;
/** No imagery tile is near this; a larger answer is not a tile. */
const MAX_TILE_BYTES = 2 * 2 ** 20;
/** How often a tile's file date is refreshed when it is read (what the next start orders by). */
const TOUCH_EVERY_MS = 6 * 60 * 60_000;

/** `fetch`, as far as this module uses it. */
export type TileFetch = (
  url: string,
  init: {
    headers: Record<string, string>;
    redirect: 'error';
    credentials: 'omit';
    signal: AbortSignal;
  },
) => Promise<Response>;

export interface OnlineTilesOptions {
  /**
   * The two switches, read for every tile: `satellite` (the person switched online satellite on,
   * `onlineSettings.ts`) and `offlineOnly` (`settings.current()`, so offline-only counts from the
   * moment it is asked for).
   */
  switches: () => { satellite: boolean; offlineOnly: boolean };
  /** The folder of the tile cache (`<userData>/cache/online-tiles`). */
  cacheDir: () => string;
  /**
   * How to reach the service, or null where the app must never do so (an e2e run without a fake
   * fetcher): cached tiles still serve, everything else is a 404.
   */
  fetch: TileFetch | null;
  /** Names the app to the service, e.g. `Quadrion AI/0.11.0 (...)`. */
  userAgent: string;
  capBytes?: number;
  concurrency?: number;
  timeoutMs?: number;
  now?: () => number;
}

export interface OnlineTiles {
  /** Answer `aio://online/<segments>` (the path after the host, decoded). */
  serve(segments: readonly string[], req: Request): Promise<Response>;
  /** The size of the cache and its cap. */
  cache(): Promise<OnlineTileCache>;
  /** Delete every cached tile. */
  clear(): Promise<OnlineTileCache>;
}

export interface TileAddress {
  z: number;
  x: number;
  y: number;
}

const WHOLE = /^(0|[1-9]\d{0,8})$/;

/**
 * The tile a path names, or null when it is not one of ours: `<id>/<z>/<x>/<y>.jpg` with the one
 * source id, whole numbers without leading zeros, a zoom the source has and x, y inside it.
 */
export function parseTilePath(segments: readonly string[]): TileAddress | null {
  if (segments.length !== 4) return null;
  const [id, zs, xs, file] = segments;
  if (id !== ONLINE_SATELLITE.id || zs === undefined || xs === undefined || file === undefined)
    return null;
  if (!file.endsWith('.jpg')) return null;
  const ys = file.slice(0, -4);
  if (!WHOLE.test(zs) || !WHOLE.test(xs) || !WHOLE.test(ys)) return null;
  const z = Number(zs);
  const x = Number(xs);
  const y = Number(ys);
  if (z < ONLINE_SATELLITE.minZoom || z > ONLINE_SATELLITE.maxZoom) return null;
  const n = 2 ** z;
  if (x >= n || y >= n) return null;
  return { z, x, y };
}

// Only the app itself can reach aio://, so a wildcard origin is safe and lets MapLibre and
// CesiumJS read the bytes from the file:// page (as for every other aio:// answer).
const COMMON = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Expose-Headers': 'x-aio-online',
  'Cache-Control': 'no-cache',
};

/** Why a tile was or was not served, readable by the page and the tests (`x-aio-online`). */
type Refusal = 'off' | 'bad-address' | 'offline-only' | 'no-network' | 'backoff' | 'missing';

function refuse(code: number, why: Refusal): Response {
  return new Response(null, { status: code, headers: { ...COMMON, 'x-aio-online': why } });
}

function tileResponse(data: Buffer, req: Request, from: 'cache' | 'network'): Response {
  const headers = {
    ...COMMON,
    'Content-Type': 'image/jpeg',
    'Content-Length': String(data.byteLength),
    'x-aio-online': from,
  };
  return new Response(req.method === 'HEAD' ? null : new Uint8Array(data), {
    status: 200,
    headers,
  });
}

const isJpeg = (b: Buffer) => b.byteLength > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;

interface Entry {
  size: number;
  /** When the file's date was last written (ms). */
  touched: number;
}

/**
 * The tiles on disk, `<dir>/<z>/<x>/<y>.jpg`, least recently used first. The order is kept in
 * memory and survives a restart through the files' dates.
 */
function createTileStore(dir: () => string, capBytes: number, now: () => number) {
  /** Insertion order is the order of use: the first key is the next to go. */
  let index: Map<string, Entry> | null = null;
  let bytes = 0;
  let scanning: Promise<Map<string, Entry>> | null = null;
  const file = (key: string) => join(dir(), ...key.split('/')) + '.jpg';

  async function scan(): Promise<Map<string, Entry>> {
    const found: { key: string; size: number; mtime: number }[] = [];
    const list = (p: string) => readdir(p).catch(() => [] as string[]);
    for (const z of await list(dir())) {
      if (!WHOLE.test(z)) continue;
      for (const x of await list(join(dir(), z))) {
        if (!WHOLE.test(x)) continue;
        for (const name of await list(join(dir(), z, x))) {
          const y = name.endsWith('.jpg') ? name.slice(0, -4) : '';
          if (!WHOLE.test(y)) continue;
          try {
            const s = await stat(join(dir(), z, x, name));
            if (s.isFile()) found.push({ key: `${z}/${x}/${y}`, size: s.size, mtime: s.mtimeMs });
          } catch {
            // gone since it was listed
          }
        }
      }
    }
    found.sort((a, b) => a.mtime - b.mtime);
    const map = new Map<string, Entry>();
    bytes = 0;
    for (const f of found) {
      map.set(f.key, { size: f.size, touched: f.mtime });
      bytes += f.size;
    }
    return map;
  }

  async function ready(): Promise<Map<string, Entry>> {
    if (index) return index;
    scanning ??= scan();
    index = await scanning;
    scanning = null;
    return index;
  }

  function drop(map: Map<string, Entry>, key: string): void {
    const e = map.get(key);
    if (!e) return;
    map.delete(key);
    bytes -= e.size;
  }

  async function evict(map: Map<string, Entry>): Promise<void> {
    if (bytes <= capBytes) return;
    // down to nine tenths, so a full cache does not delete one tile for every tile it gains
    const target = Math.floor(capBytes * 0.9);
    for (const key of [...map.keys()]) {
      if (bytes <= target) break;
      drop(map, key);
      await rm(file(key), { force: true }).catch(() => undefined);
    }
  }

  return {
    async get(key: string): Promise<Buffer | null> {
      const map = await ready();
      const e = map.get(key);
      if (!e) return null;
      let data: Buffer;
      try {
        data = await readFile(file(key));
      } catch {
        drop(map, key); // removed behind our back
        return null;
      }
      if (!isJpeg(data)) {
        drop(map, key);
        await rm(file(key), { force: true }).catch(() => undefined);
        return null;
      }
      // used now: last in line to go
      map.delete(key);
      map.set(key, e);
      const t = now();
      if (t - e.touched > TOUCH_EVERY_MS) {
        e.touched = t;
        void utimes(file(key), new Date(t), new Date(t)).catch(() => undefined);
      }
      return data;
    },
    async put(key: string, data: Buffer): Promise<void> {
      await ready();
      const path = file(key);
      const tmp = `${path}.${String(process.pid)}.tmp`;
      await mkdir(dirname(path), { recursive: true });
      await writeFile(tmp, data);
      await rename(tmp, path);
      // the index as it is now: a clear while the file was written started a new one
      const map = await ready();
      drop(map, key);
      map.set(key, { size: data.byteLength, touched: now() });
      bytes += data.byteLength;
      await evict(map);
    },
    async stats(): Promise<{ bytes: number; tiles: number }> {
      const map = await ready();
      return { bytes, tiles: map.size };
    },
    async clear(): Promise<void> {
      await ready().catch(() => undefined);
      index = new Map();
      bytes = 0;
      await rm(dir(), { recursive: true, force: true });
    },
  };
}

type Fetched =
  { kind: 'tile'; data: Buffer } | { kind: 'missing' } | { kind: 'failed'; retryAfterMs?: number };

interface Waiting {
  key: string;
  tile: TileAddress;
  done: (r: Buffer | Refusal) => void;
}

/** Seconds of a `Retry-After` header as ms, or undefined (a date form is not worth parsing). */
function retryAfter(res: Response): number | undefined {
  const v = Number(res.headers.get('retry-after'));
  return Number.isFinite(v) && v > 0 ? v * 1000 : undefined;
}

export function createOnlineTiles(o: OnlineTilesOptions): OnlineTiles {
  const now = o.now ?? Date.now;
  const capBytes = o.capBytes ?? DEFAULT_CACHE_CAP_BYTES;
  const concurrency = Math.max(1, o.concurrency ?? DEFAULT_CONCURRENCY);
  const timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const store = createTileStore(() => join(o.cacheDir(), ONLINE_SATELLITE.id), capBytes, now);
  const state = () => onlineSatelliteAvailability(o.switches());

  /** One request per tile however many views ask for it at once. */
  const pending = new Map<string, Promise<Buffer | Refusal>>();
  const waiting: Waiting[] = [];
  let active = 0;
  /** Failures in a row; a success clears it. */
  let failures = 0;
  let blockedUntil = 0;
  const missing = new Map<string, number>();

  async function ask(fetchTile: TileFetch, t: TileAddress): Promise<Fetched> {
    const url = upstreamTileUrl(t.z, t.x, t.y);
    let res: Response;
    try {
      res = await fetchTile(url, {
        headers: { 'User-Agent': o.userAgent, Accept: 'image/jpeg' },
        // a redirect would let the service send us to another host: an error instead
        redirect: 'error',
        // no cookie is kept or sent: a tile request carries the address of the tile and no more
        credentials: 'omit',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      return { kind: 'failed' };
    }
    try {
      if (res.status === 404) return { kind: 'missing' };
      if (res.status !== 200) {
        const wait = retryAfter(res);
        return wait === undefined ? { kind: 'failed' } : { kind: 'failed', retryAfterMs: wait };
      }
      const type = (res.headers.get('content-type') ?? '').toLowerCase();
      const length = Number(res.headers.get('content-length') ?? '0');
      if (!type.startsWith('image/jpeg') || length > MAX_TILE_BYTES) return { kind: 'failed' };
      const data = Buffer.from(await res.arrayBuffer());
      if (data.byteLength > MAX_TILE_BYTES || !isJpeg(data)) return { kind: 'failed' };
      return { kind: 'tile', data };
    } catch {
      return { kind: 'failed' };
    } finally {
      if (!res.bodyUsed) await res.body?.cancel().catch(() => undefined);
    }
  }

  function failed(retryAfterMs: number | undefined): void {
    failures += 1;
    const step = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.min(failures - 1, 16));
    const wait = Math.min(Math.max(step, retryAfterMs ?? 0), 2 * BACKOFF_MAX_MS);
    blockedUntil = Math.max(blockedUntil, now() + wait);
    // nothing that was waiting goes to a service that just failed
    for (const w of waiting.splice(0)) w.done('backoff');
  }

  async function run(fetchTile: TileFetch, w: Waiting): Promise<Buffer | Refusal> {
    // a switch may have changed while the tile waited: offline-only stops it here
    if (state() !== 'online') return state() === 'off' ? 'off' : 'offline-only';
    if (now() < blockedUntil) return 'backoff';
    const r = await ask(fetchTile, w.tile);
    if (r.kind === 'failed') {
      failed(r.retryAfterMs);
      return 'backoff';
    }
    failures = 0;
    blockedUntil = 0;
    if (r.kind === 'missing') {
      if (missing.size >= MAX_MISSING) missing.clear();
      missing.set(w.key, now() + MISSING_TTL_MS);
      return 'missing';
    }
    await store.put(w.key, r.data).catch((e: unknown) => {
      console.warn(`Online satellite tile ${w.key} was not cached: ${String(e)}`);
    });
    return r.data;
  }

  function pump(fetchTile: TileFetch): void {
    // after a failure one request at a time finds out whether the service is back
    const limit = failures > 0 ? 1 : concurrency;
    while (active < limit) {
      const w = waiting.shift();
      if (!w) return;
      active += 1;
      void run(fetchTile, w)
        .catch((): Refusal => 'backoff')
        .then((r) => {
          active -= 1;
          w.done(r);
          pump(fetchTile);
        });
    }
  }

  function request(fetchTile: TileFetch, key: string, tile: TileAddress) {
    let p = pending.get(key);
    if (p) return p;
    p = new Promise<Buffer | Refusal>((done) => {
      waiting.push({ key, tile, done });
      pump(fetchTile);
      // the view moved on from the tile waiting longest: give it up rather than ask for more
      if (waiting.length > MAX_WAITING) waiting.shift()?.done('backoff');
    }).finally(() => {
      pending.delete(key);
    });
    pending.set(key, p);
    return p;
  }

  const stats = async (): Promise<OnlineTileCache> => ({ ...(await store.stats()), capBytes });

  return {
    async serve(segments, req) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return refuse(405, 'bad-address');
      // the switch first: while it is off nothing is read, cached or asked
      const availability = state();
      if (availability === 'off') return refuse(403, 'off');
      const tile = parseTilePath(segments);
      if (!tile) return refuse(400, 'bad-address');
      const key = `${String(tile.z)}/${String(tile.x)}/${String(tile.y)}`;

      const cached = await store.get(key).catch(() => null);
      if (cached) return tileResponse(cached, req, 'cache');
      // offline-only: what is on this computer and nothing more
      if (availability !== 'online') return refuse(404, 'offline-only');
      if (!o.fetch) return refuse(404, 'no-network');
      const gone = missing.get(key);
      if (gone !== undefined) {
        if (now() < gone) return refuse(404, 'missing');
        missing.delete(key);
      }
      if (now() < blockedUntil) return refuse(404, 'backoff');

      const got = await request(o.fetch, key, tile);
      // 404 for every "no tile now": MapLibre then draws the coarser tile it has, without an error
      return typeof got === 'string'
        ? refuse(got === 'off' ? 403 : 404, got)
        : tileResponse(got, req, 'network');
    },
    cache: stats,
    async clear() {
      await store.clear();
      missing.clear();
      return stats();
    },
  };
}

/**
 * A stand-in for the service in end-to-end tests: answers every tile with `jpeg` and writes the
 * address it was asked for to `log`, without any network. Only an isolated test profile gets it
 * (`index.ts`).
 */
export function fakeTileFetch(jpeg: () => Buffer, log: string[]): TileFetch {
  return (url) => {
    log.push(url);
    return Promise.resolve(
      new Response(new Uint8Array(jpeg()), {
        status: 200,
        headers: { 'Content-Type': 'image/jpeg' },
      }),
    );
  };
}
