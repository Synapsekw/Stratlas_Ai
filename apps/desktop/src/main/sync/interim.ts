/**
 * INTERIM stand-ins for T1, T2 and T4, so exchange files and hub folders work end to end before
 * those streams merge. Each is the smallest thing that keeps the data honest:
 *
 * - device (T2): an Ed25519 key in the OS vault (account `device-signing-interim`, never on disk
 *   or in a log), the person from userData `identity.json` when T2 has written it;
 * - journal (T1): issues only, by diffing `issues.json` against the last journaled copy;
 * - merge (T4): issues only, last writer by clock per field, a conflict when two copies changed a
 *   field without seeing each other, a delete never erasing a concurrent edit.
 *
 * At integration the real ports replace these (`registerSyncIpc` deps) and this file is deleted.
 */
import { createPrivateKey, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import {
  canonicalJson,
  contentHash,
  createClock,
  sealOp,
  signerFromKey,
  type Signer,
} from '@aio/journal';
import {
  DEVICE_SCHEMA,
  Identity,
  type AppStamp,
  type Conflict,
  type DeviceRecord,
  type Op,
  type RecordRef,
} from '@aio/schema';
import { readJson, writeJsonAtomic } from '../fsutil';
import type { KeyEntry } from '../keys';
import type { JournalStore } from './journalStore';
import type { DevicePort, JournalPort, Me, MergePort, ProjectCtx } from './ports';

export const INTERIM_DEVICE_ACCOUNT = 'device-signing-interim';

function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = [words[0], words.length > 1 ? words.at(-1) : undefined]
    .map((w) => /\p{L}/u.exec(w ?? '')?.[0] ?? '')
    .join('')
    .toUpperCase();
  return letters || 'ME';
}

export function interimDevice(o: {
  userData: string;
  vault: () => KeyEntry;
  app: AppStamp;
}): DevicePort {
  let key: KeyObject | null | undefined;
  let rec: DeviceRecord | null = null;
  const loadKey = (): KeyObject | null => {
    if (key !== undefined) return key;
    try {
      const entry = o.vault();
      const stored = entry.getPassword();
      if (stored) {
        key = createPrivateKey({
          key: Buffer.from(stored, 'base64'),
          format: 'der',
          type: 'pkcs8',
        });
      } else {
        const pair = generateKeyPairSync('ed25519');
        entry.setPassword(
          pair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
        );
        key = pair.privateKey;
      }
    } catch (e) {
      console.warn(`Key vault: no device key for sync (${e instanceof Error ? e.name : 'error'}).`);
      key = null;
    }
    return key;
  };
  const signer = (): Signer | null => {
    const k = loadKey();
    return k ? signerFromKey(k) : null;
  };
  const me = async (): Promise<Me> => {
    const raw = await readJson(join(o.userData, 'identity.json')).catch(() => undefined);
    const id = Identity.safeParse(raw);
    if (id.success) return { actor: id.data.actor, name: id.data.name, initials: id.data.initials };
    const s = signer();
    const name = (() => {
      try {
        return userInfo().username || 'Reviewer';
      } catch {
        return 'Reviewer';
      }
    })();
    // a stable actor per device until T2 gives the person one id across devices
    const actor = `a_${(s?.device ?? 'd_aaaaaaaaaaaaaaaaaaaaaaaaaa').slice(2, 28)}`;
    return { actor, name, initials: initialsOf(name) };
  };
  return {
    me,
    signer: () => Promise.resolve(signer()),
    async record() {
      const s = signer();
      if (!s) return null;
      const who = await me();
      if (rec?.actor === who.actor && rec.name === who.name) return rec;
      const unsigned = {
        schema: DEVICE_SCHEMA,
        id: s.device,
        alg: 'ed25519' as const,
        key: s.publicKey,
        actor: who.actor,
        name: who.name,
        initials: who.initials,
        app: o.app,
        createdAt: new Date().toISOString(),
        certs: [],
      };
      rec = { ...unsigned, sig: s.sign('aio.device/1', contentHash(unsigned)) };
      return rec;
    },
  };
}

// ---------------------------------------------------------------- journal and merge (issues)

type IssueRecord = Record<string, unknown> & { id: string };
interface IssuesFile {
  wrapped: boolean;
  head: Record<string, unknown>;
  issues: IssueRecord[];
}

async function readIssues(root: string): Promise<IssuesFile> {
  const raw: unknown = await readJson(join(root, 'issues.json')).catch(() => undefined);
  if (Array.isArray(raw)) return { wrapped: false, head: {}, issues: raw as IssueRecord[] };
  if (raw && typeof raw === 'object' && Array.isArray((raw as { issues?: unknown }).issues)) {
    const { issues, ...head } = raw as { issues: IssueRecord[] };
    return { wrapped: true, head, issues };
  }
  return { wrapped: true, head: { schema: 'aio.issues/1' }, issues: [] };
}

async function writeIssues(root: string, f: IssuesFile): Promise<void> {
  await writeJsonAtomic(
    join(root, 'issues.json'),
    f.wrapped ? { ...f.head, issues: f.issues } : f.issues,
    {
      backup: true,
    },
  );
}

interface Stamp {
  hlc: string;
  op: string;
  chain: string;
  seq: number;
  act: string;
  value: unknown;
}
type Clocks = Record<string, Record<string, Stamp>>;

const same = (a: unknown, b: unknown) => canonicalJson(a ?? null) === canonicalJson(b ?? null);

/** Shared by the interim journal and merge: one writer of this copy's chain. */
export interface InterimEngine {
  journal: JournalPort;
  merge: MergePort;
}

export function interimEngine(o: { store: JournalStore; device: DevicePort }): InterimEngine {
  const clocks = new Map<string, ReturnType<typeof createClock>>();
  const files = (ctx: ProjectCtx) => ({
    snapshot: join(ctx.cacheDir, 'interim-issues.json'),
    clocks: join(ctx.cacheDir, 'interim-clocks.json'),
    conflicts: join(ctx.cacheDir, 'interim-conflicts.json'),
  });
  const load = async <T>(file: string, fallback: T): Promise<T> =>
    ((await readJson(file).catch(() => undefined)) as T | undefined) ?? fallback;
  const save = async (file: string, data: unknown) => {
    await mkdir(join(file, '..'), { recursive: true });
    await writeJsonAtomic(file, data);
  };

  async function appendLocal(
    ctx: ProjectCtx,
    specs: { kind: string; target: RecordRef; payload: unknown }[],
  ): Promise<Op[]> {
    if (specs.length === 0) return [];
    const signer = await o.device.signer();
    const me = await o.device.me();
    const all = await o.store.ops(ctx.root);
    let clock = clocks.get(ctx.device);
    if (!clock) clocks.set(ctx.device, (clock = createClock(ctx.device)));
    const latest = all.reduce((m, op) => (op.hlc > m ? op.hlc : m), '');
    if (latest) clock.receive(latest);
    const deps: Record<string, string> = {};
    let prev: Op | null = null;
    for (const op of all) {
      if (op.chain === ctx.chain) {
        if (!prev || op.seq > prev.seq) prev = op;
      } else {
        const d = deps[op.chain];
        if (!d || (all.find((x) => x.id === d)?.seq ?? 0) < op.seq) deps[op.chain] = op.id;
      }
    }
    const out: Op[] = [];
    for (const s of specs) {
      const op = sealOp(
        {
          v: 1,
          chain: ctx.chain,
          dev: ctx.device,
          act: me.actor,
          seq: (prev?.seq ?? 0) + 1,
          hlc: clock.tick(),
          prev: prev?.id ?? null,
          ...(Object.keys(deps).length > 0 ? { deps } : {}),
          kind: s.kind,
          target: s.target,
        },
        s.payload,
        signer ?? undefined,
      );
      out.push(op);
      prev = op;
    }
    await o.store.append(ctx.root, out);
    return out;
  }

  const journal: JournalPort = {
    async flush(ctx) {
      const f = files(ctx);
      const now = await readIssues(ctx.root);
      const snapshot = await load<IssueRecord[] | null>(f.snapshot, null);
      if (!snapshot) {
        await save(f.snapshot, now.issues);
        return;
      }
      const before = new Map(snapshot.map((i) => [i.id, i]));
      const specs: { kind: string; target: RecordRef; payload: unknown }[] = [];
      for (const issue of now.issues) {
        const old = before.get(issue.id);
        const target = { rec: 'issue', id: issue.id };
        if (!old) {
          specs.push({ kind: 'issue.create', target, payload: { record: issue } });
          continue;
        }
        const set: Record<string, unknown> = {};
        const unset: string[] = [];
        for (const k of new Set([...Object.keys(old), ...Object.keys(issue)])) {
          if (k === 'id' || same(old[k], issue[k])) continue;
          if (issue[k] === undefined) unset.push(k);
          else set[k] = issue[k];
        }
        if (Object.keys(set).length > 0 || unset.length > 0) {
          specs.push({
            kind: 'issue.patch',
            target,
            payload: {
              ...(Object.keys(set).length > 0 ? { set } : {}),
              ...(unset.length > 0 ? { unset } : {}),
            },
          });
        }
      }
      const ids = new Set(now.issues.map((i) => i.id));
      for (const old of snapshot) {
        if (!ids.has(old.id))
          specs.push({ kind: 'issue.delete', target: { rec: 'issue', id: old.id }, payload: {} });
      }
      const ops = await appendLocal(ctx, specs);
      // this copy's writes are the latest it knows of each field
      const c = await load<Clocks>(f.clocks, {});
      for (const op of ops) stampAll(c, op);
      await save(f.clocks, c);
      await save(f.snapshot, now.issues);
    },
    async record(ctx, kind, target, payload) {
      return (await appendLocal(ctx, [{ kind, target, payload }]))[0] ?? null;
    },
  };

  function stampAll(c: Clocks, op: Op): void {
    const id = op.target.id;
    const p = op.payload as
      { set?: Record<string, unknown>; unset?: string[]; record?: IssueRecord } | undefined;
    const fields: [string, unknown][] =
      op.kind === 'issue.create'
        ? Object.entries(p?.record ?? {}).filter(([k]) => k !== 'id')
        : op.kind === 'issue.delete'
          ? [['*', null]]
          : [
              ...Object.entries(p?.set ?? {}),
              ...(p?.unset ?? []).map((k): [string, unknown] => [k, undefined]),
            ];
    const row = (c[id] ??= {});
    for (const [field, value] of fields) {
      row[field] = { hlc: op.hlc, op: op.id, chain: op.chain, seq: op.seq, act: op.act, value };
    }
  }

  const merge: MergePort = {
    async apply(ctx, incoming) {
      const f = files(ctx);
      const all = await o.store.ops(ctx.root);
      const seqOf = new Map(all.map((op) => [op.id, op.seq]));
      const knows = (op: Op, s: Stamp) =>
        op.chain === s.chain ? op.seq > s.seq : (seqOf.get(op.deps?.[s.chain] ?? '') ?? 0) >= s.seq;
      const byId = new Map(all.map((op) => [op.id, op]));
      const c = await load<Clocks>(f.clocks, {});
      const conflicts = await load<Conflict[]>(f.conflicts, []);
      const file = await readIssues(ctx.root);
      const issues = new Map(file.issues.map((i) => [i.id, i]));
      const order = file.issues.map((i) => i.id);
      const changed = new Set<string>();
      const conflict = (
        op: Op,
        field: string,
        s: Stamp,
        value: unknown,
        current: 'ours' | 'theirs',
        kind: Conflict['kind'],
      ) => {
        const id = `${op.target.id}:${field}`;
        const entry: Conflict = {
          id,
          target: { rec: 'issue', id: op.target.id },
          field,
          ours: { value: s.value ?? null, by: s.act, hlc: s.hlc, op: s.op },
          theirs: { value: value ?? null, by: op.act, hlc: op.hlc, op: op.id },
          kind,
          current,
        };
        const at = conflicts.findIndex((x) => x.id === id);
        if (at >= 0) conflicts[at] = entry;
        else conflicts.push(entry);
      };
      const sorted = [...incoming]
        .filter((op) => op.chain !== ctx.chain && op.target.rec === 'issue')
        .sort((a, b) => (a.hlc < b.hlc ? -1 : a.hlc > b.hlc ? 1 : 0));
      for (const op of sorted) {
        const id = op.target.id;
        const row = (c[id] ??= {});
        const p = op.payload as
          { set?: Record<string, unknown>; unset?: string[]; record?: IssueRecord } | undefined;
        if (op.kind === 'issue.create') {
          if (!issues.has(id) && p?.record) {
            issues.set(id, { ...p.record, id });
            order.push(id);
            stampAll(c, op);
            changed.add(id);
          }
          continue;
        }
        if (op.kind === 'issue.delete') {
          const concurrent = Object.values(row).filter(
            (s) => !knows(op, s) && s.chain !== op.chain,
          );
          if (concurrent[0] && issues.has(id)) {
            conflict(op, '*', concurrent[0], null, 'ours', 'delete-edit');
            continue;
          }
          if (issues.delete(id)) changed.add(id);
          continue;
        }
        if (op.kind !== 'issue.patch') continue;
        const issue = issues.get(id);
        if (!issue) continue;
        const fields: [string, unknown][] = [
          ...Object.entries(p?.set ?? {}),
          ...(p?.unset ?? []).map((k): [string, unknown] => [k, undefined]),
        ];
        for (const [field, value] of fields) {
          const s = row[field];
          const stamp = {
            hlc: op.hlc,
            op: op.id,
            chain: op.chain,
            seq: op.seq,
            act: op.act,
            value,
          };
          const take = () => {
            if (value === undefined) Reflect.deleteProperty(issue, field);
            else issue[field] = value;
            row[field] = stamp;
            changed.add(id);
          };
          if (!s || knows(op, s)) {
            take();
            continue;
          }
          // our write came after seeing theirs: ours stands
          const oursOp = byId.get(s.op);
          if (oursOp && knows(oursOp, stamp)) continue;
          if (same(s.value, value)) {
            if (op.hlc > s.hlc) row[field] = stamp;
            continue;
          }
          const theirsWins = op.hlc > s.hlc;
          conflict(op, field, s, value, theirsWins ? 'theirs' : 'ours', 'value');
          if (theirsWins) take();
        }
      }
      if (changed.size > 0) {
        const next = {
          ...file,
          issues: order.filter((id) => issues.has(id)).flatMap((id) => issues.get(id) ?? []),
        };
        await writeIssues(ctx.root, next);
        await save(f.snapshot, next.issues);
      }
      await save(f.clocks, c);
      await save(f.conflicts, conflicts);
      return {
        records: [...changed].map((id) => ({ rec: 'issue', id })),
        conflicts: conflicts.length,
      };
    },
    async counts(ctx) {
      const list = await load<Conflict[]>(files(ctx).conflicts, []);
      return { conflicts: list.length, quarantined: 0 };
    },
  };

  return { journal, merge };
}

/** Read the interim conflicts list (tests and the status). */
export async function interimConflicts(cacheDir: string): Promise<Conflict[]> {
  try {
    return JSON.parse(
      await readFile(join(cacheDir, 'interim-conflicts.json'), 'utf8'),
    ) as Conflict[];
  } catch {
    return [];
  }
}
