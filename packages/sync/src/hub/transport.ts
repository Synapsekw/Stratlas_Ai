import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { readSegment } from '@aio/journal';
import {
  HUB_FILE,
  HUB_PATHS,
  HUB_SCHEMA,
  HubFile,
  Op,
  Presence,
  TEAM_FILE,
  TeamProject,
  opChunkName,
  type BlobRef,
  type ByteRange,
  type DeviceRecord,
  type Heads,
  type PullPage,
  type PushResult,
} from '@aio/schema';
import { chainRuns } from '../exchange/ingest';
import type { SyncTransport } from '../transport';
import { HubUnreachable, nodeHubFs, withTimeouts, type HubFs } from './fs';
import { presenceFresh } from './presence';

/**
 * A hub folder (a share on a NAS or server, or a synced cloud folder) as a transport.
 *
 * Each device writes only its own files, and op chunks and blobs never change once written: a
 * chunk `ops/<chain>/<from>-<to>.jsonl` or a blob `blobs/<aa>/<sha256>` is written under a temp
 * name and renamed into place. So no lock is needed, a share that drops mid-write leaves only a
 * temp file nobody reads, and cloud-drive clients never see two writers of one file. Copies they
 * make anyway ("conflicted copy", "(1)") are read like chunks, deduped by op id, and reported.
 */

const CHUNK_RE = /^(\d{6,})-(\d{6,})\.jsonl$/;
const TEMP_RE = /^\..*\.tmp$|\.partial$/;
/** Ops per chunk file, so a long offline session still writes files of a sensible size. */
const MAX_CHUNK_OPS = 2000;

export interface HubOptions {
  /** The hub folder (holds `aio-hub.json`). */
  root: string;
  /** The team project synced through it. */
  team: string;
  /** This device (presence and temp names). */
  device: string;
  fs?: HubFs;
  /** Per file call; a slower share counts as not reachable (default 20 s). */
  timeoutMs?: number;
  now?: () => number;
}

export interface HubPull extends PullPage {
  /** Cloud-drive copies of chunk files that were read (relative to the hub). */
  conflictCopies: string[];
  /** Lines or files that could not be read (relative path and why). */
  problems: string[];
}

export interface HubTransport extends SyncTransport {
  readonly kind: 'hub';
  readonly root: string;
  /** Is the folder there and a hub? Throws `HubUnreachable` when the share cannot be reached. */
  check(): Promise<HubFile | null>;
  /** Make the folder a hub if it is not one, and list the team project in it. */
  ensure(team: TeamProject, now?: Date): Promise<HubFile>;
  /** Team projects in this hub (from `aio-hub.json` and the project folders). */
  projects(): Promise<TeamProject[]>;
  pull(since: Heads): Promise<HubPull>;
  putDevice(record: DeviceRecord): Promise<void>;
  devices(): Promise<Record<string, unknown>[]>;
  putPresence(p: Presence): Promise<void>;
  presence(): Promise<Presence[]>;
  /** Remove this device's temp files left by an interrupted write (older than an hour). */
  sweep(): Promise<number>;
}

export function createHubTransport(o: HubOptions): HubTransport {
  const fs = withTimeouts(o.fs ?? nodeHubFs, o.timeoutMs ?? 20_000);
  const now = o.now ?? Date.now;
  const at = (rel: string) => join(o.root, ...rel.split('/'));
  const opsDir = (chain: string) => at(HUB_PATHS.ops(o.team, chain));
  const blobFile = (sha: string) => at(`${HUB_PATHS.blobs(o.team)}/${sha.slice(0, 2)}/${sha}`);
  /** Chunk files never change: parsed once per session. */
  const chunkCache = new Map<string, { ops: Op[]; problems: string[] }>();

  const tempName = (dir: string, name: string) =>
    join(dir, `.${name}.${o.device.slice(0, 12)}.${randomBytes(4).toString('hex')}.tmp`);

  /** Write a file that never changes: temp name, then rename; an existing one is left alone. */
  async function writeOnce(file: string, data: Uint8Array | string): Promise<boolean> {
    if (await fs.stat(file)) return false;
    const dir = file.slice(0, Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\')));
    await fs.mkdir(dir);
    const tmp = tempName(dir, file.slice(dir.length + 1));
    await fs.writeFile(tmp, data);
    try {
      if (await fs.stat(file)) return false;
      await fs.rename(tmp, file);
      return true;
    } finally {
      await fs.rm(tmp).catch(() => undefined);
    }
  }

  /** Replace a file only this device writes (presence, its device record). */
  async function writeOwn(file: string, data: string): Promise<void> {
    const dir = file.slice(0, Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\')));
    await fs.mkdir(dir);
    const tmp = tempName(dir, file.slice(dir.length + 1));
    await fs.writeFile(tmp, data);
    try {
      await fs.rename(tmp, file);
    } finally {
      await fs.rm(tmp).catch(() => undefined);
    }
  }

  async function list(dir: string): Promise<string[]> {
    if (!(await fs.stat(dir))) return [];
    return fs.readdir(dir);
  }

  async function readChunk(
    chain: string,
    name: string,
  ): Promise<{ ops: Op[]; problems: string[] }> {
    const key = `${chain}/${name}`;
    const cached = chunkCache.get(key);
    if (cached) return cached;
    const rel = `${HUB_PATHS.ops(o.team, chain)}/${name}`;
    const text = (await fs.readFile(join(opsDir(chain), name))).toString('utf8');
    const ops: Op[] = [];
    const problems: string[] = [];
    for (const line of readSegment(text)) {
      if (!line.ok) {
        problems.push(`${rel} line ${line.line}: ${line.error}`);
        continue;
      }
      const op = Op.safeParse(line.raw);
      if (!op.success || op.data.chain !== chain) {
        problems.push(`${rel} line ${line.line}: not a change of this chain`);
        continue;
      }
      ops.push(line.raw as Op);
    }
    const result = { ops, problems };
    // a chunk cut short by a share that went away mid-write is never renamed into place, but a
    // cloud client can still hand over a partial copy: only cache what read cleanly
    if (problems.length === 0) chunkCache.set(key, result);
    return result;
  }

  async function chains(): Promise<string[]> {
    const dir = at(`${HUB_PATHS.project(o.team)}/ops`);
    return (await list(dir)).filter((c) => /^d_[a-z2-7]{52}\.r_[a-z2-7]{16}$/.test(c)).sort();
  }

  async function chainFiles(chain: string) {
    const names = await list(opsDir(chain));
    const chunks: { name: string; from: number; to: number }[] = [];
    const copies: string[] = [];
    for (const name of names) {
      if (TEMP_RE.test(name) || name.startsWith('.')) continue;
      const m = CHUNK_RE.exec(name);
      if (m) chunks.push({ name, from: Number(m[1]), to: Number(m[2]) });
      else if (name.endsWith('.jsonl') || /\.jsonl\b/.test(name)) copies.push(name);
    }
    chunks.sort((a, b) => a.from - b.from || a.to - b.to);
    return { chunks, copies };
  }

  async function pull(since: Heads): Promise<HubPull> {
    const byId = new Map<string, Op>();
    const conflictCopies: string[] = [];
    const problems: string[] = [];
    for (const chain of await chains()) {
      const after = since[chain]?.seq ?? 0;
      const { chunks, copies } = await chainFiles(chain);
      const wanted = chunks.filter((c) => c.to > after).map((c) => c.name);
      for (const name of [...wanted, ...copies]) {
        const r = await readChunk(chain, name);
        problems.push(...r.problems);
        if (copies.includes(name)) conflictCopies.push(`${HUB_PATHS.ops(o.team, chain)}/${name}`);
        for (const op of r.ops) if (op.seq > after) byId.set(op.id, op);
      }
    }
    const ops = [...byId.values()].sort((a, b) =>
      a.chain === b.chain ? a.seq - b.seq : a.chain < b.chain ? -1 : 1,
    );
    return { ops, cursor: null, more: false, conflictCopies, problems };
  }

  async function heads(): Promise<Heads> {
    const out: Heads = {};
    for (const chain of await chains()) {
      const { chunks } = await chainFiles(chain);
      const last = chunks.at(-1);
      if (!last) continue;
      const { ops } = await readChunk(chain, last.name);
      const top = ops.reduce<Op | null>((m, op) => (!m || op.seq > m.seq ? op : m), null);
      if (top) out[chain] = { seq: top.seq, id: top.id };
    }
    return out;
  }

  return {
    kind: 'hub',
    root: o.root,

    async check() {
      const s = await fs.stat(o.root).catch((e: unknown) => {
        throw e instanceof HubUnreachable
          ? e
          : new HubUnreachable(`The shared folder cannot be reached (${String(e)}).`);
      });
      if (!s?.dir) throw new HubUnreachable(`The shared folder cannot be reached: ${o.root}`);
      const raw = await fs.readFile(at(HUB_FILE)).catch(() => null);
      if (!raw) return null;
      try {
        return HubFile.parse(JSON.parse(raw.toString('utf8')));
      } catch {
        return null;
      }
    },

    async ensure(team, when = new Date(now())) {
      const file = at(HUB_FILE);
      let hub: HubFile | null = null;
      const raw = await fs.readFile(file).catch(() => null);
      if (raw) {
        const parsed = HubFile.safeParse(JSON.parse(raw.toString('utf8')));
        if (!parsed.success) {
          throw new Error(`${HUB_FILE} in the shared folder is not valid. Choose another folder.`);
        }
        hub = parsed.data;
      }
      if (!hub) {
        hub = HubFile.parse({
          schema: HUB_SCHEMA,
          id: `h_${randomBase32(16)}`,
          createdAt: when.toISOString(),
          projects: [],
        });
        await writeOnce(file, `${JSON.stringify(hub, null, 2)}\n`);
        const again = await fs.readFile(file);
        hub = HubFile.parse(JSON.parse(again.toString('utf8')));
      }
      await writeOnce(
        at(`${HUB_PATHS.project(team.teamProjectId)}/${TEAM_FILE}`),
        `${JSON.stringify(team, null, 2)}\n`,
      );
      if (!hub.projects.some((p) => p.teamProjectId === team.teamProjectId)) {
        // the list is a convenience: two devices adding at once may drop one entry, and
        // projects() also finds every project by its folder
        hub = {
          ...hub,
          projects: [...hub.projects, { teamProjectId: team.teamProjectId, name: team.name }],
        };
        await writeOwn(file, `${JSON.stringify(hub, null, 2)}\n`);
      }
      return hub;
    },

    async projects() {
      const out = new Map<string, TeamProject>();
      for (const id of await list(at('projects'))) {
        const raw = await fs
          .readFile(at(`${HUB_PATHS.project(id)}/${TEAM_FILE}`))
          .catch(() => null);
        if (!raw) continue;
        const p = TeamProject.safeParse(JSON.parse(raw.toString('utf8')));
        if (p.success) out.set(p.data.teamProjectId, p.data);
      }
      return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
    },

    heads,
    pull,
    async pullOps(since) {
      const r = await pull(since);
      return { ops: r.ops, cursor: null, more: false };
    },

    async pushOps(ops): Promise<PushResult> {
      const result: PushResult = { accepted: [], duplicates: [], refused: [], receipts: [] };
      const hubHeads = await heads();
      for (const run of chainRuns(ops)) {
        const head = hubHeads[run.chain]?.seq ?? 0;
        const fresh = run.ops.filter((op) => op.seq > head);
        result.duplicates.push(...run.ops.filter((op) => op.seq <= head).map((op) => op.id));
        if (fresh.length === 0) continue;
        if ((fresh[0]?.seq ?? 0) !== head + 1) {
          for (const op of fresh) {
            result.refused.push({
              id: op.id,
              code: 'gap',
              message: `The hub holds this chain up to #${head}.`,
            });
          }
          continue;
        }
        for (let i = 0; i < fresh.length; i += MAX_CHUNK_OPS) {
          const part = fresh.slice(i, i + MAX_CHUNK_OPS);
          const first = part[0];
          const last = part.at(-1);
          if (!first || !last) continue;
          const name = opChunkName(first.seq, last.seq);
          const text = part.map((op) => `${JSON.stringify(op)}\n`).join('');
          await writeOnce(join(opsDir(run.chain), name), text);
          result.accepted.push(...part.map((op) => op.id));
        }
      }
      return result;
    },

    async hasBlobs(shas) {
      const have = new Set<string>();
      for (const sha of shas) if (await fs.stat(blobFile(sha))) have.add(sha);
      return have;
    },

    async putBlob(ref: BlobRef, data, offset = 0) {
      const file = blobFile(ref.sha256);
      if (await fs.stat(file)) return;
      const dir = file.slice(0, Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\')));
      await fs.mkdir(dir);
      // resumable: the part file is this device's own, named by hash
      const part = join(dir, `.${ref.sha256}.${o.device.slice(0, 12)}.partial`);
      if (offset === 0) await fs.rm(part);
      const have = (await fs.stat(part))?.size ?? 0;
      if (have !== offset) {
        throw new Error(
          `The partial copy on the hub holds ${have} bytes, not ${offset}. Start the copy again.`,
        );
      }
      await fs.writeStream(part, data, offset > 0);
      const hash = createHash('sha256');
      for await (const chunk of fs.readStream(part)) hash.update(chunk);
      const got = hash.digest('hex');
      if (got !== ref.sha256) {
        await fs.rm(part);
        throw new Error(
          'The file copied to the hub does not match its hash. It was removed; try again.',
        );
      }
      if (await fs.stat(file)) await fs.rm(part);
      else await fs.rename(part, file);
    },

    async getBlob(sha256: string, range?: ByteRange) {
      const file = blobFile(sha256);
      if (!(await fs.stat(file))) return null;
      return fs.readStream(file, range);
    },

    async putDevice(record) {
      const file = at(`${HUB_PATHS.devices(o.team)}/${record.id}.json`);
      const text = `${JSON.stringify(record, null, 2)}\n`;
      const now = await fs.readFile(file).catch(() => null);
      if (now?.toString('utf8') === text) return;
      await writeOwn(file, text);
    },

    async devices() {
      const dir = at(HUB_PATHS.devices(o.team));
      const out: Record<string, unknown>[] = [];
      for (const name of await list(dir)) {
        if (!/^d_[a-z2-7]{52}\.json$/.test(name)) continue;
        const raw = await fs.readFile(join(dir, name)).catch(() => null);
        if (!raw) continue;
        try {
          out.push(JSON.parse(raw.toString('utf8')) as Record<string, unknown>);
        } catch {
          // a half-synced cloud copy: read again next time
        }
      }
      return out;
    },

    async putPresence(p) {
      await writeOwn(at(HUB_PATHS.presence(o.team, p.device)), `${JSON.stringify(p)}\n`);
    },

    async presence() {
      const dir = at(`${HUB_PATHS.project(o.team)}/presence`);
      const out: Presence[] = [];
      for (const name of await list(dir)) {
        if (!/^d_[a-z2-7]{52}\.json$/.test(name)) continue;
        const raw = await fs.readFile(join(dir, name)).catch(() => null);
        if (!raw) continue;
        try {
          const p = Presence.safeParse(JSON.parse(raw.toString('utf8')));
          if (p.success && p.data.device !== o.device && presenceFresh(p.data, now()))
            out.push(p.data);
        } catch {
          // ignore a presence file caught mid-write by a cloud client
        }
      }
      return out.sort((a, b) => a.name.localeCompare(b.name));
    },

    async sweep() {
      let removed = 0;
      const mine = `.${o.device.slice(0, 12)}.`;
      const dirs = [
        ...(await chains()).map(opsDir),
        at(HUB_PATHS.devices(o.team)),
        at(`${HUB_PATHS.project(o.team)}/presence`),
      ];
      for (const dir of dirs) {
        for (const name of await list(dir)) {
          if (!name.endsWith('.tmp') || !name.includes(mine)) continue;
          const s = await fs.stat(join(dir, name));
          if (s && now() - s.mtimeMs > 60 * 60 * 1000) {
            await fs.rm(join(dir, name));
            removed++;
          }
        }
      }
      return removed;
    },
  };
}

function randomBase32(letters: number): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  return [...randomBytes(letters)].map((b) => alphabet.charAt(b & 31)).join('');
}

export { HubUnreachable };
