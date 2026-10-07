/**
 * The local blob cache (userData `blobs/`, M9 T6): downloaded copies for working copies whose
 * binaries live on a hub or a server. One file per hash, so equal files of several layers or
 * projects are stored once. Nothing here deletes on its own: space is freed only when the person
 * asks, and only blobs that are also held elsewhere (hub or server) can go.
 *
 * Layout: `<dir>/<aa>/<sha256>` (as `blobPath` without the `blobs/` prefix), partial downloads in
 * `<dir>/partial/<sha256>.part` (kept for resume), files that failed their hash in
 * `<dir>/quarantine/<sha256>.<time>` and the verified stamps in `<dir>/verified.json`.
 */
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** `ok`: present and unchanged since verified; `damaged`: changed since (hash it again). */
export type StoreCheck = 'ok' | 'damaged' | 'absent';

export interface StoreEntry {
  sha256: string;
  size: number;
  /** Last use (download or read through `aio://`), for "oldest first". */
  usedMs: number;
}

export interface FreeSpaceRequest {
  /** Hashes still needed by an open project: never removed. */
  keep: ReadonlySet<string>;
  /** Which of these the hub or server holds; anything else is the only copy and stays. */
  elsewhere: (sha256s: readonly string[]) => Promise<Set<string>>;
  /** Stop once the cache is at or below this size; absent frees all it may. */
  targetBytes?: number;
}

export interface FreeSpaceResult {
  removed: string[];
  freed: number;
  /** Blobs that stay because nothing else holds them or a project needs them. */
  kept: number;
}

export interface BlobStore {
  readonly dir: string;
  path(sha256: string): string;
  partPath(sha256: string): string;
  check(sha256: string, size: number): Promise<StoreCheck>;
  /** Bytes of a partial download kept for resume (0 when none). */
  partialBytes(sha256: string): Promise<number>;
  /** Move a complete, verified partial into place. */
  commit(sha256: string, size: number): Promise<void>;
  /** Record the file as verified now (after hashing it again). */
  markVerified(sha256: string): Promise<void>;
  /** Move a file that failed its hash out of the way; returns its new path. */
  quarantine(sha256: string, file: string): Promise<string>;
  touch(sha256: string): Promise<void>;
  list(): Promise<StoreEntry[]>;
  /** Bytes held: blobs and partial downloads. */
  usage(): Promise<number>;
  freeSpace(req: FreeSpaceRequest): Promise<FreeSpaceResult>;
}

interface Verified {
  size: number;
  mtimeMs: number;
  usedMs: number;
}

const HEX = /^[a-f0-9]{64}$/;

export function createBlobStore(dir: string): BlobStore {
  const stampsFile = join(dir, 'verified.json');
  let stamps: Map<string, Verified> | null = null;
  let writing: Promise<void> = Promise.resolve();

  const path = (sha: string) => {
    if (!HEX.test(sha)) throw new Error('Not a SHA-256.');
    return join(dir, sha.slice(0, 2), sha);
  };
  const partPath = (sha: string) => {
    if (!HEX.test(sha)) throw new Error('Not a SHA-256.');
    return join(dir, 'partial', `${sha}.part`);
  };

  async function load(): Promise<Map<string, Verified>> {
    if (stamps) return stamps;
    const next = new Map<string, Verified>();
    try {
      const raw = JSON.parse(await readFile(stampsFile, 'utf8')) as Record<string, Verified>;
      for (const [k, v] of Object.entries(raw)) {
        if (HEX.test(k) && typeof v.size === 'number' && typeof v.mtimeMs === 'number')
          next.set(k, { size: v.size, mtimeMs: v.mtimeMs, usedMs: v.usedMs || v.mtimeMs });
      }
    } catch {
      // first use, or an unreadable file: stamps are rebuilt by hashing again
    }
    stamps = next;
    return next;
  }

  function save(): Promise<void> {
    // one write at a time; a failed write never blocks the next one
    writing = writing
      .catch(() => undefined)
      .then(async () => {
        const map = await load();
        await mkdir(dir, { recursive: true });
        const tmp = `${stampsFile}.tmp`;
        await writeFile(tmp, JSON.stringify(Object.fromEntries(map)));
        await rename(tmp, stampsFile);
      });
    return writing;
  }

  async function size(file: string): Promise<{ size: number; mtimeMs: number } | null> {
    try {
      const s = await stat(file);
      return s.isFile() ? { size: s.size, mtimeMs: Math.round(s.mtimeMs) } : null;
    } catch {
      return null;
    }
  }

  async function verifiedNow(sha: string): Promise<void> {
    const s = await size(path(sha));
    if (!s) return;
    const map = await load();
    map.set(sha, { ...s, usedMs: Date.now() });
    await save();
  }

  async function list(): Promise<StoreEntry[]> {
    const map = await load();
    const out: StoreEntry[] = [];
    let tops: string[];
    try {
      tops = await readdir(dir);
    } catch {
      return [];
    }
    for (const top of tops.filter((t) => /^[a-f0-9]{2}$/.test(t))) {
      for (const name of await readdir(join(dir, top)).catch(() => [] as string[])) {
        if (!HEX.test(name) || !name.startsWith(top)) continue;
        const s = await size(join(dir, top, name));
        if (s) out.push({ sha256: name, size: s.size, usedMs: map.get(name)?.usedMs ?? s.mtimeMs });
      }
    }
    return out;
  }

  return {
    dir,
    path,
    partPath,

    async check(sha, expected) {
      const s = await size(path(sha));
      if (!s) return 'absent';
      if (s.size !== expected) return 'damaged';
      const v = (await load()).get(sha);
      return v?.size === s.size && v.mtimeMs === s.mtimeMs ? 'ok' : 'damaged';
    },

    async partialBytes(sha) {
      return (await size(partPath(sha)))?.size ?? 0;
    },

    async commit(sha, expected) {
      const part = partPath(sha);
      const s = await size(part);
      if (s?.size !== expected) throw new Error('The download is not complete.');
      const dest = path(sha);
      await mkdir(dirname(dest), { recursive: true });
      await rename(part, dest);
      await verifiedNow(sha);
    },

    markVerified: verifiedNow,

    async quarantine(sha, file) {
      const q = join(dir, 'quarantine');
      await mkdir(q, { recursive: true });
      const dest = join(q, `${sha}.${String(Date.now())}`);
      await rename(file, dest);
      const map = await load();
      if (file === path(sha) && map.delete(sha)) await save();
      return dest;
    },

    async touch(sha) {
      const map = await load();
      const v = map.get(sha);
      // reads through aio:// come in many ranges: one write a minute is enough for "oldest first"
      if (!v || Date.now() - v.usedMs < 60_000) return;
      v.usedMs = Date.now();
      await save();
    },

    list,

    async usage() {
      let bytes = 0;
      for (const e of await list()) bytes += e.size;
      for (const name of await readdir(join(dir, 'partial')).catch(() => [] as string[]))
        bytes += (await size(join(dir, 'partial', name)))?.size ?? 0;
      return bytes;
    },

    async freeSpace({ keep, elsewhere, targetBytes }) {
      const entries = (await list()).sort((a, b) => a.usedMs - b.usedMs);
      const candidates = entries.filter((e) => !keep.has(e.sha256));
      const held = candidates.length ? await elsewhere(candidates.map((e) => e.sha256)) : new Set();
      let total = entries.reduce((n, e) => n + e.size, 0);
      const removed: string[] = [];
      let freed = 0;
      const map = await load();
      for (const e of candidates) {
        if (targetBytes !== undefined && total <= targetBytes) break;
        if (!held.has(e.sha256)) continue;
        await rm(path(e.sha256), { force: true });
        map.delete(e.sha256);
        removed.push(e.sha256);
        freed += e.size;
        total -= e.size;
      }
      if (removed.length) await save();
      return { removed, freed, kept: entries.length - removed.length };
    },
  };
}
