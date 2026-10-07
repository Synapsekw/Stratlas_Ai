/**
 * Fetching blobs (M9 T6): where they come from (any `SyncTransport`: hub folder, exchange bundle,
 * team server), the per-layer fetch policy, and the transfer itself: resumable from the byte
 * offset of a partial download, verified by hash on arrival, a mismatch moved to quarantine and
 * fetched again.
 */
import { LARGE_BLOB_BYTES, blobPath, type ByteRange, type FetchPolicy } from '@aio/schema';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { SyncTransport } from '../transport';
import { CancelledError, hashFile, pace, throwIfCancelled } from './hash';
import type { BlobStore } from './store';

// ---------------------------------------------------------------------------------- policies

/** Layer kinds whose files are small and always useful (posters, small rasters, vectors). */
const ALWAYS_KINDS = new Set(['raster', 'vector', 'basemap']);
/** Layer kinds a person opens to review (photo review copies). */
const ON_OPEN_KINDS = new Set(['photos', 'panoramas']);

/** The default fetch policy of a layer's files on this machine (a person can change it). */
export function defaultFetchPolicy(layerKind: string, bytes: number): FetchPolicy {
  if (bytes > LARGE_BLOB_BYTES) return 'on-demand';
  if (ALWAYS_KINDS.has(layerKind)) return 'always';
  if (ON_OPEN_KINDS.has(layerKind)) return 'on-open';
  return bytes > LARGE_BLOB_BYTES / 4 ? 'on-demand' : 'always';
}

/** The policy in force: the person's choice for this layer, else the default. */
export function policyFor(
  layer: { id: string; kind: string },
  bytes: number,
  chosen: Readonly<Record<string, FetchPolicy>> = {},
): FetchPolicy {
  return chosen[layer.id] ?? defaultFetchPolicy(layer.kind, bytes);
}

/**
 * Whether a policy copies a layer's files without a click: `always` on open and on every sync,
 * `on-open` when the project opens. `on-demand` waits for Download; `stream` never copies.
 */
export function fetchesWithoutClick(policy: FetchPolicy, moment: 'open' | 'sync'): boolean {
  return policy === 'always' || (policy === 'on-open' && moment === 'open');
}

// ----------------------------------------------------------------------------------- sources

/** Where blobs come from: the blob half of a `SyncTransport`, with a name for messages. */
export type BlobSource = Pick<SyncTransport, 'hasBlobs' | 'getBlob'> & { readonly label: string };

export function transportSource(t: SyncTransport, label: string = t.kind): BlobSource {
  return { label, hasBlobs: (s) => t.hasBlobs(s), getBlob: (s, r) => t.getBlob(s, r) };
}

/**
 * A folder laid out `blobs/<aa>/<sha256>`: a hub's `projects/<team>/blobs`, or an unpacked
 * bundle. `dir` is the folder that holds the `<aa>` folders.
 */
export function folderBlobSource(dir: string, label = 'shared folder'): BlobSource {
  const file = (sha: string) => join(dir, blobPath(sha).slice('blobs/'.length));
  const exists = async (sha: string) => {
    try {
      return (await stat(file(sha))).isFile();
    } catch {
      return false;
    }
  };
  return {
    label,
    async hasBlobs(shas) {
      const out = new Set<string>();
      for (const s of shas) if (await exists(s)) out.add(s);
      return out;
    },
    async getBlob(sha, range?: ByteRange) {
      if (!(await exists(sha))) return null;
      if (range && range.end <= range.start) return emptyStream();
      return createReadStream(file(sha), {
        highWaterMark: 1024 * 1024,
        ...(range ? { start: range.start, end: range.end - 1 } : {}),
      });
    },
  };
}

async function* emptyStream(): AsyncIterable<Uint8Array> {
  // nothing to send
}

/** The file a folder source reads a blob from (LAN streaming through `aio://`, no copy). */
export function folderBlobFile(dir: string, sha256: string): string {
  return join(dir, blobPath(sha256).slice('blobs/'.length));
}

// ---------------------------------------------------------------------------------- transfer

export interface BlobWant {
  sha256: string;
  size: number;
}

export class BlobFetchError extends Error {
  constructor(
    message: string,
    readonly code: 'not-found' | 'integrity' | 'io',
  ) {
    super(message);
    this.name = 'BlobFetchError';
  }
}

export interface FetchOptions {
  signal?: AbortSignal;
  /** Bytes of this blob on this computer so far (partial included). */
  onBytes?: (done: number) => void;
  /** Cap on the transfer rate, bytes per second. */
  maxBytesPerSecond?: number;
  /** Tries per source when the bytes fail their hash; 2 by default. */
  attempts?: number;
}

export interface FetchOutcome {
  /** `present`: it was already here and unchanged; `fetched`: copied now. */
  status: 'present' | 'fetched';
  source?: string;
  /** Byte offset the transfer continued from (0 for a fresh one). */
  resumedFrom: number;
  /** Files moved to quarantine on the way (a damaged copy, a bad download). */
  quarantined: string[];
}

/**
 * Bring one blob into the store: nothing to do when it is present and unchanged; a copy changed
 * since it was verified is hashed again and quarantined when wrong. Then each source that has it
 * is tried in turn, continuing a partial download from its byte offset; the bytes are hashed on
 * arrival and a mismatch goes to quarantine and is fetched again from the start.
 */
export async function fetchBlob(
  want: BlobWant,
  sources: readonly BlobSource[],
  store: BlobStore,
  o: FetchOptions = {},
): Promise<FetchOutcome> {
  const quarantined: string[] = [];
  const { sha256, size } = want;
  throwIfCancelled(o.signal);

  const check = await store.check(sha256, size);
  if (check === 'ok') {
    o.onBytes?.(size);
    await store.touch(sha256);
    return { status: 'present', resumedFrom: 0, quarantined };
  }
  if (check === 'damaged') {
    const again = await hashFile(store.path(sha256), o.signal ? { signal: o.signal } : {}).catch(
      (e: unknown) => {
        if (e instanceof CancelledError) throw e;
        return null;
      },
    );
    if (again?.sha256 === sha256 && again.size === size) {
      await store.markVerified(sha256);
      o.onBytes?.(size);
      return { status: 'present', resumedFrom: 0, quarantined };
    }
    quarantined.push(await store.quarantine(sha256, store.path(sha256)));
  }

  let lastError: BlobFetchError | null = null;
  for (const source of sources) {
    let has: boolean;
    try {
      has = (await source.hasBlobs([sha256])).has(sha256);
    } catch {
      has = false;
    }
    if (!has) continue;
    for (let attempt = 0; attempt < (o.attempts ?? 2); attempt++) {
      throwIfCancelled(o.signal);
      try {
        const resumedFrom = await transfer(want, source, store, o);
        return { status: 'fetched', source: source.label, resumedFrom, quarantined };
      } catch (e) {
        if (e instanceof CancelledError || o.signal?.aborted) throw new CancelledError();
        if (e instanceof BlobFetchError && e.code === 'integrity') {
          quarantined.push(await store.quarantine(sha256, store.partPath(sha256)));
          lastError = e;
          continue;
        }
        lastError =
          e instanceof BlobFetchError
            ? e
            : new BlobFetchError(
                `Reading from the ${source.label} failed: ${e instanceof Error ? e.message : String(e)}`,
                'io',
              );
        break;
      }
    }
  }
  throw (
    lastError ??
    new BlobFetchError('No shared folder, bundle or server has this file.', 'not-found')
  );
}

/** One transfer into the partial file; returns the offset it continued from. */
async function transfer(
  want: BlobWant,
  source: BlobSource,
  store: BlobStore,
  o: FetchOptions,
): Promise<number> {
  const { sha256, size } = want;
  const part = store.partPath(sha256);
  await mkdir(dirname(part), { recursive: true });
  let offset = await store.partialBytes(sha256);
  if (offset > size) {
    throw new BlobFetchError('The partial download is larger than the file.', 'integrity');
  }

  // Hash what is already here, then continue the same hash with the new bytes.
  const hash = createHash('sha256');
  if (offset > 0) {
    for await (const chunk of createReadStream(part, { end: offset - 1 }))
      hash.update(chunk as Buffer);
  }
  o.onBytes?.(offset);

  const resumedFrom = offset;
  if (offset < size) {
    const body = await source.getBlob(
      sha256,
      offset > 0 ? { start: offset, end: size } : undefined,
    );
    if (!body)
      throw new BlobFetchError(`The ${source.label} no longer has this file.`, 'not-found');
    const fh = await open(part, offset > 0 ? 'a' : 'w');
    const started = Date.now();
    let moved = 0;
    try {
      for await (const chunk of body) {
        throwIfCancelled(o.signal);
        if (offset + chunk.byteLength > size)
          throw new BlobFetchError('The file is larger than registered.', 'integrity');
        await fh.write(chunk);
        hash.update(chunk);
        offset += chunk.byteLength;
        moved += chunk.byteLength;
        o.onBytes?.(offset);
        await pace(moved, started, o.maxBytesPerSecond, o.signal);
      }
      await fh.sync();
    } finally {
      await fh.close();
    }
  }
  if (offset !== size) {
    throw new BlobFetchError(`The ${source.label} sent a shorter file than registered.`, 'io');
  }
  if (hash.digest('hex') !== sha256) {
    throw new BlobFetchError('The copy does not match its fingerprint.', 'integrity');
  }
  await store.commit(sha256, size);
  return resumedFrom;
}

// ------------------------------------------------------------------------------------- queue

export interface FetchJobProgress {
  done: number;
  total: number;
}

export interface FetchJobResult {
  state: 'done' | 'failed' | 'cancelled';
  fetched: number;
  present: number;
  error?: string;
}

export interface FetchQueue {
  /** Fetch these blobs one after the other; progress in bytes over the whole job. */
  run(
    jobId: string,
    wants: readonly BlobWant[],
    sources: readonly BlobSource[],
    onProgress?: (p: FetchJobProgress) => void,
  ): Promise<FetchJobResult>;
  /** Stop a job; its partial download stays for resume. */
  cancel(jobId: string): boolean;
  running(): string[];
}

export function createFetchQueue(
  store: BlobStore,
  o: { maxBytesPerSecond?: number } = {},
): FetchQueue {
  const jobs = new Map<string, AbortController>();
  /** One transfer per hash at a time: a second job for the same blob waits for the first. */
  const inflight = new Map<string, Promise<unknown>>();

  async function once(
    want: BlobWant,
    sources: readonly BlobSource[],
    signal: AbortSignal,
    onBytes: (n: number) => void,
  ): Promise<FetchOutcome> {
    for (;;) {
      const busy = inflight.get(want.sha256);
      if (!busy) break;
      await busy.catch(() => undefined);
      throwIfCancelled(signal);
    }
    const p = fetchBlob(want, sources, store, {
      signal,
      onBytes,
      ...(o.maxBytesPerSecond ? { maxBytesPerSecond: o.maxBytesPerSecond } : {}),
    });
    inflight.set(want.sha256, p);
    try {
      return await p;
    } finally {
      inflight.delete(want.sha256);
    }
  }

  return {
    async run(jobId, wants, sources, onProgress) {
      if (jobs.has(jobId)) return { state: 'failed', fetched: 0, present: 0, error: 'Busy.' };
      const ac = new AbortController();
      jobs.set(jobId, ac);
      const unique = [...new Map(wants.map((w) => [w.sha256, w])).values()];
      const total = unique.reduce((n, w) => n + w.size, 0);
      let before = 0;
      let fetched = 0;
      let present = 0;
      const report = (n: number) => onProgress?.({ done: before + n, total });
      try {
        for (const want of unique) {
          const out = await once(want, sources, ac.signal, report);
          if (out.status === 'fetched') fetched++;
          else present++;
          before += want.size;
          report(0);
        }
        return { state: 'done', fetched, present };
      } catch (e) {
        if (e instanceof CancelledError || ac.signal.aborted)
          return { state: 'cancelled', fetched, present };
        return {
          state: 'failed',
          fetched,
          present,
          error: e instanceof Error ? e.message : String(e),
        };
      } finally {
        jobs.delete(jobId);
      }
    },
    cancel(jobId) {
      const ac = jobs.get(jobId);
      if (!ac) return false;
      ac.abort();
      return true;
    },
    running: () => [...jobs.keys()],
  };
}
