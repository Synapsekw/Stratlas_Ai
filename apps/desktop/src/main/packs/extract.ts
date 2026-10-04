// Clip a PMTiles v3 archive to a bounding box and zoom, from a local file (map packs inside
// project packages) or over HTTP ranges (region downloads), resumable from the partial output.
//
// Output layout: header, root directory, metadata, leaf directories, then the tile data. Every
// byte before the tile data (the "head") is computed from the source directories alone, so the
// plan fixes the final size before any tile is fetched, and a cut-off run continues from the
// partial file's length. Tile contents keep the source order (deduplicated tiles stay shared).
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, stat, type FileHandle } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import {
  compress,
  Compression,
  decompress,
  HEADER_LEN,
  parseDirectory,
  readFullHeader,
  ROOT_FETCH,
  serializeDirectory,
  writeFullHeader,
  zxyToTileId,
  type Entry,
  type FullHeader,
} from './format';

/** A PMTiles archive read by byte ranges. */
export interface RangeSource {
  /** File path or URL, for messages. */
  readonly name: string;
  /** Bytes `[offset, offset + length)` in memory (header, directories, metadata, retries). */
  read(offset: number, length: number, signal?: AbortSignal): Promise<Buffer>;
  /** Bytes `[offset, offset + length)` as they arrive. */
  stream(offset: number, length: number, signal?: AbortSignal): AsyncIterable<Uint8Array>;
  /** What identifies this version of the source (ETag, or size and date); set after a read. */
  identity(): string | undefined;
}

/**
 * The partial output cannot be continued: the source changed since the plan was made (new ETag
 * or size), or the partial file no longer holds the planned head. The extract starts over.
 */
export class StartOverError extends Error {
  override name = 'StartOverError';
}

export type Bbox = readonly [number, number, number, number];

export const EXTRACT_SCHEMA = 'aio.pmextract/1';

export interface ExtractPlan {
  schema: typeof EXTRACT_SCHEMA;
  source: string;
  identity?: string;
  bbox: [number, number, number, number];
  maxZoom: number;
  /** Header, directories and metadata: bytes before the tile data. */
  headBytes: number;
  headSha256: string;
  dataBytes: number;
  totalBytes: number;
  /** Tiles addressed (run lengths counted) and distinct tile contents. */
  tiles: number;
  contents: number;
  /** Source byte ranges `[offset, length]` copied one after the other into the tile data. */
  runs: [number, number][];
  /** Tile compression of the source: gzip tiles carry a CRC-32 checked after the copy. */
  tileCompression: number;
}

const MAX_LAT = 85.0511287798;

function tileX(lon: number, n: number): number {
  return Math.min(n - 1, Math.max(0, Math.floor(((lon + 180) / 360) * n)));
}

function tileY(lat: number, n: number): number {
  const r = (Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)) * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n;
  return Math.min(n - 1, Math.max(0, Math.floor(y)));
}

/** Sorted tile ids of every tile from `minZoom` to `maxZoom` that touches `bbox`. */
export function wantedTiles(bbox: Bbox, minZoom: number, maxZoom: number): Float64Array {
  const [w, s, e, n] = bbox;
  const ranges: [number, number, number, number, number][] = [];
  let count = 0;
  for (let z = minZoom; z <= maxZoom; z++) {
    const size = 2 ** z;
    const x0 = tileX(w, size);
    const x1 = Math.max(x0, tileX(e - 1e-9, size));
    const y0 = tileY(n, size);
    const y1 = Math.max(y0, tileY(s + 1e-9, size));
    ranges.push([z, x0, x1, y0, y1]);
    count += (x1 - x0 + 1) * (y1 - y0 + 1);
  }
  if (count > 20_000_000) {
    throw new Error(
      `That area holds ${String(count)} tiles up to zoom ${String(maxZoom)}. Pick a smaller area or a lower zoom.`,
    );
  }
  const ids = new Float64Array(count);
  let i = 0;
  for (const [z, x0, x1, y0, y1] of ranges) {
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) ids[i++] = zxyToTileId(z, x, y);
  }
  return ids.sort();
}

function lowerBound(a: Float64Array, v: number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((a[mid] ?? 0) < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Leaf sizes grow until the root directory fits in the first 16 KB (go-pmtiles rule). */
function buildDirectories(
  entries: readonly Entry[],
  compression: number,
  target = ROOT_FETCH - HEADER_LEN,
): { root: Buffer; leaves: Buffer } {
  const whole = compress(serializeDirectory(entries), compression);
  if (whole.length <= target) return { root: whole, leaves: Buffer.alloc(0) };
  let leafSize = Math.max(4096, Math.floor(entries.length / 3500));
  for (;;) {
    const rootEntries: Entry[] = [];
    const parts: Buffer[] = [];
    let at = 0;
    for (let i = 0; i < entries.length; i += leafSize) {
      const chunk = entries.slice(i, i + leafSize);
      const leaf = compress(serializeDirectory(chunk), compression);
      rootEntries.push({
        tileId: chunk[0]?.tileId ?? 0,
        offset: at,
        length: leaf.length,
        runLength: 0,
      });
      parts.push(leaf);
      at += leaf.length;
    }
    const root = compress(serializeDirectory(rootEntries), compression);
    if (root.length <= target) return { root, leaves: Buffer.concat(parts) };
    leafSize = Math.floor(leafSize * 1.2);
  }
}

/** Directories of the source that may hold wanted tiles, fetched with few range requests. */
async function collectEntries(
  src: RangeSource,
  header: FullHeader,
  rootRaw: Buffer,
  wanted: Float64Array,
  signal?: AbortSignal,
): Promise<Entry[]> {
  const anyIn = (from: number, to: number) => {
    const i = lowerBound(wanted, from);
    return i < wanted.length && (wanted[i] ?? Infinity) < to;
  };
  const tiles: Entry[] = [];
  let level: Entry[][] = [parseDirectory(decompress(rootRaw, header.internalCompression))];
  for (let depth = 0; level.length > 0; depth++) {
    if (depth > 4) throw new Error(`${src.name} has directories nested too deep.`);
    const leaves: Entry[] = [];
    for (const dir of level) {
      dir.forEach((e, i) => {
        if (e.runLength > 0) {
          if (anyIn(e.tileId, e.tileId + e.runLength)) tiles.push(e);
          return;
        }
        const next = dir[i + 1]?.tileId ?? Infinity;
        if (anyIn(e.tileId, next)) leaves.push(e);
      });
    }
    // Fetch the needed leaves in batches of neighbouring byte ranges.
    leaves.sort((a, b) => a.offset - b.offset);
    const next: Entry[][] = [];
    for (let i = 0; i < leaves.length;) {
      const first = leaves[i];
      if (!first) break;
      let end = first.offset + first.length;
      let j = i + 1;
      for (; j < leaves.length; j++) {
        const l = leaves[j];
        if (!l || l.offset - end > 256 * 1024 || l.offset + l.length - first.offset > 8 << 20)
          break;
        end = Math.max(end, l.offset + l.length);
      }
      const block = await src.read(header.leafOffset + first.offset, end - first.offset, signal);
      for (let k = i; k < j; k++) {
        const l = leaves[k];
        if (!l) continue;
        const at = l.offset - first.offset;
        next.push(
          parseDirectory(decompress(block.subarray(at, at + l.length), header.internalCompression)),
        );
      }
      i = j;
    }
    level = next;
  }
  return tiles.sort((a, b) => a.tileId - b.tileId);
}

/**
 * Plan an extract: read the source header and the directories that touch `bbox` up to
 * `maxZoom` (no tile data), and compute the output head and its final size.
 */
export async function planExtract(
  src: RangeSource,
  o: {
    bbox: Bbox;
    maxZoom: number;
    signal?: AbortSignal;
    /** Largest root directory in bytes (tests); readers fetch the first 16 KB. */
    rootLimit?: number;
  },
): Promise<{ plan: ExtractPlan; head: Buffer }> {
  const first = await src.read(0, ROOT_FETCH, o.signal);
  const header = readFullHeader(first);
  const rootRaw =
    header.rootOffset + header.rootLength <= first.length
      ? first.subarray(header.rootOffset, header.rootOffset + header.rootLength)
      : await src.read(header.rootOffset, header.rootLength, o.signal);
  const [sw, ss, se, sn] = header.bounds;
  const bbox: [number, number, number, number] = [
    Math.max(o.bbox[0], sw),
    Math.max(o.bbox[1], ss),
    Math.min(o.bbox[2], se),
    Math.min(o.bbox[3], sn),
  ];
  if (bbox[0] >= bbox[2] || bbox[1] >= bbox[3]) {
    throw new Error(`${src.name} does not cover the area that was asked for.`);
  }
  const maxZoom = Math.min(o.maxZoom, header.maxZoom);
  if (maxZoom < header.minZoom) {
    throw new Error(`${src.name} starts at zoom ${String(header.minZoom)}; pick a higher zoom.`);
  }
  const wanted = wantedTiles(bbox, header.minZoom, maxZoom);
  const sourceEntries = await collectEntries(src, header, rootRaw, wanted, o.signal);

  // Wanted tiles per source entry, as runs of consecutive ids sharing one content.
  const picked: Entry[] = [];
  for (const e of sourceEntries) {
    let i = lowerBound(wanted, e.tileId);
    const end = e.tileId + e.runLength;
    while (i < wanted.length && (wanted[i] ?? Infinity) < end) {
      const start = wanted[i] ?? 0;
      let run = 1;
      while (i + run < wanted.length && wanted[i + run] === start + run && start + run < end) run++;
      picked.push({ tileId: start, offset: e.offset, length: e.length, runLength: run });
      i += run;
    }
  }

  // Distinct contents in source order; adjacent ones form one copy run.
  const contents = new Map<number, number>();
  for (const e of picked) contents.set(e.offset, e.length);
  const offsets = [...contents.keys()].sort((a, b) => a - b);
  const outOffset = new Map<number, number>();
  const runs: [number, number][] = [];
  let dataBytes = 0;
  for (const off of offsets) {
    const len = contents.get(off) ?? 0;
    outOffset.set(off, dataBytes);
    dataBytes += len;
    const last = runs.at(-1);
    const abs = header.dataOffset + off;
    if (last && last[0] + last[1] === abs) last[1] += len;
    else runs.push([abs, len]);
  }

  // Output entries; neighbouring ids with the same content merge into one run.
  const out: Entry[] = [];
  for (const e of picked) {
    const offset = outOffset.get(e.offset) ?? 0;
    const prev = out.at(-1);
    if (prev?.offset === offset && prev.tileId + prev.runLength === e.tileId) {
      prev.runLength += e.runLength;
    } else out.push({ tileId: e.tileId, offset, length: e.length, runLength: e.runLength });
  }

  const { root, leaves } = buildDirectories(out, header.internalCompression, o.rootLimit);
  const metadata =
    header.metadataLength > 0
      ? await src.read(header.metadataOffset, header.metadataLength, o.signal)
      : Buffer.alloc(0);
  const rootOffset = HEADER_LEN;
  const metadataOffset = rootOffset + root.length;
  const leafOffset = metadataOffset + metadata.length;
  const dataOffset = leafOffset + leaves.length;
  const minZoom = header.minZoom;
  const outHeader: FullHeader = {
    rootOffset,
    rootLength: root.length,
    metadataOffset,
    metadataLength: metadata.length,
    leafOffset,
    leafLength: leaves.length,
    dataOffset,
    dataLength: dataBytes,
    addressedTiles: out.reduce((n, e) => n + e.runLength, 0),
    tileEntries: out.length,
    tileContents: offsets.length,
    clustered: header.clustered,
    internalCompression: header.internalCompression,
    tileCompression: header.tileCompression,
    tileType: header.tileType,
    minZoom,
    maxZoom,
    bounds: bbox,
    centerZoom: Math.max(minZoom, Math.min(maxZoom, Math.floor((minZoom + maxZoom) / 2))),
    center: [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2],
  };
  const head = Buffer.concat([writeFullHeader(outHeader), root, metadata, leaves]);
  const identity = src.identity();
  return {
    head,
    plan: {
      schema: EXTRACT_SCHEMA,
      source: src.name,
      ...(identity !== undefined ? { identity } : {}),
      bbox,
      maxZoom,
      headBytes: head.length,
      headSha256: createHash('sha256').update(head).digest('hex'),
      dataBytes,
      totalBytes: head.length + dataBytes,
      tiles: outHeader.addressedTiles,
      contents: offsets.length,
      runs,
      tileCompression: header.tileCompression,
    },
  };
}

export interface RunExtractOptions {
  source: RangeSource;
  plan: ExtractPlan;
  /** The head from `planExtract`; when absent (a resume), the partial file's head is kept. */
  head?: Buffer;
  out: string;
  signal?: AbortSignal;
  /** Tile data bytes written so far, of `plan.dataBytes`. */
  onProgress?: (done: number, total: number) => void;
  /** Network retries inside one run before giving up (default 3). */
  retries?: number;
  retryDelayMs?: number;
}

function abortError(): Error {
  const e = new Error('Cancelled');
  e.name = 'AbortError';
  return e;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

async function writeAll(fh: FileHandle, buf: Uint8Array, position: number): Promise<void> {
  let done = 0;
  while (done < buf.length) {
    const { bytesWritten } = await fh.write(buf, done, buf.length - done, position + done);
    done += bytesWritten;
  }
}

/** Output data offset where each run starts. */
function runStarts(runs: readonly [number, number][]): number[] {
  const starts: number[] = [];
  let at = 0;
  for (const [, len] of runs) {
    starts.push(at);
    at += len;
  }
  return starts;
}

/** Index of the run that holds output data byte `pos`. */
function runAt(starts: readonly number[], pos: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if ((starts[mid] ?? 0) <= pos) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

const GAP = 256 * 1024;
const MAX_REQUEST = 32 << 20;

/** Copy tile data from `done` to the end, one ranged request per group of nearby runs. */
async function copyData(
  o: RunExtractOptions,
  fh: FileHandle,
  start: number,
  report: (done: number) => void,
): Promise<number> {
  const { plan, source, signal } = o;
  const starts = runStarts(plan.runs);
  let done = start;
  while (done < plan.dataBytes) {
    if (signal?.aborted) throw abortError();
    let r = runAt(starts, done);
    const run = plan.runs[r];
    if (!run) break;
    const from = run[0] + (done - (starts[r] ?? 0));
    // Spans to copy, in source coordinates, for this request.
    const spans: [number, number][] = [[from, run[0] + run[1]]];
    let end = run[0] + run[1];
    for (r++; r < plan.runs.length; r++) {
      const next = plan.runs[r];
      if (!next || next[0] - end > GAP || next[0] + next[1] - from > MAX_REQUEST) break;
      spans.push([next[0], next[0] + next[1]]);
      end = next[0] + next[1];
    }
    let pos = from;
    let span = 0;
    for await (const chunk of source.stream(from, end - from, signal)) {
      let at = 0;
      while (at < chunk.length && span < spans.length) {
        const [s, e] = spans[span] ?? [0, 0];
        if (pos < s) {
          const skip = Math.min(s - pos, chunk.length - at);
          pos += skip;
          at += skip;
          continue;
        }
        const take = Math.min(e - pos, chunk.length - at);
        await writeAll(fh, chunk.subarray(at, at + take), plan.headBytes + done);
        done += take;
        pos += take;
        at += take;
        if (pos >= e) span++;
        report(done);
      }
    }
    if (span < spans.length) {
      throw new Error(`${source.name} ended the transfer early.`);
    }
  }
  return done;
}

/** Every tile's place in the output data, from the output directories. */
function outputContents(head: Buffer, internal: number): Map<number, number> {
  const h = readFullHeader(head);
  const contents = new Map<number, number>();
  const visit = (dir: Entry[]) => {
    for (const e of dir) {
      if (e.runLength > 0) {
        contents.set(e.offset, e.length);
        continue;
      }
      const at = h.leafOffset + e.offset;
      visit(parseDirectory(decompress(head.subarray(at, at + e.length), internal)));
    }
  };
  visit(
    parseDirectory(decompress(head.subarray(h.rootOffset, h.rootOffset + h.rootLength), internal)),
  );
  return contents;
}

/** Gzip tiles whose CRC-32 or length does not match; empty when every tile checks. */
async function badTiles(
  fh: FileHandle,
  plan: ExtractPlan,
  contents: Map<number, number>,
  signal?: AbortSignal,
): Promise<[number, number][]> {
  if (plan.tileCompression !== Compression.gzip) return [];
  const bad: [number, number][] = [];
  const sorted = [...contents.entries()].sort((a, b) => a[0] - b[0]);
  const BLOCK = 8 << 20;
  for (let i = 0; i < sorted.length;) {
    if (signal?.aborted) throw abortError();
    const [first] = sorted[i] ?? [0];
    let j = i;
    let end = first;
    while (j < sorted.length) {
      const [off, len] = sorted[j] ?? [0, 0];
      if (off + len - first > BLOCK && j > i) break;
      end = Math.max(end, off + len);
      j++;
    }
    const buf = Buffer.alloc(end - first);
    await fh.read(buf, 0, buf.length, plan.headBytes + first);
    for (let k = i; k < j; k++) {
      const [off, len] = sorted[k] ?? [0, 0];
      try {
        gunzipSync(buf.subarray(off - first, off - first + len));
      } catch {
        bad.push([off, len]);
      }
    }
    i = j;
  }
  return bad;
}

/** Source byte offset of output data byte `pos`. */
function sourceOf(plan: ExtractPlan, starts: readonly number[], pos: number): number {
  const r = runAt(starts, pos);
  return (plan.runs[r]?.[0] ?? 0) + (pos - (starts[r] ?? 0));
}

/**
 * Copy the tile data of `plan` into `out`, continuing from the partial file when it holds the
 * same head. Network errors are retried from the byte reached; when the run fails anyway the
 * partial file stays for a later resume. At the end the file size must match the plan, and
 * gzip tiles are checked against their CRC-32 (bad ones are fetched again once).
 */
export async function runExtract(o: RunExtractOptions): Promise<void> {
  const { plan, signal } = o;
  let fh: FileHandle;
  try {
    fh = await open(o.out, 'r+');
  } catch {
    fh = await open(o.out, 'w+');
  }
  try {
    let size = (await fh.stat()).size;
    let head = o.head;
    if (head === undefined && size >= plan.headBytes) {
      const existing = Buffer.alloc(plan.headBytes);
      await fh.read(existing, 0, plan.headBytes, 0);
      if (createHash('sha256').update(existing).digest('hex') === plan.headSha256) head = existing;
    }
    if (head === undefined)
      throw new StartOverError('The partial map pack does not match its plan.');
    if (o.head !== undefined || size < plan.headBytes || size > plan.totalBytes) {
      await fh.truncate(0);
      await writeAll(fh, head, 0);
      size = plan.headBytes;
    }
    let done = size - plan.headBytes;
    let last = -1;
    const report = (d: number) => {
      if (d === last) return;
      last = d;
      o.onProgress?.(d, plan.dataBytes);
    };
    report(done);
    const retries = o.retries ?? 3;
    for (let attempt = 0; ; attempt++) {
      try {
        done = await copyData(o, fh, done, (d) => {
          done = d;
          report(d);
        });
        break;
      } catch (e) {
        if (signal?.aborted || (e instanceof Error && e.name === 'AbortError')) throw abortError();
        if (e instanceof StartOverError || attempt >= retries) throw e;
        await sleep((o.retryDelayMs ?? 1000) * 2 ** attempt, signal);
      }
    }
    await fh.sync();
    const contents = outputContents(head, readFullHeader(head).internalCompression);
    let bad = await badTiles(fh, plan, contents, signal);
    if (bad.length > 0) {
      const starts = runStarts(plan.runs);
      for (const [off, len] of bad) {
        const bytes = await o.source.read(sourceOf(plan, starts, off), len, signal);
        await writeAll(fh, bytes, plan.headBytes + off);
      }
      bad = await badTiles(fh, plan, new Map(bad), signal);
      if (bad.length > 0) {
        throw new Error(
          `${String(bad.length)} map tiles from ${o.source.name} failed their checksum. Try the download again later.`,
        );
      }
    }
    const final = (await fh.stat()).size;
    if (final !== plan.totalBytes) {
      throw new Error(
        `The map pack has ${String(final)} bytes; the plan says ${String(plan.totalBytes)}.`,
      );
    }
  } finally {
    await fh.close();
  }
}

/** A local `.pmtiles` file as a range source (map packs embedded in packages). */
export function fileSource(path: string): RangeSource {
  let id: string | undefined;
  const ensure = async () => {
    if (id === undefined) {
      const s = await stat(path);
      id = `${String(s.size)}:${String(Math.floor(s.mtimeMs))}`;
    }
  };
  return {
    name: path,
    identity: () => id,
    async read(offset, length) {
      await ensure();
      const fh = await open(path, 'r');
      try {
        const buf = Buffer.alloc(length);
        let got = 0;
        while (got < length) {
          const { bytesRead } = await fh.read(buf, got, length - got, offset + got);
          if (bytesRead === 0) break;
          got += bytesRead;
        }
        return buf.subarray(0, got);
      } finally {
        await fh.close();
      }
    },
    async *stream(offset, length, signal) {
      await ensure();
      if (length <= 0) return;
      const s = createReadStream(path, {
        start: offset,
        end: offset + length - 1,
        highWaterMark: 1 << 20,
        ...(signal ? { signal } : {}),
      });
      try {
        for await (const chunk of s) yield chunk as Buffer;
      } finally {
        s.destroy();
      }
    },
  };
}

export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<Response>;

/** `bytes a-b/total` of a 206 response. */
function contentRange(res: Response): { start: number; end: number; total: number } | null {
  const m = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(res.headers.get('content-range') ?? '');
  if (!m) return null;
  return { start: Number(m[1]), end: Number(m[2]), total: m[3] === '*' ? NaN : Number(m[3]) };
}

/**
 * A PMTiles archive on an HTTP server that honours Range (Protomaps builds, a mirror). Every
 * request after the first carries `If-Range` with the ETag (or the total size is compared), so a
 * source that changed between sessions is noticed instead of mixing two builds.
 */
export function httpSource(url: string, fetchFn: FetchLike, identity?: string): RangeSource {
  let known = identity;
  async function request(offset: number, length: number, signal?: AbortSignal) {
    const headers: Record<string, string> = {
      Range: `bytes=${String(offset)}-${String(offset + length - 1)}`,
    };
    if (known?.startsWith('etag:')) headers['If-Range'] = known.slice(5);
    const res = await fetchFn(url, { headers, ...(signal ? { signal } : {}) });
    if (res.status === 404) throw new Error(`${url} was not found on the server (HTTP 404).`);
    if (res.status === 200 && known !== undefined) {
      await res.body?.cancel();
      throw new StartOverError(`${url} changed on the server since the download started.`);
    }
    if (res.status !== 206) {
      await res.body?.cancel();
      throw new Error(`${url} did not answer a range request (HTTP ${String(res.status)}).`);
    }
    const range = contentRange(res);
    // A range past the end of the file comes back cut at the last byte.
    const end = offset + length - 1;
    if (
      range?.start !== offset ||
      (range.end !== end && !(range.end < end && range.end === range.total - 1))
    ) {
      await res.body?.cancel();
      throw new Error(`${url} sent the wrong part of the file.`);
    }
    const etag = res.headers.get('etag');
    const seen = etag && !etag.startsWith('W/') ? `etag:${etag}` : `size:${String(range.total)}`;
    if (known === undefined) known = seen;
    else if (known !== seen) {
      await res.body?.cancel();
      throw new StartOverError(`${url} changed on the server since the download started.`);
    }
    return res;
  }
  return {
    name: url,
    identity: () => known,
    async read(offset, length, signal) {
      const res = await request(offset, length, signal);
      const expected = (contentRange(res)?.end ?? offset + length - 1) - offset + 1;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length !== expected) throw new Error(`${url} ended the transfer early.`);
      return buf;
    },
    async *stream(offset, length, signal) {
      if (length <= 0) return;
      const res = await request(offset, length, signal);
      const body = res.body;
      if (!body) throw new Error(`${url} sent no data.`);
      const reader = body.getReader();
      let got = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          got += value.length;
          yield value;
        }
      } finally {
        reader.releaseLock();
        if (got < length) await body.cancel().catch(() => undefined);
      }
      if (got < length) throw new Error(`${url} ended the transfer early.`);
    },
  };
}
