/**
 * Online maps (ADR 0007, amendments of 10 and 14 Oct 2026, founder: "not everybody wants to work
 * completely offline"): every source of the catalog (`ONLINE_SOURCES` in `@aio/schema`), off by
 * default. Sentinel-2 cloudless 2016 by EOX needs no key; Esri World Imagery takes an optional
 * key; Mapbox needs one.
 *
 * Main owns the network. The renderer asks the app's own protocol,
 * `aio://online/<sourceId>/<z>/<x>/<y>` (`onlineTileUrl`), and never names a service or holds a
 * key. For every tile this module passes one gate, in this order:
 *
 * 1. online maps off (userData `online.json`, `onlineSettings.ts`): 403, without touching the
 *    disk, the memory or the network;
 * 2. a bad address or an unknown source: 400 (a catalog id, whole numbers, a zoom the source
 *    has, x and y inside the zoom; 0.11's `<y>.jpg` is still answered for Sentinel-2 only);
 * 3. a source that needs a key without one in the vault: 401 (the key is read here, in main, for
 *    every tile, so a removed key stops tiles at once, even those held in memory);
 * 4. a Sentinel-2 tile on disk: served, also on an offline-only workstation;
 * 5. offline-only: 404, and nothing more (not even the tiles held in memory);
 * 6. the service: the source's own hosts (`onlineUpstream.ts`) over https, no redirect followed,
 *    no cookie, a few requests at a time in total, a User-Agent that names the app, and the key
 *    added only to the request to its own provider.
 *
 * Only Sentinel-2 is kept on disk (a bounded cache, the tiles used longest ago go first). Esri
 * and Mapbox forbid offline storage: their tiles are held in a bounded memory for this session
 * only (`onlineMemory.ts`). Each source backs off on its own when it fails, and 404 is answered
 * meanwhile so the map falls back to the coarser tiles it has, quietly. An answer is a tile only
 * when its bytes are a picture of a type the source serves (an ArcGIS error comes back as a 200
 * with a JSON body).
 *
 * An upstream address can carry a key: it is never logged, never a cache key and never part of
 * an answer or an error that leaves this module.
 *
 * Nothing is fetched ahead of a view: a tile is requested only because a view asked for it.
 */
import {
  onlineAvailability,
  onlineSource,
  type MapKeyProvider,
  type OnlineSource,
  type OnlineSourceId,
  type OnlineTileCache,
} from '@aio/schema';
import { mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createMemoryTiles, DEFAULT_MEMORY_CAP_BYTES } from './onlineMemory';
import { upstreamTileUrl } from './onlineUpstream';

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
   * The two switches, read for every tile: `enabled` (online maps on, `onlineSettings.ts`) and
   * `offlineOnly` (`settings.current()`, so offline-only counts from the moment it is asked for).
   */
  switches: () => { enabled: boolean; offlineOnly: boolean };
  /** A provider's key from the vault, or null. Main only: never logged, never answered. */
  key: (provider: MapKeyProvider) => Promise<string | null>;
  /** The folder of the Sentinel-2 tile cache (`<userData>/cache/online-tiles`). */
  cacheDir: () => string;
  /**
   * How to reach the services, or null where the app must never do so (an e2e run without a
   * fake fetcher): Sentinel-2 tiles on disk still serve, everything else is a 404.
   */
  fetch: TileFetch | null;
  /** Names the app to the services, e.g. `Quadrion AI/0.14.0 (...)`. */
  userAgent: string;
  capBytes?: number;
  memoryCapBytes?: number;
  concurrency?: number;
  timeoutMs?: number;
  now?: () => number;
}

/** The answer of a key check: one tile asked with the key given. */
export type ProbeResult = 'ok' | 'refused' | 'unreachable' | 'offline-only' | 'no-network';

export interface OnlineTiles {
  /** Answer `aio://online/<segments>` (the path after the host, decoded). */
  serve(segments: readonly string[], req: Request): Promise<Response>;
  /** The size of the Sentinel-2 cache on disk and its cap. */
  cache(): Promise<OnlineTileCache>;
  /** Delete every saved tile (disk and memory). */
  clear(): Promise<OnlineTileCache>;
  /** Check a key before it is stored (`mapKeys:set`) or again (`mapKeys:test`). */
  probe(id: OnlineSourceId, key: string): Promise<ProbeResult>;
}

export interface TileAddress {
  id: OnlineSourceId;
  z: number;
  x: number;
  y: number;
}

const WHOLE = /^(0|[1-9]\d{0,8})$/;

/**
 * The tile a path names, or null: `<id>/<z>/<x>/<y>` with a catalog id, whole numbers without
 * leading zeros, a zoom the source has and x, y inside it. 0.11's address of Sentinel-2,
 * `<y>.jpg`, is still answered for that source only.
 */
export function parseTilePath(segments: readonly string[]): TileAddress | null {
  if (segments.length !== 4) return null;
  const [id, zs, xs, last] = segments;
  if (id === undefined || zs === undefined || xs === undefined || last === undefined) return null;
  const source = onlineSource(id);
  if (!source) return null;
  const ys = source.id === 's2cloudless-2016' && last.endsWith('.jpg') ? last.slice(0, -4) : last;
  if (!WHOLE.test(zs) || !WHOLE.test(xs) || !WHOLE.test(ys)) return null;
  const z = Number(zs);
  const x = Number(xs);
  const y = Number(ys);
  if (z < source.minZoom || z > source.maxZoom) return null;
  const n = 2 ** z;
  if (x >= n || y >= n) return null;
  return { id: source.id, z, x, y };
}

export type ImageType = 'image/jpeg' | 'image/png' | 'image/webp';

/** The picture's own type from its first bytes; null for anything that is not a tile. */
export function sniffImage(b: Uint8Array): ImageType | null {
  if (b.byteLength > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (b.byteLength > 8 && sig.every((v, i) => b[i] === v)) return 'image/png';
  const riff = [0x52, 0x49, 0x46, 0x46];
  const wbp = [0x57, 0x45, 0x42, 0x50];
  if (b.byteLength > 12 && riff.every((v, i) => b[i] === v) && wbp.every((v, i) => b[8 + i] === v))
    return 'image/webp';
  return null;
}

// Only the app itself can reach aio://, so a wildcard origin is safe and lets MapLibre and
// CesiumJS read the bytes from the file:// page (as for every other aio:// answer).
const COMMON = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Expose-Headers': 'x-aio-online',
  'Cache-Control': 'no-cache',
};

/** Why a tile was or was not served, readable by the page and the tests (`x-aio-online`). */
type Refusal =
  'off' | 'bad-address' | 'no-key' | 'offline-only' | 'no-network' | 'backoff' | 'missing';

function refuse(code: number, why: Refusal): Response {
  return new Response(null, { status: code, headers: { ...COMMON, 'x-aio-online': why } });
}

function tileResponse(
  data: Buffer,
  type: string,
  req: Request,
  from: 'cache' | 'memory' | 'network',
): Response {
  const headers = {
    ...COMMON,
    'Content-Type': type,
    'Content-Length': String(data.byteLength),
    'x-aio-online': from,
  };
  return new Response(req.method === 'HEAD' ? null : new Uint8Array(data), {
    status: 200,
    headers,
  });
}

const isJpeg = (b: Buffer) => sniffImage(b) === 'image/jpeg';

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
  | { kind: 'tile'; data: Buffer; type: ImageType }
  | { kind: 'missing' }
  | { kind: 'failed'; retryAfterMs?: number };

type Got = { data: Buffer; type: ImageType } | Refusal;

interface Waiting {
  key: string;
  tile: TileAddress;
  done: (r: Got) => void;
}

/** One source's own state: failures in a row, the wait they caused, tiles it does not have. */
interface Lane {
  failures: number;
  blockedUntil: number;
  missing: Map<string, number>;
}

/** Seconds of a `Retry-After` header as ms, or undefined (a date form is not worth parsing). */
function retryAfter(res: Response): number | undefined {
  const v = Number(res.headers.get('retry-after'));
  return Number.isFinite(v) && v > 0 ? v * 1000 : undefined;
}

const accept = (s: OnlineSource) => s.formats.map((f) => `image/${f}`).join(', ');

export function createOnlineTiles(o: OnlineTilesOptions): OnlineTiles {
  const now = o.now ?? Date.now;
  const capBytes = o.capBytes ?? DEFAULT_CACHE_CAP_BYTES;
  const concurrency = Math.max(1, o.concurrency ?? DEFAULT_CONCURRENCY);
  const timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const store = createTileStore(() => join(o.cacheDir(), 's2cloudless-2016'), capBytes, now);
  const memory = createMemoryTiles(o.memoryCapBytes ?? DEFAULT_MEMORY_CAP_BYTES);

  /** One request per tile however many views ask for it at once. */
  const pending = new Map<string, Promise<Got>>();
  const waiting: Waiting[] = [];
  /** Requests open in total (the polite limit is for the app, not per source). */
  let active = 0;
  const activeBy = new Map<OnlineSourceId, number>();
  const lanes = new Map<OnlineSourceId, Lane>();
  const lane = (id: OnlineSourceId): Lane => {
    let l = lanes.get(id);
    if (!l) {
      l = { failures: 0, blockedUntil: 0, missing: new Map() };
      lanes.set(id, l);
    }
    return l;
  };

  /**
   * The source's key from the vault, or null; a vault that fails reads as no key. Read for every
   * tile, never kept here, so a removed key counts at once.
   */
  const secretOf = (source: OnlineSource): Promise<string | null> =>
    source.keyProvider ? o.key(source.keyProvider).catch(() => null) : Promise.resolve(null);

  const init = (source: OnlineSource, signal: AbortSignal) => ({
    headers: { 'User-Agent': o.userAgent, Accept: accept(source) },
    // a redirect would let the service send us to another host: an error instead
    redirect: 'error' as const,
    // no cookie is kept or sent: a tile request carries the address of the tile and no more
    credentials: 'omit' as const,
    signal,
  });

  /**
   * One request to the service. The address may carry a key, so nothing here keeps, logs or
   * rethrows it or an error made from it: every failure is only `failed`.
   */
  async function ask(
    fetchTile: TileFetch,
    source: OnlineSource,
    t: TileAddress,
    secret: string | null,
  ): Promise<Fetched> {
    let res: Response;
    try {
      res = await fetchTile(
        upstreamTileUrl(t.id, t.z, t.x, t.y, secret),
        init(source, AbortSignal.timeout(timeoutMs)),
      );
    } catch {
      return { kind: 'failed' };
    }
    try {
      if (res.status === 404) return { kind: 'missing' };
      if (res.status !== 200) {
        const wait = retryAfter(res);
        return wait === undefined ? { kind: 'failed' } : { kind: 'failed', retryAfterMs: wait };
      }
      const header = (res.headers.get('content-type') ?? '').toLowerCase();
      const length = Number(res.headers.get('content-length') ?? '0');
      if (!header.startsWith('image/') || length > MAX_TILE_BYTES) return { kind: 'failed' };
      const data = Buffer.from(await res.arrayBuffer());
      const type = sniffImage(data);
      if (data.byteLength > MAX_TILE_BYTES || !type) return { kind: 'failed' };
      if (!source.formats.some((f) => type === `image/${f}`)) return { kind: 'failed' };
      return { kind: 'tile', data, type };
    } catch {
      return { kind: 'failed' };
    } finally {
      if (!res.bodyUsed) await res.body?.cancel().catch(() => undefined);
    }
  }

  function failed(id: OnlineSourceId, retryAfterMs: number | undefined): void {
    const l = lane(id);
    l.failures += 1;
    const step = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.min(l.failures - 1, 16));
    const wait = Math.min(Math.max(step, retryAfterMs ?? 0), 2 * BACKOFF_MAX_MS);
    l.blockedUntil = Math.max(l.blockedUntil, now() + wait);
    // nothing of this source that was waiting goes to a service that just failed
    for (let i = waiting.length - 1; i >= 0; i--)
      if (waiting[i]?.tile.id === id) waiting.splice(i, 1)[0]?.done('backoff');
  }

  async function run(fetchTile: TileFetch, w: Waiting): Promise<Got> {
    const source = onlineSource(w.tile.id);
    if (!source) return 'bad-address';
    // a switch may have changed while the tile waited: offline-only stops it here
    const availability = onlineAvailability(source, o.switches());
    if (availability === 'off') return 'off';
    if (availability !== 'online') return 'offline-only';
    // and so may the key: read again, so a key removed meanwhile is not sent
    const secret = await secretOf(source);
    if (source.keyPolicy === 'required' && !secret) return 'no-key';
    const l = lane(source.id);
    if (now() < l.blockedUntil) return 'backoff';
    const r = await ask(fetchTile, source, w.tile, secret);
    if (r.kind === 'failed') {
      failed(source.id, r.retryAfterMs);
      return 'backoff';
    }
    l.failures = 0;
    l.blockedUntil = 0;
    if (r.kind === 'missing') {
      if (l.missing.size >= MAX_MISSING) l.missing.clear();
      l.missing.set(w.key, now() + MISSING_TTL_MS);
      return 'missing';
    }
    return { data: r.data, type: r.type };
  }

  /**
   * Keeps a tile the service sent, on disk or in memory. Called once the request's slot is free:
   * a slow disk must not hold back the tiles waiting for the service, least of all the ones a
   * probe after a failure lets go.
   */
  async function keep(w: Waiting, got: Got): Promise<Got> {
    if (typeof got === 'string') return got;
    if (onlineSource(w.tile.id)?.diskCache) {
      // `w.key` names the tile, never the upstream address
      if (isJpeg(got.data))
        await store.put(diskKey(w.tile), got.data).catch((e: unknown) => {
          console.warn(`Online tile ${w.key} was not cached: ${String(e)}`);
        });
    } else memory.put(w.key, got);
    return got;
  }

  function pump(fetchTile: TileFetch): void {
    while (active < concurrency) {
      // after a failure a source sends one request at a time until it answers again
      const i = waiting.findIndex(
        (w) => lane(w.tile.id).failures === 0 || (activeBy.get(w.tile.id) ?? 0) === 0,
      );
      if (i < 0) return;
      const [w] = waiting.splice(i, 1);
      if (!w) return;
      active += 1;
      activeBy.set(w.tile.id, (activeBy.get(w.tile.id) ?? 0) + 1);
      void run(fetchTile, w)
        .catch((): Refusal => 'backoff')
        .then((r) => {
          // the service has answered: its slot goes to the next tile before this one is kept
          active -= 1;
          activeBy.set(w.tile.id, (activeBy.get(w.tile.id) ?? 1) - 1);
          pump(fetchTile);
          return keep(w, r);
        })
        .catch((): Refusal => 'backoff')
        .then(w.done);
    }
  }

  function request(fetchTile: TileFetch, key: string, tile: TileAddress) {
    let p = pending.get(key);
    if (p) return p;
    p = new Promise<Got>((done) => {
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

  const status = (got: Refusal): number => (got === 'off' ? 403 : got === 'no-key' ? 401 : 404);

  return {
    async serve(segments, req) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return refuse(405, 'bad-address');
      const switches = o.switches();
      // 1. the switch first: while it is off nothing is read, held or asked
      if (!switches.enabled) return refuse(403, 'off');
      // 2. the address
      const tile = parseTilePath(segments);
      const source = tile ? onlineSource(tile.id) : undefined;
      if (!tile || !source) return refuse(400, 'bad-address');
      // 3. the key, from the vault, in main only
      if (source.keyPolicy === 'required' && !(await secretOf(source)))
        return refuse(401, 'no-key');
      const key = `${tile.id}/${String(tile.z)}/${String(tile.x)}/${String(tile.y)}`;
      // 4. Sentinel-2 on disk: a local file, so also on an offline-only workstation
      if (source.diskCache) {
        const cached = await store.get(diskKey(tile)).catch(() => null);
        if (cached) return tileResponse(cached, 'image/jpeg', req, 'cache');
      }
      // 5. offline-only: what is on disk and nothing more
      if (switches.offlineOnly) return refuse(404, 'offline-only');
      const held = memory.get(key);
      if (held) return tileResponse(held.data, held.type, req, 'memory');
      // 6. the service
      if (!o.fetch) return refuse(404, 'no-network');
      const l = lane(tile.id);
      const gone = l.missing.get(key);
      if (gone !== undefined) {
        if (now() < gone) return refuse(404, 'missing');
        l.missing.delete(key);
      }
      if (now() < l.blockedUntil) return refuse(404, 'backoff');
      const got = await request(o.fetch, key, tile);
      // 404 for every "no tile now": the client then draws the coarser tile it has, quietly
      return typeof got === 'string'
        ? refuse(status(got), got)
        : tileResponse(got.data, got.type, req, 'network');
    },
    cache: stats,
    async clear() {
      await store.clear();
      memory.clear();
      for (const l of lanes.values()) l.missing.clear();
      return stats();
    },
    async probe(id, secret) {
      if (o.switches().offlineOnly) return 'offline-only';
      if (!o.fetch) return 'no-network';
      const source = onlineSource(id);
      if (!source) return 'refused';
      if (source.keyPolicy === 'required' && !secret) return 'refused';
      // like `ask`: the address carries the key, so no error made from it leaves here
      let res: Response;
      try {
        res = await o.fetch(
          upstreamTileUrl(id, 0, 0, 0, secret),
          init(source, AbortSignal.timeout(timeoutMs)),
        );
      } catch {
        return 'unreachable';
      }
      try {
        if ([401, 403, 498, 499].includes(res.status)) return 'refused';
        if (res.status !== 200) return 'unreachable';
        const data = Buffer.from(await res.arrayBuffer());
        // an ArcGIS error comes back as 200 with a JSON body
        return data.byteLength <= MAX_TILE_BYTES && sniffImage(data) ? 'ok' : 'refused';
      } catch {
        return 'unreachable';
      } finally {
        if (!res.bodyUsed) await res.body?.cancel().catch(() => undefined);
      }
    },
  };
}

/** The Sentinel-2 file of a tile on disk, `<z>/<x>/<y>` (the layout 0.11 wrote). */
const diskKey = (t: TileAddress) => `${String(t.z)}/${String(t.x)}/${String(t.y)}`;

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
