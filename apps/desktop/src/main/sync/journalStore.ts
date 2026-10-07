import { randomBytes } from 'node:crypto';
import { open, mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { readSegment } from '@aio/journal';
import {
  DeviceRecord,
  JOURNAL_DEVICES_DIR,
  JOURNAL_OPS_DIR,
  Op,
  SEGMENT_MAX_BYTES,
  SEGMENT_MAX_OPS,
  segmentFileName,
  type Heads,
} from '@aio/schema';
import { deviceRecordValid } from '@aio/sync/exchange';

/**
 * The project journal as sync sees it: every chain's ops, read from `journal/ops/<chain>/`
 * segments, and other devices' ops appended to their own chain folders on import or pull.
 *
 * Until T1 lands this is also how this copy's own ops are appended. At integration T1's journal
 * service takes over appending (one writer per file in main) and this module keeps reading.
 */
export interface JournalStore {
  /** Every op of every chain, by chain then seq (cached by segment size and time). */
  ops(root: string): Promise<Op[]>;
  heads(root: string): Promise<Heads>;
  /** The id held at a chain and seq (fork detection). */
  idAt(root: string, chain: string, seq: number): Promise<string | undefined>;
  /** Append ops that continue their chains (callers plan with `planIngest`). */
  append(root: string, ops: readonly Op[]): Promise<void>;
  devices(root: string): Promise<DeviceRecord[]>;
  /** Write device records this project does not hold yet (each checked against its key). */
  addDevices(root: string, records: readonly Record<string, unknown>[]): Promise<number>;
}

interface Cached {
  size: number;
  mtimeMs: number;
  ops: Op[];
}

const CHAIN_RE = /^d_[a-z2-7]{52}\.r_[a-z2-7]{16}$/;
const SEGMENT_RE = /^\d{6,}\.jsonl$/;

export function createJournalStore(): JournalStore {
  const cache = new Map<string, Cached>();
  const locks = new Map<string, Promise<unknown>>();
  const serial = <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const prev = locks.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    locks.set(
      key,
      run.catch(() => undefined),
    );
    return run;
  };

  async function list(dir: string): Promise<string[]> {
    try {
      return await readdir(dir);
    } catch {
      return [];
    }
  }

  async function segment(file: string): Promise<Op[]> {
    const s = await stat(file);
    const hit = cache.get(file);
    if (hit?.size === s.size && hit.mtimeMs === s.mtimeMs) return hit.ops;
    const ops: Op[] = [];
    for (const line of readSegment(await readFile(file, 'utf8'))) {
      if (!line.ok) continue;
      if (Op.safeParse(line.raw).success) ops.push(line.raw as Op);
    }
    cache.set(file, { size: s.size, mtimeMs: s.mtimeMs, ops });
    return ops;
  }

  async function chainOps(root: string, chain: string): Promise<{ ops: Op[]; segments: string[] }> {
    const dir = join(root, ...JOURNAL_OPS_DIR.split('/'), chain);
    const segments = (await list(dir)).filter((f) => SEGMENT_RE.test(f)).sort();
    const ops: Op[] = [];
    for (const f of segments) ops.push(...(await segment(join(dir, f))));
    return { ops: ops.sort((a, b) => a.seq - b.seq), segments };
  }

  async function chains(root: string): Promise<string[]> {
    return (await list(join(root, ...JOURNAL_OPS_DIR.split('/'))))
      .filter((c) => CHAIN_RE.test(c))
      .sort();
  }

  async function all(root: string): Promise<Op[]> {
    const out: Op[] = [];
    for (const chain of await chains(root)) out.push(...(await chainOps(root, chain)).ops);
    return out;
  }

  /** Replace a segment with old lines plus new ones: temp file, fsync, rename. */
  async function writeSegment(file: string, before: string, lines: string): Promise<void> {
    const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
    const fh = await open(tmp, 'w');
    try {
      await fh.writeFile(before + lines, 'utf8');
      await fh.sync();
    } finally {
      await fh.close();
    }
    try {
      await rename(tmp, file);
    } catch (e) {
      await rm(tmp, { force: true });
      throw e;
    }
  }

  return {
    ops: all,
    async heads(root) {
      const out: Heads = {};
      for (const op of await all(root)) {
        const h = out[op.chain];
        if (!h || op.seq > h.seq) out[op.chain] = { seq: op.seq, id: op.id };
      }
      return out;
    },
    async idAt(root, chain, seq) {
      return (await chainOps(root, chain)).ops.find((o) => o.seq === seq)?.id;
    },
    async append(root, ops) {
      const byChain = new Map<string, Op[]>();
      for (const op of ops) byChain.set(op.chain, [...(byChain.get(op.chain) ?? []), op]);
      for (const [chain, list] of byChain) {
        await serial(`${root}|${chain}`, async () => {
          const dir = join(root, ...JOURNAL_OPS_DIR.split('/'), chain);
          await mkdir(dir, { recursive: true });
          const { ops: have, segments } = await chainOps(root, chain);
          const head = have.at(-1);
          const sorted = [...list].sort((a, b) => a.seq - b.seq);
          if ((sorted[0]?.seq ?? 0) !== (head?.seq ?? 0) + 1) {
            throw new Error(`Journal append out of order on ${chain.slice(0, 12)}.`);
          }
          let n = segments.length === 0 ? 1 : Number(segments.at(-1)?.slice(0, -6));
          let file = join(dir, segmentFileName(n));
          let before = segments.length === 0 ? '' : await readFile(file, 'utf8');
          let count = segments.length === 0 ? 0 : (await segment(file)).length;
          let lines = '';
          for (const op of sorted) {
            const line = `${JSON.stringify(op)}\n`;
            if (
              count >= SEGMENT_MAX_OPS ||
              Buffer.byteLength(before + lines + line) > SEGMENT_MAX_BYTES
            ) {
              if (lines) await writeSegment(file, before, lines);
              n += 1;
              file = join(dir, segmentFileName(n));
              before = '';
              lines = '';
              count = 0;
            }
            lines += line;
            count += 1;
          }
          if (lines) await writeSegment(file, before, lines);
        });
      }
    },
    async devices(root) {
      const dir = join(root, ...JOURNAL_DEVICES_DIR.split('/'));
      const out: DeviceRecord[] = [];
      for (const f of await list(dir)) {
        if (!/^d_[a-z2-7]{52}\.json$/.test(f)) continue;
        try {
          const d = DeviceRecord.safeParse(JSON.parse(await readFile(join(dir, f), 'utf8')));
          if (d.success) out.push(d.data);
        } catch {
          // a device file mid-copy: read again next time
        }
      }
      return out;
    },
    async addDevices(root, records) {
      const dir = join(root, ...JOURNAL_DEVICES_DIR.split('/'));
      await mkdir(dir, { recursive: true });
      let added = 0;
      for (const raw of records) {
        if (!deviceRecordValid(raw)) continue;
        const file = join(dir, `${raw.id}.json`);
        const exists = await stat(file).then(
          () => true,
          () => false,
        );
        if (exists) continue;
        const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
        const fh = await open(tmp, 'wx');
        try {
          await fh.writeFile(`${JSON.stringify(raw, null, 2)}\n`, 'utf8');
          await fh.sync();
        } finally {
          await fh.close();
        }
        await rename(tmp, file);
        added++;
      }
      return added;
    },
  };
}
